// ================================================================
// KAGE database layer — dual backend
// ----------------------------------------------------------------
// * Local dev (default):      sql.js in-memory (kage.db file optional)
// * Production (Vercel):      Turso edge SQLite — automatic whenever
//                              TURSO_DATABASE_URL is set.
//
// Both backends expose the SAME interface used by server.js:
//   db.prepare(sql).get(...)  -> row object | undefined
//   db.prepare(sql).all(...)  -> array of row objects
//   db.prepare(sql).run(...)  -> { lastInsertRowid }
//   db.get(sql, params) / db.all(sql, params)
//   db.exec(sql) / db.save()
// All methods return Promises — callers must await.
// ================================================================

const USE_TURSO = !!(process.env.TURSO_DATABASE_URL);

// ----------------------------------------------------------------
// BACKEND: local sql.js (in-memory for Vercel, file-based for dev)
// ----------------------------------------------------------------
let sqlJsDb = null;
let sqlJsReady = false;

async function initLocal() {
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    sqlJsDb = new SQL.Database();
    sqlJsDb.run('PRAGMA journal_mode=WAL');
    sqlJsReady = true;
    console.log('✅ sql.js in-memory database initialized');
  } catch (e) {
    console.error('❌ sql.js initialization failed:', e.message);
    // Create a minimal stub so the server can still start
    sqlJsDb = null;
    sqlJsReady = false;
  }
}

// Bind parameters onto a statement
function bindParams(stmt, params) {
  const clean = (params || []).filter(p => p !== undefined);
  if (clean.length === 0) return;
  if (clean.length === 1 && Array.isArray(clean[0])) stmt.bind(clean[0]);
  else if (clean.length === 1) stmt.bind([clean[0]]);
  else stmt.bind(clean);
}

function localPrepare(sql) {
  return {
    get: (...params) => {
      if (!sqlJsDb) return undefined;
      try {
        const stmt = sqlJsDb.prepare(sql);
        bindParams(stmt, params);
        let result;
        if (stmt.step()) result = stmt.getAsObject();
        stmt.free();
        return result || undefined;
      } catch (e) {
        console.error('DB get error:', e.message);
        return undefined;
      }
    },
    all: (...params) => {
      if (!sqlJsDb) return [];
      try {
        const stmt = sqlJsDb.prepare(sql);
        bindParams(stmt, params);
        const results = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
      } catch (e) {
        console.error('DB all error:', e.message);
        return [];
      }
    },
    run: (...params) => {
      if (!sqlJsDb) return { lastInsertRowid: null };
      try {
        const stmt = sqlJsDb.prepare(sql);
        bindParams(stmt, params);
        stmt.step();
        stmt.free();
        const res = sqlJsDb.exec('SELECT last_insert_rowid() as id');
        let lastId = null;
        if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
          lastId = res[0].values[0][0];
        }
        return { lastInsertRowid: lastId };
      } catch (e) {
        console.error('DB run error:', e.message);
        return { lastInsertRowid: null };
      }
    }
  };
}

// ----------------------------------------------------------------
// BACKEND: Turso (edge SQLite)
// ----------------------------------------------------------------
let tursoClient = null;

async function initTurso() {
  const { createClient } = require('@libsql/client');
  tursoClient = createClient({
    url: process.env.TURSO_DATABASE_URL,
    ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {})
  });
  console.log('✅ Turso client initialized');
}

function toArgs(params) {
  const clean = (params || []).filter(p => p !== undefined);
  if (clean.length === 1 && Array.isArray(clean[0])) return clean[0];
  return clean;
}

function tursoPrepare(sql) {
  const run = async (params) => {
    const r = await tursoClient.execute({ sql, args: toArgs(params) });
    return r;
  };
  return {
    get: async (...params) => {
      const r = await run(params);
      return r.rows && r.rows.length > 0 ? r.rows[0] : undefined;
    },
    all: async (...params) => {
      const r = await run(params);
      return r.rows || [];
    },
    run: async (...params) => {
      const r = await run(params);
      const lastId = r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null;
      return { lastInsertRowid: lastId };
    }
  };
}

// ----------------------------------------------------------------
// SCHEMA (shared by both backends)
// ----------------------------------------------------------------
async function createSchema(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      fit TEXT,
      price REAL NOT NULL,
      sale_price REAL,
      on_sale INTEGER DEFAULT 0,
      description TEXT,
      sizes TEXT DEFAULT '["S","M","L","XL","XXL"]',
      front_image TEXT,
      back_image TEXT,
      extra_images TEXT DEFAULT '[]',
      in_stock INTEGER DEFAULT 1,
      collections TEXT DEFAULT '[]',
      unit_cost REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      notes TEXT,
      payment_method TEXT NOT NULL,
      subtotal REAL NOT NULL,
      shipping REAL NOT NULL,
      total REAL NOT NULL,
      items_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ----------------------------------------------------------------
// INIT (idempotent — safe to call multiple times)
// ----------------------------------------------------------------
let initPromise = null;

function initDatabase() {
  if (!initPromise) {
    initPromise = doInit();
  }
  return initPromise;
}

async function doInit() {
  if (USE_TURSO) {
    try {
      await initTurso();
      const exec = async (sql) => { await tursoClient.execute(sql); };
      await createSchema(exec);

      // Migration: add unit_cost if missing
      const info = await tursoClient.execute('PRAGMA table_info(products)');
      const hasUnitCost = info.rows.some(r => r.name === 'unit_cost');
      if (!hasUnitCost) {
        await tursoClient.execute('ALTER TABLE products ADD COLUMN unit_cost REAL');
      }
    } catch (e) {
      console.error('❌ Turso initialization failed:', e.message);
      // Fall through to local DB
    }
  }

  if (!USE_TURSO || !tursoClient) {
    if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) {
      console.warn('⚠️  Running on Vercel without Turso — data will NOT persist.');
      console.warn('   Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel env vars.');
    }
    await initLocal();
    if (sqlJsReady && sqlJsDb) {
      try {
        const exec = async (sql) => { sqlJsDb.run(sql); };
        await createSchema(exec);
      } catch (e) {
        console.error('❌ Schema creation failed:', e.message);
      }
    }
  }
}

// ----------------------------------------------------------------
// UNIFIED INTERFACE (async)
// ----------------------------------------------------------------
async function init() {
  await initDatabase();
}

function prepare(sql) {
  return USE_TURSO && tursoClient ? tursoPrepare(sql) : localPrepare(sql);
}

async function get(sql, params) {
  const p = prepare(sql);
  return p.get(params);
}

async function all(sql, params) {
  const p = prepare(sql);
  return p.all(params);
}

async function exec(sql) {
  if (USE_TURSO && tursoClient) {
    await tursoClient.execute(sql);
  } else if (sqlJsDb) {
    sqlJsDb.run(sql);
  }
}

async function save() {
  // No-op for in-memory / Turso
}

// Kick off init immediately so the first request doesn't pay the cost.
// Catch errors so the server can still start.
init().catch(err => console.error('database init failed:', err));

module.exports = {
  init,
  prepare,
  get,
  all,
  exec,
  save,
  USE_TURSO
};

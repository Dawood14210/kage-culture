// ================================================================
// KAGE database layer — dual backend
// ----------------------------------------------------------------
// * Local dev (default):      sql.js file database (kage.db)
// * Production (Vercel):      Turso edge SQLite — automatic whenever
//                              TURSO_DATABASE_URL is set. The local
//                              file system on serverless is ephemeral,
//                              so a file DB would reset on every cold
//                              start; Turso persists forever.
//
// Both backends expose the SAME interface used by server.js:
//   db.prepare(sql).get(...)  -> row object | undefined
//   db.prepare(sql).all(...)  -> array of row objects
//   db.prepare(sql).run(...)  -> { lastInsertRowid }
//   db.get(sql, params) / db.all(sql, params)   (array-style helpers)
//   db.exec(sql) / db.save()
// All methods return Promises — callers must await.
// ================================================================

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'kage.db');

const USE_TURSO = !!(process.env.TURSO_DATABASE_URL);

// ----------------------------------------------------------------
// BACKEND: local sql.js
// ----------------------------------------------------------------
let sqlJsDb = null;

async function initLocal() {
  const SQL = await initSqlJs();
  try {
    if (fs.existsSync(DB_PATH)) {
      sqlJsDb = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      sqlJsDb = new SQL.Database();
    }
    sqlJsDb.run('PRAGMA journal_mode=WAL');
  } catch (e) {
    // If file read fails (e.g. on Vercel), start with in-memory DB
    sqlJsDb = new SQL.Database();
    console.warn('Could not load local DB file, using in-memory database:', e.message);
  }
}

function saveLocal() {
  if (sqlJsDb) {
    try {
      fs.writeFileSync(DB_PATH, Buffer.from(sqlJsDb.export()));
    } catch (e) {
      // On Vercel serverless the filesystem may not be writable —
      // silently ignore so the request can still complete.
    }
  }
}

// Bind parameters onto a statement — supports variadic (run(a, b, c)) and
// array (run([a, b, c])) styles, and tolerates callers passing no params.
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
      const stmt = sqlJsDb.prepare(sql);
      bindParams(stmt, params);
      let result;
      if (stmt.step()) result = stmt.getAsObject();
      stmt.free();
      return result || undefined;
    },
    all: (...params) => {
      const stmt = sqlJsDb.prepare(sql);
      bindParams(stmt, params);
      const results = [];
      while (stmt.step()) results.push(stmt.getAsObject());
      stmt.free();
      return results;
    },
    run: (...params) => {
      const stmt = sqlJsDb.prepare(sql);
      bindParams(stmt, params);
      stmt.step();
      stmt.free();
      // Capture rowid BEFORE db.export() — exporting resets it to 0 in sql.js
      const res = sqlJsDb.exec('SELECT last_insert_rowid() as id');
      let lastId = null;
      if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
        lastId = res[0].values[0][0];
      }
      saveLocal();
      return { lastInsertRowid: lastId };
    }
  };
}

// ----------------------------------------------------------------
// BACKEND: Turso (edge SQLite)
// ----------------------------------------------------------------
let tursoClient = null;
let turso = null;

async function initTurso() {
  const { createClient } = require('@libsql/client');
  tursoClient = createClient({
    url: process.env.TURSO_DATABASE_URL,
    ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {})
  });
}

// Normalize variadic/array params into an array of positional args
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
      // lastInsertRowid comes back as a BigInt — normalize to a number
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
    turso = {};
    await initTurso();
    const exec = async (sql) => { await tursoClient.execute(sql); };
    await createSchema(exec);

    // Migration: add unit_cost if the products table predates P&L tracking
    const info = await tursoClient.execute('PRAGMA table_info(products)');
    const hasUnitCost = info.rows.some(r => r.name === 'unit_cost');
    if (!hasUnitCost) {
      await tursoClient.execute('ALTER TABLE products ADD COLUMN unit_cost REAL');
    }
  } else {
    // On Vercel without Turso, fall back to in-memory DB
    if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) {
      console.warn('⚠️  Running on Vercel without Turso — data will NOT persist across deployments.');
      console.warn('   Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your Vercel env vars.');
    }
    await initLocal();
    const exec = async (sql) => { sqlJsDb.run(sql); saveLocal(); };
    await createSchema(exec);

    // Migration: add unit_cost (PRAGMA table_info returns rows as arrays here)
    try {
      const cols = sqlJsDb.exec('PRAGMA table_info(products)');
      const hasUnitCost = cols && cols[0] && cols[0].values
        ? cols[0].values.some(v => v[1] === 'unit_cost')
        : false;
      if (!hasUnitCost) {
        sqlJsDb.run('ALTER TABLE products ADD COLUMN unit_cost REAL');
        saveLocal();
      }
    } catch (e) {
      console.warn('Migration check skipped:', e.message);
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
  return USE_TURSO ? tursoPrepare(sql) : localPrepare(sql);
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
  if (USE_TURSO) {
    await tursoClient.execute(sql);
  } else {
    sqlJsDb.run(sql);
    saveLocal();
  }
}

async function save() {
  if (!USE_TURSO) saveLocal();
}

// Kick off init immediately so the first request doesn't pay the cost.
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

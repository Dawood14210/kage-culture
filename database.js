// ================================================================
// KAGE database layer — dual backend
// ----------------------------------------------------------------
// * Production (Vercel + Turso): Turso edge SQLite — automatic
//   whenever TURSO_DATABASE_URL is set. Data persists forever.
//
// * Vercel without Turso: Pure-JS in-memory store. Works but data
//   resets on cold starts. No WASM needed.
//
// * Local dev: sql.js with file persistence (kage.db).
//
// All backends expose the SAME interface:
//   db.prepare(sql).get(...)  -> row object | undefined
//   db.prepare(sql).all(...)  -> array of row objects
//   db.prepare(sql).run(...)  -> { lastInsertRowid }
//   db.exec(sql) / db.save()
// ================================================================

const USE_TURSO = !!(process.env.TURSO_DATABASE_URL);
const ON_VERCEL = !!process.env.VERCEL;

// ----------------------------------------------------------------
// Pure-JS in-memory store (no WASM required)
// Used when sql.js fails (e.g. WASM not found on Vercel).
// ----------------------------------------------------------------
let memStore = { admin: [], products: [], orders: [], newsletter_subscribers: [], customers: [], coming_soon_signups: [] };
let memAutoId = { admin: 0, products: 0, orders: 0, newsletter_subscribers: 0, coming_soon_signups: 0 };

function memPrepare(sql) {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  return {
    get: (...params) => {
      const args = flattenArgs(params);
      if (/^\s*SELECT\s+COUNT/i.test(upper)) {
        const table = extractTableName(upper);
        const rows = memStore[table] || [];
        const filtered = applyWhere(rows, trimmed, args);
        return { c: filtered.length };
      }
      if (/^\s*SELECT\s+.*\s+FROM\s+/i.test(upper)) {
        const table = extractTableName(upper);
        const rows = memStore[table] || [];
        const filtered = applyWhere(rows, trimmed, args);
        // Return a COPY of the row — callers (e.g. response mapping) mutate
        // the object (sizes = JSON.parse(...)); on sql.js/Turso the row is a
        // fresh object, so the copy keeps the in-memory store uncorrupted.
        return filtered.length ? { ...filtered[0] } : undefined;
      }
      if (/^\s*SELECT\s+LAST_INSERT_ROWID/i.test(upper)) {
        return { id: memAutoId._last || 0 };
      }
      if (/^\s*PRAGMA\s+table_info/i.test(upper)) {
        // Return empty for migration checks
        return { rows: [] };
      }
      return undefined;
    },
    all: (...params) => {
      const args = flattenArgs(params);
      if (/^\s*SELECT\s+/i.test(upper)) {
        const table = extractTableName(upper);
        if (!table) return [];
        const rows = memStore[table] || [];
        // Copies, not live references — see get() above.
        return applyWhere(rows, trimmed, args).map(r => ({ ...r }));
      }
      return [];
    },
    run: (...params) => {
      const args = flattenArgs(params);
      if (/^\s*INSERT\s+INTO/i.test(upper)) {
        const table = extractInsertTable(trimmed);
        const cols = extractInsertColumns(trimmed);
        const vals = extractPlaceholders(trimmed);
        const row = {};
        cols.forEach((col, i) => {
          const valIdx = vals[i];
          if (valIdx !== undefined && valIdx < args.length) {
            row[col] = args[valIdx];
          } else {
            row[col] = null;
          }
        });
        if (!memStore[table]) memStore[table] = [];
        memAutoId[table] = (memAutoId[table] || 0) + 1;
        row.id = memAutoId[table];
        memAutoId._last = row.id;
        memStore[table].push(row);
        return { lastInsertRowid: row.id };
      }
      if (/^\s*UPDATE\s+/i.test(upper)) {
        const table = extractUpdateTable(trimmed);
        const setPairs = extractSetPairs(trimmed);
        const whereClause = extractWhereClause(trimmed);
        const whereArgs = extractWhereArgs(trimmed, args, setPairs.length);
        const rows = memStore[table] || [];
        let updated = 0;
        rows.forEach(row => {
          if (matchWhere(row, whereClause, whereArgs)) {
            setPairs.forEach((pair, i) => {
              const valIdx = i;
              row[pair] = args[valIdx] !== undefined ? args[valIdx] : row[pair];
            });
            updated++;
          }
        });
        return { changes: updated };
      }
      if (/^\s*DELETE\s+FROM/i.test(upper)) {
        const table = extractDeleteTable(trimmed);
        const whereClause = extractWhereClause(trimmed);
        const whereArgs = args;
        if (memStore[table]) {
          memStore[table] = memStore[table].filter(row => !matchWhere(row, whereClause, whereArgs));
        }
        return { changes: 0 };
      }
      if (/^\s*ALTER\s+TABLE/i.test(upper)) {
        // No-op for migrations on in-memory
        return {};
      }
      if (/^\s*CREATE\s+TABLE/i.test(upper)) {
        const table = extractCreateTableName(trimmed);
        if (table && !memStore[table]) memStore[table] = [];
        return {};
      }
      return {};
    }
  };
}

// Helper: flatten nested args
function flattenArgs(params) {
  const clean = (params || []).flat().filter(p => p !== undefined);
  return clean;
}

// Extract table name from SELECT...FROM table
function extractTableName(upper) {
  const m = upper.match(/FROM\s+(\w+)/);
  return m ? m[1].toLowerCase() : null;
}

// Extract table from INSERT INTO table
function extractInsertTable(sql) {
  const m = sql.match(/INSERT\s+INTO\s+(\w+)/i);
  return m ? m[1].toLowerCase() : '';
}

// Extract columns from INSERT INTO table (col1, col2...)
function extractInsertColumns(sql) {
  const m = sql.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)/i);
  if (!m) return [];
  return m[1].split(',').map(c => c.trim().replace(/['"]/g, ''));
}

// Count ? placeholders
function extractPlaceholders(sql) {
  const m = sql.match(/\(([^)]+)\)/);
  if (!m) return [];
  const parts = m[1].split(',');
  return parts.map((_, i) => i);
}

// Extract table from UPDATE table
function extractUpdateTable(sql) {
  const m = sql.match(/UPDATE\s+(\w+)/i);
  return m ? m[1].toLowerCase() : '';
}

// Extract SET pairs
function extractSetPairs(sql) {
  const m = sql.match(/SET\s+(.+?)(?:\s+WHERE|$)/i);
  if (!m) return [];
  return m[1].split(',').map(p => p.split('=')[0].trim());
}

// Extract WHERE clause
function extractWhereClause(sql) {
  const m = sql.match(/WHERE\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Extract args for WHERE
function extractWhereArgs(sql, args, setCount) {
  return args.slice(setCount);
}

// Extract table from DELETE FROM table
function extractDeleteTable(sql) {
  const m = sql.match(/DELETE\s+FROM\s+(\w+)/i);
  return m ? m[1].toLowerCase() : '';
}

// Extract table from CREATE TABLE IF NOT EXISTS table
function extractCreateTableName(sql) {
  const m = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Apply WHERE filter
function applyWhere(rows, sql, args) {
  const where = extractWhereClause(sql);
  if (!where) return rows;
  return rows.filter(row => matchWhere(row, where, args));
}

// Match a single row against WHERE
function matchWhere(row, where, args) {
  if (!where) return true;
  // Simple equality: col = ? AND col2 = ?
  const parts = where.split(/\s+AND\s+/i);
  let argIdx = 0;
  for (const part of parts) {
    const m = part.match(/(\w+)\s*(=|!=|<|>|<=|>=|LIKE)\s*\?/i);
    if (!m) continue;
    const col = m[1].toLowerCase();
    const op = m[2];
    const val = args[argIdx++];
    const rowVal = row[col];
    switch (op) {
      case '=': if (rowVal != val) return false; break;
      case '!=': if (rowVal == val) return false; break;
      case '<': if (rowVal >= val) return false; break;
      case '>': if (rowVal <= val) return false; break;
      case '<=': if (rowVal > val) return false; break;
      case '>=': if (rowVal < val) return false; break;
      case 'LIKE': if (!String(rowVal).includes(String(val).replace(/%/g, ''))) return false; break;
    }
  }
  return true;
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
  const clean = (params || []).flat().filter(p => p !== undefined);
  return clean;
}

function tursoPrepare(sql) {
  const run = async (params) => {
    return await tursoClient.execute({ sql, args: toArgs(params) });
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
// BACKEND: sql.js (local dev only — needs WASM)
// ----------------------------------------------------------------
let sqlJsDb = null;
let sqlJsReady = false;

async function initSqlJsLocal() {
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    sqlJsDb = new SQL.Database();
    sqlJsReady = true;
    console.log('✅ sql.js in-memory database initialized');
    return true;
  } catch (e) {
    console.error('❌ sql.js initialization failed:', e.message);
    sqlJsDb = null;
    sqlJsReady = false;
    return false;
  }
}

function bindParams(stmt, params) {
  const clean = (params || []).flat().filter(p => p !== undefined);
  if (clean.length === 0) return;
  if (clean.length === 1 && Array.isArray(clean[0])) stmt.bind(clean[0]);
  else if (clean.length === 1) stmt.bind([clean[0]]);
  else stmt.bind(clean);
}

function sqlJsPrepare(sql) {
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
      } catch (e) { return undefined; }
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
      } catch (e) { return []; }
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
      } catch (e) { return { lastInsertRowid: null }; }
    }
  };
}

// ----------------------------------------------------------------
// SCHEMA
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
      stock_qty REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      order_number TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  await exec(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      city TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS coming_soon_signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ----------------------------------------------------------------
// INIT
// ----------------------------------------------------------------
let initPromise = null;
let activeBackend = 'mem'; // 'turso' | 'sqljs' | 'mem'

function initDatabase() {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit() {
  // 1. Try Turso first
  if (USE_TURSO) {
    try {
      await initTurso();
      const exec = async (sql) => { await tursoClient.execute(sql); };
      await createSchema(exec);
      const info = await tursoClient.execute('PRAGMA table_info(products)');
      const hasUnitCost = info.rows.some(r => r.name === 'unit_cost');
      if (!hasUnitCost) await tursoClient.execute('ALTER TABLE products ADD COLUMN unit_cost REAL');
      const hasStockQty = info.rows.some(r => r.name === 'stock_qty');
      if (!hasStockQty) await tursoClient.execute('ALTER TABLE products ADD COLUMN stock_qty REAL');
      const hasDrop = info.rows.some(r => r.name === 'drop');
      if (!hasDrop) await tursoClient.execute("ALTER TABLE products ADD COLUMN drop TEXT DEFAULT ''");
      activeBackend = 'turso';
      return;
    } catch (e) {
      console.error('❌ Turso init failed, falling back:', e.message);
    }
  }

  // 2. Try sql.js (local dev only — WASM needed)
  if (!ON_VERCEL) {
    const ok = await initSqlJsLocal();
    if (ok && sqlJsDb) {
      try {
        const exec = async (sql) => { sqlJsDb.run(sql); };
        await createSchema(exec);
        activeBackend = 'sqljs';
        return;
      } catch (e) {
        console.error('❌ sql.js schema failed:', e.message);
      }
    }
  }

  // 3. Fallback: pure-JS in-memory store (works everywhere, no WASM)
  if (ON_VERCEL) {
    console.warn('⚠️  Vercel without Turso — using in-memory store. Data will NOT persist.');
  } else {
    console.warn('⚠️  sql.js unavailable — using in-memory store.');
  }
  activeBackend = 'mem';
  const exec = async (sql) => { memPrepare(sql).run(); };
  await createSchema(exec);
}

// ----------------------------------------------------------------
// UNIFIED INTERFACE
// ----------------------------------------------------------------
async function init() { await initDatabase(); }

function prepare(sql) {
  if (USE_TURSO && tursoClient) return tursoPrepare(sql);
  if (activeBackend === 'sqljs' && sqlJsDb) return sqlJsPrepare(sql);
  return memPrepare(sql);
}

async function get(sql, params) { return prepare(sql).get(params); }
async function all(sql, params) { return prepare(sql).all(params); }

async function exec(sql) {
  if (USE_TURSO && tursoClient) {
    await tursoClient.execute(sql);
  } else if (activeBackend === 'sqljs' && sqlJsDb) {
    sqlJsDb.run(sql);
  } else {
    memPrepare(sql).run();
  }
}

async function save() { /* no-op */ }

// Kick off init
init().catch(err => console.error('database init failed:', err));

module.exports = { init, prepare, get, all, exec, save, USE_TURSO };

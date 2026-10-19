// ================================================================
// KAGE database layer — dual backend
// ----------------------------------------------------------------
// * Production (Vercel + Turso): Turso edge SQLite — automatic
//   whenever TURSO_DATABASE_URL is set. Data persists forever.
//
// * Vercel without Turso: BOOT FAILS LOUDLY. The pure-JS in-memory
//   fallback would silently lose every order on each cold start.
//   Set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) in production.
//
// * Local dev: sql.js IN-MEMORY database (no kage.db file — data resets
//   when the process exits; save() is a no-op on every backend).
//
// All backends expose the SAME interface:
//   db.prepare(sql).get(...)  -> row object | undefined
//   db.prepare(sql).all(...)  -> array of row objects
//   db.prepare(sql).run(...)  -> { lastInsertRowid }
//   db.exec(sql) / db.save()
// ================================================================

const fs = require('fs');
const path = require('path');

const USE_TURSO = !!(process.env.TURSO_DATABASE_URL);
const ON_VERCEL = !!process.env.VERCEL;

// Opt-in sql.js file persistence (local dev / self-hosted). Without it the
// sql.js backend stays fully in-memory (save() is a no-op) — that is the
// default, and the deployed backends (Turso) never touch this path.
const SQLJS_FILE = process.env.KAGE_DB_FILE ? path.resolve(process.env.KAGE_DB_FILE) : null;
const SQLJS_FILE_LOCK = SQLJS_FILE ? `${SQLJS_FILE}.rate-limit.lock` : null;

// ----------------------------------------------------------------
// Pure-JS in-memory store (no WASM required)
// Used when sql.js fails (e.g. WASM not found on Vercel).
// ----------------------------------------------------------------
let memStore = { admin: [], products: [], orders: [], newsletter_subscribers: [], customers: [], coming_soon_signups: [], app_settings: [], rate_limits: [] };
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
        let removed = 0;
        if (memStore[table]) {
          const before = memStore[table].length;
          memStore[table] = memStore[table].filter(row => !matchWhere(row, whereClause, whereArgs));
          removed = before - memStore[table].length;
        }
        return { changes: removed };
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
      if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(upper)) {
        // Indexes only make reads faster; the regex store has nothing to index.
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
      // rowsAffected is required by guarded UPDATEs (e.g. atomic stock decrement).
      const changes = r.rowsAffected != null ? Number(r.rowsAffected) : null;
      return { lastInsertRowid: lastId, changes };
    }
  };
}

// ----------------------------------------------------------------
// BACKEND: sql.js (local dev only — needs WASM)
// ----------------------------------------------------------------
let sqlJsDb = null;
let sqlJsReady = false;
let sqlJsModule = null;

async function initSqlJsLocal() {
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    sqlJsModule = SQL;
    sqlJsDb = new SQL.Database();
    if (SQLJS_FILE && fs.existsSync(SQLJS_FILE)) {
      try {
        sqlJsDb = new SQL.Database(fs.readFileSync(SQLJS_FILE));
        console.log('✅ sql.js database loaded from ' + SQLJS_FILE);
      } catch (e) {
        console.error('⚠️  could not load ' + SQLJS_FILE + ':', e.message, '— starting empty');
        sqlJsDb = new SQL.Database();
      }
    }
    sqlJsReady = true;
    if (!SQLJS_FILE) console.log('✅ sql.js in-memory database initialized');
    return true;
  } catch (e) {
    console.error('❌ sql.js initialization failed:', e.message);
    sqlJsDb = null;
    sqlJsReady = false;
    return false;
  }
}

// Write the sql.js database to KAGE_DB_FILE (no-op when unset). Writes are
// coalesced with a short timer so a burst (seeding 20 products, batch deletes)
// costs one file write, and save() flushes immediately. The small lock also
// serializes full sql.js snapshots with the DB-backed rate-limit writes used
// when several local server processes share KAGE_DB_FILE. Before exporting,
// merge the latest rate_limits rows from disk so a stale sql.js snapshot can
// never roll back a counter written by another process.
const FILE_LOCK_TIMEOUT_MS = 10000;
const FILE_LOCK_STALE_MS = 30000;

function acquireSqlJsFileLockSync() {
  if (!SQLJS_FILE_LOCK) return null;
  fs.mkdirSync(path.dirname(SQLJS_FILE), { recursive: true });
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(SQLJS_FILE_LOCK, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      return fd;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(SQLJS_FILE_LOCK);
        if (Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
          fs.unlinkSync(SQLJS_FILE_LOCK);
          continue;
        }
      } catch (statErr) { if (statErr.code === 'ENOENT') continue; }
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  throw new Error('Timed out waiting for the shared sql.js database lock.');
}

async function acquireSqlJsFileLock() {
  if (!SQLJS_FILE_LOCK) return async () => {};
  await fs.promises.mkdir(path.dirname(SQLJS_FILE), { recursive: true });
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  let delay = 5;
  while (Date.now() < deadline) {
    try {
      const handle = await fs.promises.open(SQLJS_FILE_LOCK, 'wx', 0o600);
      await handle.writeFile(`${process.pid} ${Date.now()}\n`);
      return async () => {
        try { await handle.close(); } catch (e) { /* already closed */ }
        try { await fs.promises.unlink(SQLJS_FILE_LOCK); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = await fs.promises.stat(SQLJS_FILE_LOCK);
        if (Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
          await fs.promises.unlink(SQLJS_FILE_LOCK).catch(e => { if (e.code !== 'ENOENT') throw e; });
          continue;
        }
      } catch (statErr) { if (statErr.code === 'ENOENT') continue; }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(100, delay * 2);
    }
  }
  throw new Error('Timed out waiting for the shared sql.js database lock.');
}

function mergeLatestRateLimitsFromFile() {
  if (!SQLJS_FILE || !sqlJsModule || !sqlJsDb || !fs.existsSync(SQLJS_FILE)) return;
  let diskDb;
  try {
    diskDb = new sqlJsModule.Database(fs.readFileSync(SQLJS_FILE));
    const result = diskDb.exec('SELECT key, count, reset_at FROM rate_limits');
    if (!result.length) return;
    sqlJsDb.run('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
    sqlJsDb.run('DELETE FROM rate_limits');
    const insert = sqlJsDb.prepare('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)');
    try {
      for (const row of result[0].values) insert.run(row);
    } finally { insert.free(); }
  } catch (e) {
    // First boot may have an older file without the new table, or sql.js may
    // already have rejected a corrupt dump and started with a fresh database.
    // This is only a best-effort merge; schema creation below has the live table.
    if (!/no such table|not a database|database disk image is malformed|file is not a database/i.test(e.message)) throw e;
  } finally {
    if (diskDb) diskDb.close();
  }
}

let persistTimer = null;
function persistSqlJs() {
  if (!SQLJS_FILE || !sqlJsDb) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushSqlJs();
  }, 250);
  if (persistTimer.unref) persistTimer.unref();
}
function flushSqlJs() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!SQLJS_FILE || !sqlJsDb) return;
  let lockFd = null;
  let tempFile = null;
  try {
    lockFd = acquireSqlJsFileLockSync();
    mergeLatestRateLimitsFromFile();
    fs.mkdirSync(path.dirname(SQLJS_FILE), { recursive: true });
    tempFile = `${SQLJS_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, Buffer.from(sqlJsDb.export()));
    fs.renameSync(tempFile, SQLJS_FILE);
  } catch (e) {
    if (tempFile) { try { fs.unlinkSync(tempFile); } catch (ignored) { /* best effort */ } }
    console.error('sql.js save failed:', e.message);
  } finally {
    if (lockFd != null) {
      try { fs.closeSync(lockFd); } catch (e) { /* best effort */ }
      try { fs.unlinkSync(SQLJS_FILE_LOCK); } catch (e) { if (e.code !== 'ENOENT') console.error('sql.js lock cleanup failed:', e.message); }
    }
  }
}
process.on('exit', flushSqlJs);

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
      if (!sqlJsDb) return { lastInsertRowid: null, changes: 0 };
      try {
        const stmt = sqlJsDb.prepare(sql);
        bindParams(stmt, params);
        stmt.step();
        stmt.free();
        const changes = sqlJsDb.getRowsModified();
        persistSqlJs(); // coalesced write when KAGE_DB_FILE is set
        const res = sqlJsDb.exec('SELECT last_insert_rowid() as id');
        let lastId = null;
        if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
          lastId = res[0].values[0][0];
        }
        return { lastInsertRowid: lastId, changes };
      } catch (e) { return { lastInsertRowid: null, changes: 0 }; }
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
      -- Legacy column from the removed themed collections. It is left in
      -- place (never dropped) so databases created by older versions keep
      -- upgrading cleanly; nothing reads or writes it any more.
      collections TEXT DEFAULT '[]',
      unit_cost REAL,
      stock_qty INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Per-size stock. A product with rows here is tracked per size and its
  // products.stock_qty is the sum of these rows (see utils/sizes.js).
  await exec(`
    CREATE TABLE IF NOT EXISTS product_size_stock (
      product_id INTEGER NOT NULL,
      size TEXT NOT NULL,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, size)
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
      viewer_token TEXT NOT NULL DEFAULT '',
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
      payment_ref TEXT DEFAULT NULL,
      payment_verified INTEGER DEFAULT 0,
      cod_confirmed INTEGER DEFAULT 0,
      subtotal REAL NOT NULL,
      shipping REAL NOT NULL,
      shipping_pending INTEGER NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      items_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      customer_id INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      unsubscribed INTEGER NOT NULL DEFAULT 0,
      unsubscribe_token TEXT,
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
      email_verified INTEGER DEFAULT 0,
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
  await exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_type TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Single-use, hashed email-verification tokens (same shape as the password
  // reset tokens above). Only the SHA-256 hash is stored.
  await exec(`
    CREATE TABLE IF NOT EXISTS customer_verification_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Shared rate-limit windows and per-account login lockouts. This is created
  // by the common schema path for fresh databases, and repeated as an explicit
  // migration on every backend below for databases created by earlier builds.
  await exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    )
  `);
}

// ----------------------------------------------------------------
// ADDITIVE COLUMN MIGRATIONS (Turso, sql.js and in-memory alike)
// ----------------------------------------------------------------
// A database created by an earlier build is missing these columns. Each ALTER
// runs on its own and is idempotent:
//
//   * "duplicate column name" — the column is already there. The ONLY error
//     ignored.
//   * anything else — logged together with the exact statement that failed and
//     re-thrown AFTER every remaining migration has been attempted, so a real
//     schema problem fails the boot loudly (with its real message) instead of
//     silently leaving the database half-migrated.
//
// Indexes that reference one of these columns are created by createIndexes()
// afterwards — never before the ALTERs.
const ADDITIVE_COLUMN_MIGRATIONS = [
  // products: unit_cost (P&L), [drop] (drop-shipping flag).
  ['products', 'unit_cost', 'REAL'],
  ['products', '[drop]', "TEXT DEFAULT ''"],
  // orders: payment review + COD confirmation + delivery-charge state, and the
  // customer link order history is matched on.
  ['orders', 'payment_ref', 'TEXT DEFAULT NULL'],
  ['orders', 'payment_verified', 'INTEGER DEFAULT 0'],
  ['orders', 'cod_confirmed', 'INTEGER DEFAULT 0'],
  ['orders', 'shipping_pending', 'INTEGER NOT NULL DEFAULT 0'],
  ['orders', 'customer_id', 'INTEGER DEFAULT NULL'],
  // customers: order history is gated on a verified email.
  ['customers', 'email_verified', 'INTEGER DEFAULT 0'],
  // reviews: per-device visibility of a reviewer's own pending review.
  ['reviews', 'viewer_token', "TEXT NOT NULL DEFAULT ''"],
  // newsletter_subscribers: one-click unsubscribe (token backfilled by a
  // one-time bootstrap step in server.js, not here).
  ['newsletter_subscribers', 'unsubscribed', 'INTEGER NOT NULL DEFAULT 0'],
  ['newsletter_subscribers', 'unsubscribe_token', 'TEXT']
];

function isDuplicateColumnError(error) {
  return /duplicate column name/i.test(String((error && error.message) || error));
}

async function addColumnIfMissing(exec, table, column, definition) {
  const sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`;
  try {
    await exec(sql);
    return true;
  } catch (error) {
    if (isDuplicateColumnError(error)) return false;
    console.error(`❌ Column migration failed: ${error.message}\n    statement: ${sql}`);
    throw new Error(`ALTER TABLE ${table} ADD COLUMN ${column} → ${error.message}`);
  }
}

async function runAdditiveColumnMigrations(exec) {
  const failures = [];
  for (const [table, column, definition] of ADDITIVE_COLUMN_MIGRATIONS) {
    try { await addColumnIfMissing(exec, table, column, definition); }
    catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(`column migration(s) failed — ${failures.join(' | ')}`);
}

// ----------------------------------------------------------------
// INDEXES (created only after the migrations above)
// ----------------------------------------------------------------
// idx_orders_customer_id references orders.customer_id, which ADDITIVE_COLUMN_
// MIGRATIONS adds to an old database. Creating it before the ALTER is what
// broke every pre-customer_id database at startup ("no such column:
// customer_id"), so every backend creates its indexes after the migrations,
// once all referenced columns are guaranteed to exist.
const BASE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email)',
  'CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number)',
  'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)',
  'CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)',
  'CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)',
  'CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_customer_verification_tokens_hash ON customer_verification_tokens(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at)'
];
const MIGRATED_COLUMN_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_unsub_token ON newsletter_subscribers(unsubscribe_token)'
];

async function createIndexes(exec) {
  for (const sql of [...BASE_INDEXES, ...MIGRATED_COLUMN_INDEXES]) await exec(sql);
}

// ----------------------------------------------------------------
// DATA MIGRATIONS (email casing + order attribution)
// ----------------------------------------------------------------
// Emails arrive from forms, so an order might be stored as "Buyer@Kage.test"
// while the account is "buyer@kage.test". Order history is matched on the
// lowercased value, so normalise existing rows once at boot.
// One-off (marker-guarded from server.js) normalisation of every email column.
// Duplicate-safe: customers and newsletter_subscribers carry a UNIQUE index on
// `email`, so blindly lowercasing a row can collide with an existing one — that
// used to make the whole UPDATE fail and leave the table mixed-case. Here the
// OLDEST row wins, references are re-pointed to it, a verified duplicate passes
// its verification on, and the extra row is removed.
async function normalizeEmailsMigration() {
  const stats = { orders: 0, customersMerged: 0, customersLowered: 0, newsletterMerged: 0, newsletterLowered: 0 };

  // orders.email has no UNIQUE constraint — a plain normalise is safe.
  try {
    const before = await prepare('SELECT COUNT(*) AS c FROM orders').get();
    await prepare('UPDATE orders SET email = LOWER(TRIM(email)) WHERE email <> LOWER(TRIM(email))').run();
    const afterMixed = await prepare("SELECT COUNT(*) AS c FROM orders WHERE email <> LOWER(TRIM(email))").get();
    stats.orders = (before && before.c ? Number(before.c) : 0) && !(afterMixed && afterMixed.c) ? 1 : 0;
  } catch (e) { console.error('normalize emails (orders) skipped:', e.message); }

  // customers: keep the oldest row per lowercased address.
  // Two passes on purpose: `email` is UNIQUE, so lowercasing the survivor while
  // a duplicate still holds that exact string would collide (and the backend
  // would silently skip the write). Merge/delete first, lowercase afterwards.
  try {
    const rows = await prepare('SELECT id, email, email_verified FROM customers ORDER BY id ASC').all();
    const kept = new Map();
    for (const row of rows) {
      const target = String(row.email == null ? '' : row.email).trim().toLowerCase();
      if (!target) continue;
      const winner = kept.get(target);
      if (!winner) { kept.set(target, row); continue; }
      // duplicate: move everything that references this row to the survivor
      await prepare('UPDATE orders SET customer_id = ? WHERE customer_id = ?').run(winner.id, row.id);
      await prepare('UPDATE customer_verification_tokens SET customer_id = ? WHERE customer_id = ?').run(winner.id, row.id);
      await prepare('UPDATE password_reset_tokens SET user_id = ? WHERE user_type = ? AND user_id = ?').run(winner.id, 'customer', row.id);
      if (Number(row.email_verified) === 1 && Number(winner.email_verified) !== 1) {
        await prepare('UPDATE customers SET email_verified = 1 WHERE id = ?').run(winner.id);
        winner.email_verified = 1;
      }
      await prepare('DELETE FROM customers WHERE id = ?').run(row.id);
      stats.customersMerged += 1;
    }
    for (const [target, winner] of kept) {
      if (String(winner.email) !== target) {
        await prepare('UPDATE customers SET email = ? WHERE id = ?').run(target, winner.id);
        stats.customersLowered += 1;
      }
    }
  } catch (e) { console.error('normalize emails (customers) skipped:', e.message); }

  // newsletter_subscribers: keep the oldest row per lowercased address (same
  // UNIQUE-column ordering as the customers pass above).
  try {
    const rows = await prepare('SELECT id, email FROM newsletter_subscribers ORDER BY id ASC').all();
    const kept = new Map();
    for (const row of rows) {
      const target = String(row.email == null ? '' : row.email).trim().toLowerCase();
      if (!target) continue;
      if (kept.has(target)) {
        await prepare('DELETE FROM newsletter_subscribers WHERE id = ?').run(row.id);
        stats.newsletterMerged += 1;
        continue;
      }
      kept.set(target, row);
    }
    for (const [target, winner] of kept) {
      if (String(winner.email) !== target) {
        await prepare('UPDATE newsletter_subscribers SET email = ? WHERE id = ?').run(target, winner.id);
        stats.newsletterLowered += 1;
      }
    }
  } catch (e) { console.error('normalize emails (newsletter) skipped:', e.message); }

  await save();
  return stats;
}

// Deprecated alias — the boot path uses the marker-guarded migration
// (server.js BOOTSTRAP_KEYS) so it runs once per database, not every boot.
async function normalizeEmails() { return normalizeEmailsMigration(); }

// Link pre-existing orders to the customer account that owns the same, now
// normalised, email — but ONLY for verified accounts. An unverified signup may
// be an attacker typing someone else's address, so it must never be handed
// that person's order history.
async function backfillOrderCustomerIds() {
  let linked = 0;
  try {
    const orders = await prepare('SELECT id, email FROM orders WHERE customer_id IS NULL').all();
    const customers = await prepare('SELECT id, email FROM customers WHERE email_verified = 1').all();
    const byEmail = new Map();
    for (const c of customers || []) {
      const key = String(c.email || '').trim().toLowerCase();
      if (key && !byEmail.has(key)) byEmail.set(key, Number(c.id));
    }
    for (const o of orders || []) {
      const key = String(o.email || '').trim().toLowerCase();
      const customerId = byEmail.get(key);
      if (!customerId) continue;
      await prepare('UPDATE orders SET customer_id = ? WHERE id = ?').run(customerId, o.id);
      linked++;
    }
  } catch (e) { /* best effort — the endpoint still matches by email */ }
  if (linked) console.log(`✅ Linked ${linked} existing order(s) to verified customers`);
  return linked;
}

// ----------------------------------------------------------------
// INIT
// ----------------------------------------------------------------
let initPromise = null;
let activeBackend = 'mem'; // 'turso' | 'sqljs' | 'mem'

// The in-flight/fulfilled init promise is cached so concurrent cold-start
// requests share one attempt — but a FAILED attempt is never cached: the cache
// is cleared in the rejection handler so the next call really retries instead
// of replaying the same rejection (and a half-initialised module is never
// handed out as if it were ready).
function initDatabase() {
  if (!initPromise) {
    initPromise = doInit().catch((err) => {
      initPromise = null;
      throw err;
    });
    // Attached here so a rejection can never surface as an unhandled rejection.
    initPromise.catch(() => {});
  }
  return initPromise;
}

async function doInit() {
  // Skip if already initialized (warm Vercel invocations). `_initialized` is
  // only ever set AFTER a backend finished schema + migrations, so a partial
  // failure leaves it false and the retry does the full job.
  if (module.exports._initialized) return;

  // The real error from the last backend attempt. It is carried into the
  // thrown message on Vercel — a SQL failure must never be reported as
  // "could not be reached", which sent the original incident down the wrong
  // path (the database was reachable; the schema was wrong).
  let lastInitError = null;

  // 1. Try Turso first
  if (USE_TURSO) {
    try {
      await initTurso();
      const exec = async (sql) => { await tursoClient.execute(sql); };
      await createSchema(exec);
      // Additive column migrations BEFORE the indexes that reference them —
      // an existing database created before customer_id/email_verified/
      // viewer_token has these tables but not these columns yet.
      await runAdditiveColumnMigrations(exec);
      await createIndexes(exec);
      activeBackend = 'turso';
      await backfillOrderCustomerIds();
      module.exports._initialized = true;
      return;
    } catch (error) {
      lastInitError = error;
      console.error('❌ Turso init failed:', error && error.message ? error.message : error);
    }
  }

  // 2. Try sql.js (local dev only — WASM needed)
  if (!ON_VERCEL) {
    const ok = await initSqlJsLocal();
    if (ok && sqlJsDb) {
      try {
        const exec = async (sql) => { sqlJsDb.run(sql); };
        await createSchema(exec);
        // Same migrations as every other backend: a persisted sql.js dump can
        // predate a column just like a Turso database can.
        await runAdditiveColumnMigrations(exec);
        await createIndexes(exec);
        activeBackend = 'sqljs';
        await backfillOrderCustomerIds();
        // Persist fresh schema/migrations before another process opens the same
        // KAGE_DB_FILE and its SQLite-backed rate-limit client.
        if (SQLJS_FILE) flushSqlJs();
        module.exports._initialized = true;
        return;
      } catch (error) {
        lastInitError = error;
        console.error('❌ sql.js schema failed:', error && error.message ? error.message : error);
      }
    }
  }

  // 3. Fail loudly rather than silently lose data.
  //
  // On Vercel the pure-JS in-memory store resets on every cold start AND its
  // regex "SQL" shim mangles queries (GROUP BY / ORDER BY / multi-arg UPDATE
  // WHEREs; DELETE always reports 0 changes) — orders, stats and clan
  // logic would all quietly misbehave. That is worse than a visible outage.
  if (ON_VERCEL) {
    // The public response body stays generic (see server.js#sendUnavailable);
    // this message is the LOG and the retry cause, so it carries the backend's
    // real error verbatim when there is one.
    // The retry cache is cleared by initDatabase() on every rejection.
    if (USE_TURSO) {
      throw new Error(`FATAL: Turso is configured (TURSO_DATABASE_URL) but the database failed to initialize — ${describeInitFailure(lastInitError)} The in-memory fallback would silently lose all orders, so the request is refused until the database is usable again.`);
    }
    throw new Error('FATAL: TURSO_DATABASE_URL is not set on Vercel. The in-memory fallback would silently lose all orders and corrupt queries. Configure Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) before deploying.');
  }
  console.warn('⚠️  sql.js unavailable — using in-memory store (local dev only; data resets on exit).');
  activeBackend = 'mem';
  // createSchema + migrations are no-ops on the regex shim (ALTER is a no-op
  // there), but keeping the same call order means every backend follows the
  // same path.
  const exec = async (sql) => { memPrepare(sql).run(); };
  await createSchema(exec);
  await runAdditiveColumnMigrations(exec);
  await createIndexes(exec);
  module.exports._initialized = true;
}

// Shape the real backend error for the boot-failure message. Nothing is
// swallowed: a connection problem and a SQL/schema problem read differently so
// the log (and the retry cause) match what actually happened. A SQL error is
// NEVER summarised as "could not be reached" — that is what made the
// pre-customer_id incident so hard to diagnose.
function describeInitFailure(error) {
  if (!error) return 'no backend error was captured.';
  const message = String(error.message || error);
  const cause = error.cause && error.cause.message ? String(error.cause.message) : null;
  const detail = cause && !message.includes(cause) ? `${message} (${cause})` : message;
  return isConnectionFailureMessage(detail) ? `the database could not be reached (${detail})` : detail;
}

// Socket/DNS-level failures are the only ones where "could not be reached" is
// an accurate summary; everything else is a database error and is reported as
// such.
function isConnectionFailureMessage(message) {
  return /fetch failed|econnrefused|econnreset|enotfound|etimedout|eai_again|socket hang up|connection (?:refused|closed|reset)|network|dns/i.test(String(message));
}

// ----------------------------------------------------------------
// APP SETTINGS — one-time bootstrap bookkeeping
// ----------------------------------------------------------------
// Marks like seed_products_v1 live in the DATABASE, not in the process, so a
// cold start (or a redeploy, or a different instance) never re-runs a step that
// already happened. Only ever written after the step succeeded.
async function getSetting(key) {
  try {
    const row = await prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value) : null;
  } catch (e) { return null; }
}

async function setSetting(key, value) {
  const existing = await getSetting(key);
  if (existing === null) {
    await prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, String(value));
  } else {
    await prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(String(value), key);
  }
  await save();
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
    persistSqlJs();
  } else {
    memPrepare(sql).run();
  }
}

// Persist the database where the backend supports it (sql.js + KAGE_DB_FILE);
// Turso and the in-memory store are always already durable/ephemeral.
async function save() { flushSqlJs(); }

// ----------------------------------------------------------------
// SHARED RATE LIMITS + LOGIN LOCKOUTS
// ----------------------------------------------------------------
// The single UPSERT is the serialization point for concurrent requests. The
// optional threshold argument is used only by account lockouts: when the
// threshold is reached, reset_at is moved to 15 minutes from that failure so
// the lock lasts the full duration (not merely the remainder of the count
// window). RETURNING makes the increment/result atomic on SQLite/Turso; the
// fallback SELECT is for older compatible SQLite builds.
const RATE_LIMIT_INCREMENT_SQL = `
  INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
  ON CONFLICT(key) DO UPDATE SET
    count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
    reset_at = CASE
      WHEN rate_limits.reset_at <= ? THEN excluded.reset_at
      WHEN ? > 0 AND rate_limits.count + 1 >= ? THEN excluded.reset_at
      ELSE rate_limits.reset_at
    END
  RETURNING count, reset_at
`;

function normalizedRateLimitRow(row) {
  if (!row) return undefined;
  const count = Number(row.count);
  const resetAt = Number(row.reset_at);
  if (!Number.isFinite(count) || !Number.isFinite(resetAt)) return undefined;
  return { count, reset_at: resetAt };
}

function sqlJsQueryOne(database, sql, args = []) {
  const stmt = database.prepare(sql);
  try {
    if (args.length) stmt.bind(args);
    return stmt.step() ? stmt.getAsObject() : undefined;
  } finally { stmt.free(); }
}

function sqlJsRunStrict(database, sql, args = []) {
  const stmt = database.prepare(sql);
  try {
    if (args.length) stmt.bind(args);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally { stmt.free(); }
}

async function withSqlJsFileRateLimitClient(fn) {
  const releaseLock = await acquireSqlJsFileLock();
  let client = null;
  try {
    const { createClient } = require('@libsql/client');
    // KAGE_DB_FILE is an ordinary SQLite file. libsql's local-file client uses
    // SQLite's process-safe transactions, unlike separately loaded sql.js
    // in-memory copies, so server processes on different ports share counters.
    client = createClient({ url: `file:${SQLJS_FILE}` });
    await client.execute('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
    return await fn(client);
  } finally {
    if (client) { try { client.close(); } catch (e) { /* best effort */ } }
    await releaseLock();
  }
}

async function maybeDeleteExpiredRateLimits(execute) {
  // Bound table growth without scanning it on every request.
  if (Math.random() >= 0.01) return;
  try { await execute('DELETE FROM rate_limits WHERE reset_at <= ?', [Date.now()]); }
  catch (e) { console.warn('⚠️  rate-limit expired-row cleanup failed:', e.message); }
}

async function incrementRateLimit(key, windowMs, lockThreshold = 0) {
  await initDatabase();
  if (typeof key !== 'string' || !key) throw new TypeError('Rate-limit key must be a non-empty string.');
  const duration = Math.max(1, Math.ceil(Number(windowMs) || 60000));
  const threshold = Math.max(0, Math.floor(Number(lockThreshold) || 0));
  const now = Date.now();
  const args = [key, now + duration, now, now, threshold, threshold];

  const readUpsertResult = async (execute) => {
    const result = await execute(RATE_LIMIT_INCREMENT_SQL, args);
    let row = result && result.rows && result.rows.length ? result.rows[0] : undefined;
    if (!row) {
      const selected = await execute('SELECT count, reset_at FROM rate_limits WHERE key = ?', [key]);
      row = selected && selected.rows && selected.rows.length ? selected.rows[0] : undefined;
    }
    const normalized = normalizedRateLimitRow(row);
    if (!normalized) throw new Error('Rate-limit database did not return the incremented counter.');
    await maybeDeleteExpiredRateLimits(execute);
    return normalized;
  };

  if (USE_TURSO && tursoClient) {
    return readUpsertResult((sql, executeArgs) => tursoClient.execute({ sql, args: executeArgs }));
  }

  if (activeBackend === 'sqljs' && sqlJsDb && SQLJS_FILE) {
    return withSqlJsFileRateLimitClient(async (client) => readUpsertResult((sql, executeArgs) => client.execute({ sql, args: executeArgs })));
  }

  if (activeBackend === 'sqljs' && sqlJsDb) {
    sqlJsDb.run('BEGIN IMMEDIATE');
    try {
      const rows = sqlJsRunStrict(sqlJsDb, RATE_LIMIT_INCREMENT_SQL, args);
      let row = rows[0];
      if (!row) row = sqlJsQueryOne(sqlJsDb, 'SELECT count, reset_at FROM rate_limits WHERE key = ?', [key]);
      const normalized = normalizedRateLimitRow(row);
      if (!normalized) throw new Error('Rate-limit database did not return the incremented counter.');
      if (Math.random() < 0.01) {
        try { sqlJsRunStrict(sqlJsDb, 'DELETE FROM rate_limits WHERE reset_at <= ?', [Date.now()]); }
        catch (e) { console.warn('⚠️  rate-limit expired-row cleanup failed:', e.message); }
      }
      sqlJsDb.run('COMMIT');
      persistSqlJs();
      return normalized;
    } catch (e) {
      try { sqlJsDb.run('ROLLBACK'); } catch (ignored) { /* no active transaction */ }
      throw e;
    }
  }

  // The pure-JS fallback has no SQL engine. Its synchronous mutation is atomic
  // within the process and mirrors the SQLite UPSERT's fixed-window semantics.
  const rows = memStore.rate_limits || (memStore.rate_limits = []);
  let row = rows.find(item => item.key === key);
  if (!row || Number(row.reset_at) <= now) {
    if (!row) { row = { key, count: 1, reset_at: now + duration }; rows.push(row); }
    else { row.count = 1; row.reset_at = now + duration; }
  } else {
    row.count = Number(row.count) + 1;
    if (threshold && row.count >= threshold) row.reset_at = now + duration;
  }
  if (Math.random() < 0.01) memStore.rate_limits = rows.filter(item => Number(item.reset_at) > now);
  return normalizedRateLimitRow(row);
}

async function getRateLimit(key) {
  await initDatabase();
  if (USE_TURSO && tursoClient) {
    const result = await tursoClient.execute({ sql: 'SELECT count, reset_at FROM rate_limits WHERE key = ?', args: [key] });
    return normalizedRateLimitRow(result.rows && result.rows[0]);
  }
  if (activeBackend === 'sqljs' && sqlJsDb && SQLJS_FILE) {
    return withSqlJsFileRateLimitClient(async client => {
      const result = await client.execute({ sql: 'SELECT count, reset_at FROM rate_limits WHERE key = ?', args: [key] });
      return normalizedRateLimitRow(result.rows && result.rows[0]);
    });
  }
  if (activeBackend === 'sqljs' && sqlJsDb) {
    return normalizedRateLimitRow(sqlJsQueryOne(sqlJsDb, 'SELECT count, reset_at FROM rate_limits WHERE key = ?', [key]));
  }
  const row = (memStore.rate_limits || []).find(item => item.key === key);
  return normalizedRateLimitRow(row);
}

async function decrementRateLimit(key) {
  await initDatabase();
  const sql = 'UPDATE rate_limits SET count = MAX(count - 1, 0) WHERE key = ?';
  if (USE_TURSO && tursoClient) return tursoClient.execute({ sql, args: [key] });
  if (activeBackend === 'sqljs' && sqlJsDb && SQLJS_FILE) {
    return withSqlJsFileRateLimitClient(client => client.execute({ sql, args: [key] }));
  }
  if (activeBackend === 'sqljs' && sqlJsDb) {
    sqlJsDb.run('BEGIN IMMEDIATE');
    try { sqlJsRunStrict(sqlJsDb, sql, [key]); sqlJsDb.run('COMMIT'); persistSqlJs(); }
    catch (e) { try { sqlJsDb.run('ROLLBACK'); } catch (ignored) {} throw e; }
    return;
  }
  const row = (memStore.rate_limits || []).find(item => item.key === key);
  if (row) row.count = Math.max(0, Number(row.count) - 1);
}

async function resetRateLimit(key) {
  await initDatabase();
  const sql = 'DELETE FROM rate_limits WHERE key = ?';
  if (USE_TURSO && tursoClient) return tursoClient.execute({ sql, args: [key] });
  if (activeBackend === 'sqljs' && sqlJsDb && SQLJS_FILE) {
    return withSqlJsFileRateLimitClient(client => client.execute({ sql, args: [key] }));
  }
  if (activeBackend === 'sqljs' && sqlJsDb) {
    sqlJsRunStrict(sqlJsDb, sql, [key]);
    persistSqlJs();
    return;
  }
  memStore.rate_limits = (memStore.rate_limits || []).filter(item => item.key !== key);
}

async function resetRateLimits(prefix) {
  await initDatabase();
  const sql = 'DELETE FROM rate_limits WHERE key LIKE ?';
  const pattern = `${String(prefix || '').replace(/[\\%_]/g, '\\$&')}%`;
  if (USE_TURSO && tursoClient) return tursoClient.execute({ sql, args: [pattern] });
  if (activeBackend === 'sqljs' && sqlJsDb && SQLJS_FILE) {
    return withSqlJsFileRateLimitClient(client => client.execute({ sql, args: [pattern] }));
  }
  if (activeBackend === 'sqljs' && sqlJsDb) {
    sqlJsRunStrict(sqlJsDb, sql, [pattern]);
    persistSqlJs();
    return;
  }
  const literalPrefix = String(prefix || '');
  memStore.rate_limits = (memStore.rate_limits || []).filter(item => !String(item.key).startsWith(literalPrefix));
}

module.exports = { init, prepare, get, all, exec, save, getSetting, setSetting, USE_TURSO, normalizeEmails, normalizeEmailsMigration, backfillOrderCustomerIds, incrementRateLimit, getRateLimit, decrementRateLimit, resetRateLimit, resetRateLimits, get activeBackend() { return activeBackend; } };

// Expose a flag so server.js can skip re-init. It is set by doInit() only after
// a backend finished schema + migrations (never optimistically up front).
module.exports._initialized = false;

// Kick off init eagerly (fast — just connects + creates schema). A failure is
// logged, the cache is cleared by initDatabase(), and the next caller retries.
init().catch(err => console.error('database init failed:', err.message));

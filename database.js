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

// ----------------------------------------------------------------
// Pure-JS in-memory store (no WASM required)
// Used when sql.js fails (e.g. WASM not found on Vercel).
// ----------------------------------------------------------------
let memStore = { admin: [], products: [], orders: [], newsletter_subscribers: [], customers: [], coming_soon_signups: [], app_settings: [] };
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

async function initSqlJsLocal() {
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
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
// costs one file write, and save() flushes immediately.
let persistTimer = null;
function persistSqlJs() {
  if (!SQLJS_FILE || !sqlJsDb) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { fs.writeFileSync(SQLJS_FILE, Buffer.from(sqlJsDb.export())); }
    catch (e) { console.error('sql.js save failed:', e.message); }
  }, 250);
  if (persistTimer.unref) persistTimer.unref();
}
function flushSqlJs() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!SQLJS_FILE || !sqlJsDb) return;
  try { fs.writeFileSync(SQLJS_FILE, Buffer.from(sqlJsDb.export())); }
  catch (e) { console.error('sql.js save failed:', e.message); }
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
  // --- Performance indexes ---
  await exec('CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email)');
  await exec('CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number)');
  await exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
  await exec('CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)');
  await exec('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)');
  await exec('CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)');
  await exec('CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash)');
  await exec('CREATE INDEX IF NOT EXISTS idx_customer_verification_tokens_hash ON customer_verification_tokens(token_hash)');
}

// ----------------------------------------------------------------
// DATA MIGRATIONS (email casing + order attribution)
// ----------------------------------------------------------------
// sql.js always starts from the schema above, but an imported/persisted dump
// could predate a column — keep the same guards as the Turso path.
function ensureSqlJsColumns() {
  if (!sqlJsDb) return;
  const columns = (table) => {
    try {
      const res = sqlJsDb.exec(`PRAGMA table_info(${table})`);
      return res && res[0] ? res[0].values.map(v => String(v[1])) : [];
    } catch (e) { return []; }
  };
  const orders = columns('orders');
  if (orders.length && !orders.includes('customer_id')) sqlJsDb.run('ALTER TABLE orders ADD COLUMN customer_id INTEGER DEFAULT NULL');
  const customers = columns('customers');
  if (customers.length && !customers.includes('email_verified')) sqlJsDb.run('ALTER TABLE customers ADD COLUMN email_verified INTEGER DEFAULT 0');
  try {
    sqlJsDb.run('CREATE TABLE IF NOT EXISTS customer_verification_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, token_hash TEXT NOT NULL, expires_at DATETIME NOT NULL, used INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  } catch (e) { /* schema already created it */ }
  try {
    sqlJsDb.run('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  } catch (e) { /* schema already created it */ }
}
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

  // 1. Try Turso first
  if (USE_TURSO) {
    try {
      await initTurso();
      const exec = async (sql) => { await tursoClient.execute(sql); };
      await createSchema(exec);
      // Products migrations
      const info = await tursoClient.execute('PRAGMA table_info(products)');
      const hasUnitCost = info.rows.some(r => r.name === 'unit_cost');
      if (!hasUnitCost) await tursoClient.execute('ALTER TABLE products ADD COLUMN unit_cost REAL');
      const hasDrop = info.rows.some(r => r.name === 'drop');
      if (!hasDrop) await tursoClient.execute("ALTER TABLE products ADD COLUMN [drop] TEXT DEFAULT ''");
      // Orders migrations
      const orderInfo = await tursoClient.execute('PRAGMA table_info(orders)');
      const hasPayRef = orderInfo.rows.some(r => r.name === 'payment_ref');
      if (!hasPayRef) await tursoClient.execute('ALTER TABLE orders ADD COLUMN payment_ref TEXT DEFAULT NULL');
      const hasPayVerified = orderInfo.rows.some(r => r.name === 'payment_verified');
      if (!hasPayVerified) await tursoClient.execute('ALTER TABLE orders ADD COLUMN payment_verified INTEGER DEFAULT 0');
      const hasCodConfirmed = orderInfo.rows.some(r => r.name === 'cod_confirmed');
      if (!hasCodConfirmed) await tursoClient.execute('ALTER TABLE orders ADD COLUMN cod_confirmed INTEGER DEFAULT 0');
      const hasShippingPending = orderInfo.rows.some(r => r.name === 'shipping_pending');
      if (!hasShippingPending) await tursoClient.execute('ALTER TABLE orders ADD COLUMN shipping_pending INTEGER NOT NULL DEFAULT 0');
      // customer_id attributes an order to a signed-in customer; the order
      // history endpoint matches on it (plus a verified email fallback).
      const hasCustomerId = orderInfo.rows.some(r => r.name === 'customer_id');
      if (!hasCustomerId) await tursoClient.execute('ALTER TABLE orders ADD COLUMN customer_id INTEGER DEFAULT NULL');
      // Customer migrations — email_verified gates order history.
      const customerInfo = await tursoClient.execute('PRAGMA table_info(customers)');
      const hasEmailVerified = customerInfo.rows.some(r => r.name === 'email_verified');
      if (!hasEmailVerified) await tursoClient.execute('ALTER TABLE customers ADD COLUMN email_verified INTEGER DEFAULT 0');
      // Reviews migrations — viewer_token lets a reviewer see their own
      // pending review on their device before moderation (routes/reviews.js).
      const reviewInfo = await tursoClient.execute('PRAGMA table_info(reviews)');
      const hasViewerToken = reviewInfo.rows.some(r => r.name === 'viewer_token');
      if (!hasViewerToken) await tursoClient.execute("ALTER TABLE reviews ADD COLUMN viewer_token TEXT NOT NULL DEFAULT ''");
      // Create indexes
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash)');
      await tursoClient.execute('CREATE INDEX IF NOT EXISTS idx_customer_verification_tokens_hash ON customer_verification_tokens(token_hash)');
      activeBackend = 'turso';
      await backfillOrderCustomerIds();
      module.exports._initialized = true;
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
        ensureSqlJsColumns();
        activeBackend = 'sqljs';
        await backfillOrderCustomerIds();
        module.exports._initialized = true;
        return;
      } catch (e) {
        console.error('❌ sql.js schema failed:', e.message);
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
    // The retry cache is cleared by initDatabase() on every rejection.
    throw new Error(USE_TURSO
      ? 'FATAL: Turso is configured (TURSO_DATABASE_URL) but could not be reached. The in-memory fallback would silently lose all orders, so the request is refused until Turso answers again.'
      : 'FATAL: TURSO_DATABASE_URL is not set on Vercel. The in-memory fallback would silently lose all orders and corrupt queries. Configure Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) before deploying.');
  }
  console.warn('⚠️  sql.js unavailable — using in-memory store (local dev only; data resets on exit).');
  activeBackend = 'mem';
  const exec = async (sql) => { memPrepare(sql).run(); };
  await createSchema(exec);
  module.exports._initialized = true;
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

module.exports = { init, prepare, get, all, exec, save, getSetting, setSetting, USE_TURSO, normalizeEmails, normalizeEmailsMigration, backfillOrderCustomerIds, get activeBackend() { return activeBackend; } };

// Expose a flag so server.js can skip re-init. It is set by doInit() only after
// a backend finished schema + migrations (never optimistically up front).
module.exports._initialized = false;

// Kick off init eagerly (fast — just connects + creates schema). A failure is
// logged, the cache is cleared by initDatabase(), and the next caller retries.
init().catch(err => console.error('database init failed:', err.message));

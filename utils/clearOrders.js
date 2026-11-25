// ================================================================
// KAGE Culture — guarded, one-time-by-choice order wipe
// ----------------------------------------------------------------
// This module NEVER runs on boot, migration, seed or any automatic path.
// Both entry points (CLI + admin Settings) call clearAllOrders() with an
// exact phrase; nothing else can delete the order table.
//
// Before a single row is removed it writes TWO backups to disk (CSV with
// csvCell's spreadsheet-formula shielding + JSON with raw items_json). If
// either backup fails, the function throws and the database is untouched.
// ================================================================
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const productShape = require('./productShape');
const { adjustLineStock } = require('./orderStock');
const { ordersToCsv } = require('./ordersCsv');

const CLEAR_PHRASE = 'DELETE ALL ORDERS';
const AUDIT_KEY = 'orders_cleared_v1';

function backupDir() {
  return path.resolve(process.env.ORDER_BACKUP_DIR || path.join(process.cwd(), 'backups', 'orders'));
}

function parseItems(order) {
  try { const parsed = JSON.parse(order.items_json || '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch (e) { return []; }
}

// Writes with `wx` so an existing file is never silently overwritten, and
// verifies both files are present and non-empty before returning their paths.
function writeBackups(orders, source, actor) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const token = crypto.randomBytes(5).toString('hex');
  const base = `orders-${stamp}-${token}`;
  const jsonPath = path.join(dir, base + '.json');
  const csvPath = path.join(dir, base + '.csv');
  const payload = {
    exported_at: new Date().toISOString(),
    source: String(source || 'unknown'),
    actor: actor == null ? null : String(actor),
    count: orders.length,
    // Raw rows: items_json is deliberately preserved verbatim so a restore
    // does not have to trust a re-serialised copy.
    orders
  };
  const csv = ordersToCsv(orders);
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(csvPath, csv, { encoding: 'utf8', flag: 'wx' });
    for (const file of [jsonPath, csvPath]) {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) throw new Error(`backup file is empty: ${file}`);
    }
  } catch (err) {
    const error = new Error(`Backup could not be written; no orders were deleted. ${err.message}`);
    error.code = 'BACKUP_FAILED';
    throw error;
  }
  return { csv: csvPath, json: jsonPath };
}

// Turso/SQLite can wrap the stock writes and the DELETE in one transaction;
// the in-memory and sql.js adapters exposed by database.js have no portable
// transaction method, so there the single DELETE is still atomic on its own.
async function inTransaction(db, job) {
  if (!db.USE_TURSO || typeof db.exec !== 'function') return job();
  await db.exec('BEGIN IMMEDIATE');
  try {
    const result = await job();
    await db.exec('COMMIT');
    return result;
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch (rollbackErr) { console.error('[orders_cleared] rollback failed:', rollbackErr.message); }
    throw err;
  }
}

/**
 * Clear every order, restoring stock on active orders first.
 * @param db shared database module
 * @param options.phrase must be exactly "DELETE ALL ORDERS"
 * @param options.dryRun preview only: no backup, no writes
 * @param options.source 'cli' | 'admin' — recorded in the audit entry
 * @param options.actor admin id/email for the audit entry
 */
async function clearAllOrders(db, options = {}) {
  if (String(options.phrase) !== CLEAR_PHRASE) {
    const error = new Error('Confirmation phrase must be exactly "DELETE ALL ORDERS".');
    error.code = 'INVALID_PHRASE';
    throw error;
  }
  const orders = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
  const active = orders.filter(o => String(o.status || '').toLowerCase() !== 'cancelled');
  const restorableLines = active.reduce((sum, o) => sum + parseItems(o).length, 0);
  const preview = {
    count: orders.length,
    cancelled: orders.length - active.length,
    restorableLines,
    restoredOrders: active.length,
    dryRun: !!options.dryRun
  };
  if (options.dryRun) return { ...preview, backups: null, audit: null };

  // Backup first, outside the transaction: file IO cannot be rolled back.
  const backups = writeBackups(orders, options.source, options.actor);
  let restoredLines = 0;
  await inTransaction(db, async () => {
    for (const order of active) {
      for (const line of parseItems(order)) {
        await adjustLineStock(db, line, +1);
        restoredLines++;
      }
    }
    // One statement: cancelled orders have already had their stock returned
    // when they were cancelled, so they contribute nothing here.
    await db.prepare('DELETE FROM orders').run();
  });
  await db.save();
  productShape.invalidateProductAggregates();

  const audit = {
    at: new Date().toISOString(),
    count: orders.length,
    restoredOrders: active.length,
    restoredLines,
    source: String(options.source || 'unknown'),
    actor: options.actor == null ? null : String(options.actor),
    backups
  };
  await db.setSetting(AUDIT_KEY, JSON.stringify(audit));
  console.info('[orders_cleared]', JSON.stringify({ ...audit, backups: Object.fromEntries(Object.entries(backups).map(([k, v]) => [k, path.basename(v)])) }));
  return { ...preview, restoredLines, backups, audit };
}

module.exports = { clearAllOrders, CLEAR_PHRASE, AUDIT_KEY, backupDir };

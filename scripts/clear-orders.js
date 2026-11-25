#!/usr/bin/env node
// ================================================================
// KAGE Culture — deliberate, one-shot order wipe (local / self-hosted)
// ================================================================
// NEVER called on boot, migration, seed or by any automated job. You must
// pass BOTH switches and the exact phrase:
//
//   npm run clear-orders -- --yes --phrase "DELETE ALL ORDERS"
//
// Preview without writing anything:
//
//   npm run clear-orders -- --yes --phrase "DELETE ALL ORDERS" --dry-run
//
// On production an extra opt-in is required so an accidental shell-history
// replay cannot wipe live data:
//
//   KAGE_CLEAR_ORDERS_PRODUCTION=1 npm run clear-orders -- --yes --phrase "DELETE ALL ORDERS"
// ================================================================
const path = require('node:path');
const db = require('../database');
const { clearAllOrders, CLEAR_PHRASE, backupDir } = require('../utils/clearOrders');

function usage(message) {
  if (message) console.error(`Refusing to clear orders: ${message}\n`);
  console.error('Usage: npm run clear-orders -- --yes --phrase "DELETE ALL ORDERS" [--dry-run]');
  process.exitCode = message ? 1 : 0;
}

(async () => {
  const args = process.argv.slice(2);
  const has = (flag) => args.includes(flag);
  const flagValue = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  if (!has('--yes')) return usage('missing --yes');
  if (flagValue('--phrase') !== CLEAR_PHRASE) return usage(`--phrase must be exactly "${CLEAR_PHRASE}"`);
  if ((process.env.NODE_ENV === 'production' || process.env.VERCEL) && process.env.KAGE_CLEAR_ORDERS_PRODUCTION !== '1') {
    return usage('production needs KAGE_CLEAR_ORDERS_PRODUCTION=1 as an extra deliberate opt-in');
  }
  const dryRun = has('--dry-run');
  if (!process.env.KAGE_DB_FILE && !process.env.TURSO_DATABASE_URL) {
    console.warn('⚠️  No KAGE_DB_FILE / TURSO_DATABASE_URL: this is an in-memory database; the wipe will not persist after exit.');
  }
  await db.init();
  const result = await clearAllOrders(db, { phrase: CLEAR_PHRASE, dryRun, source: 'cli', actor: 'cli' });
  if (dryRun) {
    console.log(`DRY RUN — ${result.count} order(s) would be cleared; ${result.restoredOrders} active order(s) would return ${result.restorableLines} line(s) to stock. Nothing was written.`);
    return;
  }
  console.log(`Cleared ${result.count} order(s). Returned ${result.restoredLines} line(s) to stock on ${result.restoredOrders} active order(s).`);
  console.log(`Backups (keep these!):\n  ${path.resolve(result.backups.csv)}\n  ${path.resolve(result.backups.json)}`);
  console.log(`Backup directory: ${backupDir()}`);
})().catch((err) => {
  console.error(`Clear orders failed: ${err.message}`);
  process.exitCode = 1;
});

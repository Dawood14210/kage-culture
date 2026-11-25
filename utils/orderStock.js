// ================================================================
// KAGE Culture — shared order-line stock helpers
// ----------------------------------------------------------------
// Used by status changes (cancel / reactivate) and by the guarded
// clear-orders tool. Keeping one implementation means a cancelled order
// always returns exactly the same units, however it was closed.
// ================================================================
const sizeStock = require('./sizes');

// Put back (direction +1) or take out (direction -1) one order line's units.
// Per-size lines adjust that size's row; legacy lines adjust the shared pool.
// Removing floors at 0 so concurrent sales can never drive stock negative.
async function adjustLineStock(db, it, direction) {
  const qty = Number(it.qty) || 1;
  const p = await db.prepare('SELECT id, stock_qty FROM products WHERE id = ?').get(it.id);
  if (!p) return;
  const perSize = await sizeStock.loadSizeStock(db, p.id);
  if (perSize) {
    if (!Object.prototype.hasOwnProperty.call(perSize, it.size)) return;
    const next = Math.max(0, (perSize[it.size] || 0) + direction * qty);
    await db.prepare('UPDATE product_size_stock SET stock_qty = ? WHERE product_id = ? AND size = ?').run(next, p.id, it.size);
    await sizeStock.syncProductStock(db, p.id);
    if (direction > 0) await db.prepare('UPDATE products SET in_stock = 1 WHERE id = ?').run(p.id);
    return;
  }
  if (p.stock_qty == null) return;
  const newQty = direction > 0 ? Number(p.stock_qty) + qty : Math.max(0, Number(p.stock_qty) - qty);
  await db.prepare('UPDATE products SET stock_qty = ?, in_stock = ? WHERE id = ?').run(newQty, direction > 0 || newQty > 0 ? 1 : 0, p.id);
}

// Which lines cannot be fully re-taken? Returns [] when every line fits.
// A missing product or size row counts as a shortage (nothing to take back).
async function findStockShortages(db, items) {
  // Lines are independent reads — run them together instead of one network
  // hop per line (a Turso round trip each). The caller still checks the whole
  // result before touching any stock or status, so the all-or-nothing 409
  // contract is unchanged.
  const checks = await Promise.all(items.map(async (it) => {
    const qty = Number(it.qty) || 1;
    const product = await db.prepare('SELECT id, name, stock_qty FROM products WHERE id = ?').get(it.id);
    if (!product) return { name: it.name || `product #${it.id}`, size: it.size || null, needed: qty, available: null };
    const perSize = await sizeStock.loadSizeStock(db, product.id);
    if (perSize) {
      if (!Object.prototype.hasOwnProperty.call(perSize, it.size)) return { name: product.name, size: it.size || null, needed: qty, available: null };
      const available = Number(perSize[it.size]) || 0;
      return available < qty ? { name: product.name, size: it.size, needed: qty, available } : null;
    }
    const available = Number(product.stock_qty) || 0;
    return available < qty ? { name: product.name, size: it.size || null, needed: qty, available } : null;
  }));
  return checks.filter(Boolean);
}

function shortageMessage(shortages) {
  const detail = shortages.map((s) => {
    const label = `"${s.name}"` + (s.size ? ` (size ${s.size})` : '');
    return s.available === null
      ? `${label} is no longer stocked`
      : `${label} — ${s.needed} needed, ${s.available} available`;
  }).join('; ');
  return `Cannot reactivate this order: not enough stock — ${detail}. Nothing was changed.`;
}

module.exports = { adjustLineStock, findStockShortages, shortageMessage };

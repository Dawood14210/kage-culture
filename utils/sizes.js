// ================================================================
// KAGE Culture — per-size inventory helpers
// ----------------------------------------------------------------
// A product lists the sizes it is sold in (products.sizes, JSON array).
// Stock is tracked in one of two ways:
//
//   * PER SIZE — one row per size in product_size_stock. products.stock_qty
//     then holds the sum of those rows (kept in sync by syncProductStock),
//     so catalog/admin totals keep working.
//   * LEGACY POOL — no rows. products.stock_qty is a single shared count,
//     or NULL when stock is not tracked. Products created before per-size
//     tracking keep working unchanged.
//
// Rows are authoritative whenever they exist.
// ================================================================

const DEFAULT_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const MAX_SIZES = 6;
const MAX_SIZE_LENGTH = 10; // matches the order line `size` column cap

// Parse the `sizes` JSON column; falls back to the standard set.
function parseSizeColumn(raw) {
  try {
    const parsed = JSON.parse(raw || JSON.stringify(DEFAULT_SIZES));
    return Array.isArray(parsed) ? parsed.map(String) : [...DEFAULT_SIZES];
  } catch (_) {
    return [...DEFAULT_SIZES];
  }
}

// Parse the `sizes` request field (a JSON array string). Returns a clean,
// de-duplicated list, or null when the input is malformed.
function parseSizesInput(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return null; }
  if (!Array.isArray(parsed)) return null;
  const clean = [...new Set(parsed.map(v => String(v).trim()).filter(Boolean))];
  if (!clean.length || clean.length > MAX_SIZES) return null;
  if (clean.some(s => s.length > MAX_SIZE_LENGTH)) return null;
  return clean;
}

// Load the per-size stock map for one product, or null when the product
// is not tracked per size.
async function loadSizeStock(db, productId) {
  const rows = await db.prepare('SELECT size, stock_qty FROM product_size_stock WHERE product_id = ?').all(productId);
  if (!rows || !rows.length) return null;
  const map = {};
  for (const r of rows) map[r.size] = Number(r.stock_qty) || 0;
  return map;
}

// Load per-size stock for every product that has it: Map<productId, {size: qty}>.
async function loadAllSizeStock(db) {
  const rows = await db.prepare('SELECT product_id, size, stock_qty FROM product_size_stock').all();
  const map = new Map();
  for (const r of rows || []) {
    const pid = Number(r.product_id);
    if (!map.has(pid)) map.set(pid, {});
    map.get(pid)[r.size] = Number(r.stock_qty) || 0;
  }
  return map;
}

// Validate an admin-supplied per-size stock object against the product's
// sizes. Every listed size needs a whole-number quantity and no unknown
// sizes are allowed. Returns { value } or { error }.
function parseSizeStockInput(raw, sizes) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (_) { return { error: 'Stock per size must be valid JSON.' }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'Stock per size must be an object of size quantities.' };
  const value = {};
  for (const size of sizes) {
    const raw = Object.prototype.hasOwnProperty.call(obj, size) ? obj[size] : undefined;
    if (raw === undefined || raw === null || raw === '') return { error: `Enter a stock quantity for size ${size}.` };
    const q = Number(raw);
    if (!Number.isSafeInteger(q) || q < 0) return { error: 'Stock quantity must be a non-negative whole number.' };
    value[size] = q;
  }
  for (const key of Object.keys(obj)) {
    if (!sizes.includes(key)) return { error: `Size ${key} is not one of this product's sizes.` };
  }
  return { value };
}

// Recompute products.stock_qty (and sold-out flag) from the size rows.
// Does nothing for products without rows, so legacy pools are untouched.
async function syncProductStock(db, productId) {
  const rows = await db.prepare('SELECT stock_qty FROM product_size_stock WHERE product_id = ?').all(productId);
  if (!rows || !rows.length) return null;
  const total = rows.reduce((sum, r) => sum + (Number(r.stock_qty) || 0), 0);
  await db.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(total, productId);
  if (total <= 0) await db.prepare('UPDATE products SET in_stock = 0 WHERE id = ?').run(productId);
  return total;
}

// Replace a product's per-size rows with `sizeStock` ({size: qty}) and sync totals.
async function replaceSizeStock(db, productId, sizeStock) {
  await db.prepare('DELETE FROM product_size_stock WHERE product_id = ?').run(productId);
  for (const size of Object.keys(sizeStock)) {
    await db.prepare('INSERT INTO product_size_stock (product_id, size, stock_qty) VALUES (?, ?, ?)').run(productId, size, sizeStock[size]);
  }
  await syncProductStock(db, productId);
}

// Build the per-size map for a new sizes list from the current one:
// kept sizes keep their quantity, new sizes start at 0, removed sizes drop.
function reconcileSizeStock(current, sizes) {
  const next = {};
  for (const size of sizes) next[size] = current && current[size] != null ? current[size] : 0;
  return next;
}

// Sum of a per-size map.
function totalOf(sizeStock) {
  return Object.values(sizeStock || {}).reduce((sum, q) => sum + (Number(q) || 0), 0);
}

module.exports = {
  DEFAULT_SIZES,
  parseSizeColumn,
  parseSizesInput,
  loadSizeStock,
  loadAllSizeStock,
  parseSizeStockInput,
  syncProductStock,
  replaceSizeStock,
  reconcileSizeStock,
  totalOf,
};

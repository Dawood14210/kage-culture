// ================================================================
// KAGE Culture — product payload shapes (public vs admin)
// ----------------------------------------------------------------
// products holds internal columns that must never reach a public
// visitor — above all `unit_cost` (cost of goods), which would hand
// a competitor the whole margin, plus `updated_at`.
//
// Both public endpoints therefore build their payload from the explicit
// ALLOW-LIST below, never `SELECT *` + spread: a column added to the
// table later can leak only by being added here on purpose.
//
// Allow-list provenance (what the storefront actually reads — see
// loadProductsFromAPI() and the card/detail renderers in
// public/index.html):
//   id, name, price, sale_price            → cards, detail, sorting
//   category                               → collection filters
//   fit, description, sizes                → card label, detail copy, size picker
//   front_image, back_image, extra_images  → gallery
//   in_stock, stock_qty, size_stock        → stock badges + add-to-cart guards
//   collections                            → collection memberships
//   created_at                             → newest-first ordering
//   sold_count, order_count                → "N sold" urgency, best-seller order
//   avg_rating, review_count               → star row
// tests/e2e.test.js pins the same contract, and asserts the internal
// columns are absent from public payloads.
// ================================================================
const config = require('../config');
const sizeStock = require('./sizes');

// Every products-table column a public response is allowed to carry.
const PUBLIC_PRODUCT_COLUMNS = [
  'id', 'name', 'category', 'fit', 'price', 'sale_price', 'description',
  'sizes', 'front_image', 'back_image', 'extra_images', 'in_stock',
  'collections', 'stock_qty', 'created_at'
];
// Admin responses add the internal columns the panel needs (edit form +
// P&L unit cost, sale flag, audit timestamp).
const ADMIN_ONLY_PRODUCT_COLUMNS = ['on_sale', 'unit_cost', 'updated_at'];

const PUBLIC_PRODUCT_SELECT = PUBLIC_PRODUCT_COLUMNS.join(', ');
const ADMIN_PRODUCT_SELECT = PUBLIC_PRODUCT_COLUMNS.concat(ADMIN_ONLY_PRODUCT_COLUMNS).join(', ');

function jsonArray(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function numericOrNull(value) {
  return (value != null && value !== '') ? Number(value) : null;
}

// Aggregate fields shared by both shapes. Callers pass whatever they loaded;
// anything missing falls back to the "no data" value so the contract is stable.
function aggregateFields(extras) {
  const avatar = extras || {};
  return {
    size_stock: avatar.size_stock !== undefined ? avatar.size_stock : null,
    sold_count: Number(avatar.sold_count) || 0,
    order_count: Number(avatar.order_count) || 0,
    avg_rating: avatar.avg_rating != null ? avatar.avg_rating : null,
    review_count: Number(avatar.review_count) || 0
  };
}

// Public payload: allow-listed table columns + the aggregates above. The
// row is re-read field by field — never spread — so an unexpected column
// in `row` (or a backend that ignores the SELECT list) cannot leak.
function shapePublicProduct(row, extras) {
  if (!row) return row;
  const stock = numericOrNull(row.stock_qty);
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    fit: row.fit,
    price: Number(row.price),
    sale_price: numericOrNull(row.sale_price),
    description: row.description,
    sizes: sizeStock.parseSizeColumn(row.sizes),
    front_image: row.front_image,
    back_image: row.back_image,
    extra_images: jsonArray(row.extra_images),
    in_stock: Boolean(row.in_stock) && (stock == null || stock > 0),
    stock_qty: stock,
    collections: jsonArray(row.collections),
    created_at: row.created_at,
    ...aggregateFields(extras)
  };
}

// Admin payload: the public fields plus the internal ones (unit_cost for the
// edit form and the P&L). Admin-only routes must gate this with requireAuth.
function shapeAdminProduct(row, extras) {
  if (!row) return row;
  return {
    ...shapePublicProduct(row, extras),
    on_sale: Boolean(row.on_sale),
    unit_cost: numericOrNull(row.unit_cost),
    updated_at: row.updated_at
  };
}

function shapePublicProducts(rows, extrasById) {
  return (rows || []).map(row => shapePublicProduct(row, extrasById ? extrasById(row) : undefined));
}

// ----------------------------------------------------------------
// Approved-review aggregates — one query, reused by both shapes.
// ----------------------------------------------------------------
async function loadReviewAggregates(db) {
  let rows = [];
  try { rows = await db.prepare('SELECT product_id, rating FROM reviews WHERE status = ?').all('approved'); } catch (e) { rows = []; }
  const agg = new Map();
  for (const r of rows || []) {
    const id = Number(r.product_id);
    const a = agg.get(id) || { sum: 0, n: 0 };
    a.sum += Number(r.rating) || 0;
    a.n += 1;
    agg.set(id, a);
  }
  return agg;
}

function ratingFields(aggregate) {
  if (!aggregate || !aggregate.n) return { avg_rating: null, review_count: 0 };
  return { avg_rating: Math.round((aggregate.sum / aggregate.n) * 10) / 10, review_count: aggregate.n };
}

// ----------------------------------------------------------------
// Sold units per product
// ----------------------------------------------------------------
// `sold_count` counts units in every order that is not cancelled. The old
// implementation pulled every order row and JSON-parsed items_json on each
// request; this one asks SQLite for the aggregate in a single statement
// (JSON1 is built into every SQLite since 3.38, and Turso/libSQL ships it),
// falls back to one scan on backends without JSON1 (the pure-JS in-memory
// store), and caches the map for SOLD_COUNT_CACHE_MS either way.
const SOLD_COUNT_SQL = `
  SELECT CAST(json_extract(it.value, '$.id') AS INTEGER) AS product_id,
         SUM(COALESCE(NULLIF(CAST(json_extract(it.value, '$.qty') AS INTEGER), 0), 1)) AS units
    FROM orders o, json_each(o.items_json) AS it
   WHERE o.status != ? AND json_valid(o.items_json)
   GROUP BY product_id
`;

const soldCache = { map: null, at: 0, pending: null, strategy: 'unknown' };
let json1Support = null;

async function json1Available(db) {
  if (json1Support !== null) return json1Support;
  try {
    const probe = await db.prepare("SELECT json_extract('{\"kage\":1}', '$.kage') AS v").get();
    json1Support = !!probe && Number(probe.v) === 1;
  } catch (_) { json1Support = false; }
  return json1Support;
}

// Reference implementation — same numbers as SOLD_COUNT_SQL, one scan.
async function scanSoldCounts(db) {
  const orders = await db.prepare('SELECT items_json FROM orders WHERE status != ?').all('cancelled');
  const map = new Map();
  for (const o of orders || []) {
    let items = [];
    try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; }
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const id = Number(it && it.id);
      if (!Number.isFinite(id)) continue;
      map.set(id, (map.get(id) || 0) + (Number(it.qty) || 1));
    }
  }
  return map;
}

// Map<productId, unitsSold>, cached. Concurrent callers share one computation.
async function getSoldCounts(db) {
  if (soldCache.map && Date.now() - soldCache.at < config.SOLD_COUNT_CACHE_MS) return soldCache.map;
  if (soldCache.pending) return soldCache.pending;
  soldCache.pending = (async () => {
    let map = null;
    if (await json1Available(db)) {
      const rows = await db.prepare(SOLD_COUNT_SQL).all('cancelled');
      // A backend that silently refuses the query returns rows without the
      // aggregate columns — treat that as unsupported rather than "no sales".
      if (Array.isArray(rows) && rows.every(r => r && 'product_id' in r && 'units' in r)) {
        map = new Map(rows.map(r => [Number(r.product_id), Number(r.units) || 0]));
        soldCache.strategy = 'json1';
      }
    }
    if (!map) {
      map = await scanSoldCounts(db);
      soldCache.strategy = 'scan';
    }
    soldCache.map = map;
    soldCache.at = Date.now();
    return map;
  })();
  try {
    return await soldCache.pending;
  } finally {
    soldCache.pending = null;
  }
}

// Order writes call this so "N sold" stays correct inside the cache window.
function invalidateSoldCounts() {
  soldCache.map = null;
  soldCache.at = 0;
}

// Observability for tests: which strategy the last computation used.
function soldCountsStrategy() { return soldCache.strategy; }

module.exports = {
  PUBLIC_PRODUCT_COLUMNS,
  ADMIN_ONLY_PRODUCT_COLUMNS,
  PUBLIC_PRODUCT_SELECT,
  ADMIN_PRODUCT_SELECT,
  shapePublicProduct,
  shapePublicProducts,
  shapeAdminProduct,
  loadReviewAggregates,
  ratingFields,
  getSoldCounts,
  scanSoldCounts,
  invalidateSoldCounts,
  soldCountsStrategy
};

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
// Approved-review aggregates
// ----------------------------------------------------------------
async function computeReviewAggregates(db) {
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
// store), and combines this map with approved-review aggregates in a shared
// 60-second cache.
const SOLD_COUNT_SQL = `
  SELECT CAST(json_extract(it.value, '$.id') AS INTEGER) AS product_id,
         SUM(COALESCE(NULLIF(CAST(json_extract(it.value, '$.qty') AS INTEGER), 0), 1)) AS units
    FROM orders o, json_each(o.items_json) AS it
   WHERE o.status != ? AND json_valid(o.items_json)
   GROUP BY product_id
`;

const productAggregateCache = { result: null, at: 0, pending: null, version: 0, strategy: 'unknown' };
const PRODUCT_AGGREGATE_CACHE_MS = Number(config.SOLD_COUNT_CACHE_MS) || 60 * 1000;
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

async function computeSoldCounts(db) {
  if (await json1Available(db)) {
    try {
      const rows = await db.prepare(SOLD_COUNT_SQL).all('cancelled');
      // A backend that silently refuses the query returns rows without the
      // aggregate columns — treat that as unsupported rather than "no sales".
      if (Array.isArray(rows) && rows.every(r => r && 'product_id' in r && 'units' in r)) {
        return { map: new Map(rows.map(r => [Number(r.product_id), Number(r.units) || 0])), strategy: 'json1' };
      }
    } catch (_) { /* fall back to the single-pass JSON scan below */ }
  }
  return { map: await scanSoldCounts(db), strategy: 'scan' };
}

// The sold-unit and approved-review maps are one cache entry so every public
// product response is built from a consistent snapshot. Concurrent reads
// share one computation; invalidation bumps a generation so an older in-flight
// query cannot repopulate the cache after a write.
async function getProductAggregates(db) {
  if (productAggregateCache.result && Date.now() - productAggregateCache.at < PRODUCT_AGGREGATE_CACHE_MS) {
    return productAggregateCache.result;
  }
  if (productAggregateCache.pending) return productAggregateCache.pending;

  const version = productAggregateCache.version;
  const pending = (async () => {
    const [soldResult, reviews] = await Promise.all([computeSoldCounts(db), computeReviewAggregates(db)]);
    return { sold: soldResult.map, reviews, strategy: soldResult.strategy };
  })();
  productAggregateCache.pending = pending;
  try {
    const result = await pending;
    if (productAggregateCache.version === version) {
      productAggregateCache.result = result;
      productAggregateCache.at = Date.now();
      productAggregateCache.strategy = result.strategy;
    }
    return result;
  } finally {
    if (productAggregateCache.pending === pending) productAggregateCache.pending = null;
  }
}

async function getSoldCounts(db) {
  return (await getProductAggregates(db)).sold;
}

async function loadReviewAggregates(db) {
  return (await getProductAggregates(db)).reviews;
}

function invalidateProductAggregates() {
  productAggregateCache.version++;
  productAggregateCache.result = null;
  productAggregateCache.at = 0;
  productAggregateCache.pending = null;
  productAggregateCache.strategy = 'unknown';
}

// Backward-compatible name; order writes now invalidate both aggregate maps.
function invalidateSoldCounts() {
  invalidateProductAggregates();
}

// Observability for tests: which sold-count strategy the last computation used.
function soldCountsStrategy() { return productAggregateCache.strategy; }

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
  getProductAggregates,
  getSoldCounts,
  scanSoldCounts,
  invalidateProductAggregates,
  invalidateSoldCounts,
  soldCountsStrategy
};

// ================================================================
// KAGE Culture — public catalog assembly (shared)
// ----------------------------------------------------------------
// One place that turns the products table into the public payload
// shape, used by:
//   1. GET /api/products (legacy array + ?page/?category envelope)
//   2. the HTML shell, which inlines page 1 as an inert JSON block
//      (the storefront's first paint needs no extra round trip)
// ----------------------------------------------------------------
// The payload itself is unchanged: utils/productShape.js allow-lists
// every field; `unit_cost` and the other internal columns stay out.
// ================================================================
const productShape = require('./productShape');
const sizeStock = require('./sizes');

const CATALOG_PAGE_SIZE = 24;

// Full public list, newest first — identical to what the legacy
// GET /api/products endpoint ships.
async function buildPublicProductList(db) {
  const products = await db.prepare(`SELECT ${productShape.PUBLIC_PRODUCT_SELECT} FROM products ORDER BY created_at DESC, id DESC`).all();
  const sold = await productShape.getSoldCounts(db);
  const revAgg = await productShape.loadReviewAggregates(db);
  const sizeStockById = await sizeStock.loadAllSizeStock(db);
  return products.map(p => productShape.shapePublicProduct(p, {
    size_stock: sizeStockById.get(Number(p.id)) || null,
    sold_count: sold.get(Number(p.id)) || 0,
    order_count: sold.get(Number(p.id)) || 0, // unchanged: mirrors sold_count
    ...productShape.ratingFields(revAgg.get(Number(p.id)))
  }));
}

// Envelope returned by GET /api/products?page=N&category=<slug> and
// inlined into the HTML shell as page 1.
function catalogEnvelope(products, page, limit, total) {
  const pageSize = Math.max(1, Math.floor(Number(limit)) || CATALOG_PAGE_SIZE);
  const totalItems = Math.max(0, Number(total) || 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  // The caller validates page >= 1. A page beyond the end is an empty window,
  // not the last page replayed: the client stops on hasMore, and crawlers get
  // an unambiguous signal.
  const currentPage = Math.max(1, Math.floor(Number(page)) || 1);
  const start = (currentPage - 1) * pageSize;
  return {
    products: products.slice(start, start + pageSize),
    page: currentPage,
    limit: pageSize,
    total: totalItems,
    totalPages,
    hasMore: currentPage < totalPages
  };
}

module.exports = { CATALOG_PAGE_SIZE, buildPublicProductList, catalogEnvelope };

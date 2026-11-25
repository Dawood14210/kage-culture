// ================================================================
// KAGE CULTURE — Centralized configuration
// All magic numbers and thresholds live here.
// ================================================================

// The canonical list of product categories shared by server validation,
// admin dropdowns, and the storefront category strip. Only these values are
// accepted when creating or updating products; anything else is rejected with
// a 400. Order here matches the homepage category strip.
const PRODUCT_CATEGORIES = [
  { value: 'graphic-tees', label: 'Graphic Tees' },
  { value: 'anime',        label: 'Anime Shirts' },
  { value: 'pants',        label: 'Pants' }
];
const PRODUCT_CATEGORY_VALUES = new Set(PRODUCT_CATEGORIES.map(c => c.value));

// Categories that route to the Coming Soon page while they have no live
// (in-stock) products. 'graphic-tees' is intentionally NOT here — it always
// shows the shop grid, which falls back to the normal empty state.
const COMING_SOON_CATEGORIES = ['compression', 'oversized', 'sale'];

module.exports = {
  // Inventory
  LOW_STOCK_THRESHOLD: 5,
  MAX_BATCH_PRODUCT_DELETE: 100,

  // Categories
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_VALUES,
  COMING_SOON_CATEGORIES,

  // Product images: front + back + up to this many extra gallery photos
  MAX_EXTRA_IMAGES: 4,

  // How long aggregated sold counts (per product) are reused before the
  // single SQL aggregate is recomputed. Order writes invalidate immediately.
  SOLD_COUNT_CACHE_MS: 60 * 1000,

  // Sitemap product/category data is reused per warm serverless instance for
  // ten minutes; the same duration is advertised to browser and shared caches.
  SITEMAP_CACHE_MS: 10 * 60 * 1000,

  // Server-rendered SEO descriptions stay within search-result snippet length;
  // Product JSON-LD includes only a small approved-review sample while its
  // aggregate rating/count reflect all approved reviews.
  SEO_DESCRIPTION_MAX_LENGTH: 155,
  SEO_REVIEW_SCHEMA_LIMIT: 5,

  // KAGE Clan
  CLAN_THRESHOLD: 5, // shirts needed to join the clan

  // Password policy (F17): customers need at least 10 characters, admins at
  // least 14. There is deliberately no single fallback constant — a route
  // must opt into one of the two explicitly.
  MIN_CUSTOMER_PASSWORD_LENGTH: 10,
  MIN_ADMIN_PASSWORD_LENGTH: 14,

  // The AUTO_CREATE_ADMIN escape hatch obeys the same admin policy.
  ADMIN_AUTO_CREATE_MIN_LENGTH: 14,

  // Delivery charges (F3) — flat city fees in PKR. Every value stays within
  // Rs. 250–500 and is TODO(owner): these placeholders are NOT confirmed
  // business values; the owner must confirm the real courier rate per city
  // before they carry any money. Orders still ship with shipping = 0 and
  // shipping_pending = 1; the exact fee is confirmed by phone (D1).
  DELIVERY_FEE_BAND: 'Rs. 250 – Rs. 500',
  DELIVERY_FEE_MIN: 250,
  DELIVERY_FEE_MAX: 500,
  DELIVERY_FEES: {
    Islamabad: 250,    // TODO(owner): confirm with courier
    Rawalpindi: 250,   // TODO(owner): confirm with courier
    Karachi: 300,      // TODO(owner): confirm with courier
    Lahore: 300,       // TODO(owner): confirm with courier
    Faisalabad: 350,   // TODO(owner): confirm with courier
    Multan: 400        // TODO(owner): confirm with courier
  },
  // Cities not in the table — the checkout "Other" option and any unmatched
  // value — are quoted at the ceiling until the owner confirms their rates.
  DELIVERY_FEE_FALLBACK: 500, // TODO(owner): confirm with courier

  // Rate limiting
  RATE_LIMIT_GLOBAL: 120, // per minute
  RATE_LIMIT_STRICT: 10,  // auth-sensitive endpoints
  RATE_LIMIT_ORDERS: 8,   // order placement
  RATE_LIMIT_RESET: 5,    // password reset requests per minute

  // Email sends are awaited by routes; bound every provider attempt so mail
  // outages can delay, but never indefinitely block, an order response.
  EMAIL_SEND_TIMEOUT_MS: 8 * 1000,

  // Boot retry: after a failed database boot, requests get an immediate 503
  // for this long instead of hammering a database that is already down. The
  // failed attempt itself is never cached (see server.js#getReady).
  READY_RETRY_BACKOFF_MS: 1000,

  // Password reset
  RESET_TOKEN_EXPIRY_MS: 60 * 60 * 1000, // 1 hour

  // Customer email verification (order history is gated on it)
  VERIFY_TOKEN_EXPIRY_MS: 24 * 60 * 60 * 1000, // 24 hours

  // Order statuses
  ORDER_STATUSES: ['pending', 'awaiting_verification', 'confirmed', 'shipped', 'delivered', 'cancelled'],

  // Admin order list pagination (CSV export is deliberately unpaginated).
  ORDER_LIST_DEFAULT_LIMIT: 50,
  ORDER_LIST_MAX_LIMIT: 200,

  // Review moderation
  REVIEW_AUTO_APPROVE_ABOVE: 3.5, // reviews rated above this publish without admin approval

  // Payment methods
  PAYMENT_METHODS: ['cod', 'jazzcash', 'bank'],
};

// Server-side delivery fee for a city (F3). Exact, case-insensitive match on
// the submitted city; anything unrecognised falls back to the ceiling. The
// result is clamped to the published Rs. 250–500 band no matter what the
// table says. Used for the fee the admin confirms by phone before dispatch.
function deliveryFeeForCity(city) {
  const clean = String(city == null ? '' : city).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
  let fee = module.exports.DELIVERY_FEE_FALLBACK;
  for (const [name, value] of Object.entries(module.exports.DELIVERY_FEES)) {
    if (name.toLowerCase() === clean) { fee = value; break; }
  }
  return Math.min(module.exports.DELIVERY_FEE_MAX, Math.max(module.exports.DELIVERY_FEE_MIN, Number(fee) || module.exports.DELIVERY_FEE_FALLBACK));
}

module.exports.deliveryFeeForCity = deliveryFeeForCity;

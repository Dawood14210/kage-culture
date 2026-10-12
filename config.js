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

  // KAGE Clan
  CLAN_THRESHOLD: 5, // shirts needed to join the clan

  // Password
  MIN_PASSWORD_LENGTH: 6,

  // Admin auto-create: requires at least 8 chars in production
  ADMIN_AUTO_CREATE_MIN_LENGTH: 8,

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

  // Review moderation
  REVIEW_AUTO_APPROVE_ABOVE: 3.5, // reviews rated above this publish without admin approval

  // Payment methods
  PAYMENT_METHODS: ['cod', 'jazzcash', 'bank'],
};

// ================================================================
// KAGE CULTURE — Centralized configuration
// All magic numbers and thresholds live here.
// ================================================================

module.exports = {
  // Inventory
  LOW_STOCK_THRESHOLD: 5,
  MAX_BATCH_PRODUCT_DELETE: 100,

  // Product images: front + back + up to this many extra gallery photos
  MAX_EXTRA_IMAGES: 4,

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

  // Password reset
  RESET_TOKEN_EXPIRY_MS: 60 * 60 * 1000, // 1 hour

  // Order statuses
  ORDER_STATUSES: ['pending', 'awaiting_verification', 'confirmed', 'shipped', 'delivered', 'cancelled'],

  // Review moderation
  REVIEW_AUTO_APPROVE_ABOVE: 3.5, // reviews rated above this publish without admin approval

  // Payment methods
  PAYMENT_METHODS: ['cod', 'jazzcash', 'bank'],
};

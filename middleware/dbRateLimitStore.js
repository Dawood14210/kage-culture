// ================================================================
// KAGE Culture — express-rate-limit v8 shared database store
// ================================================================
const db = require('../database');

class DatabaseRateLimitStore {
  constructor({ namespace = 'default', failClosed = false, failureLimit = 0 } = {}) {
    this.namespace = String(namespace);
    // express-rate-limit v8 uses Store.prefix when validating that distinct
    // shared-store limiters have distinct keys on the same request.
    this.prefix = `${this.namespace}:`;
    this.failClosed = failClosed;
    this.failureLimit = Math.max(0, Number(failureLimit) || 0);
    this.windowMs = 60 * 1000;
    // express-rate-limit validates this flag to distinguish shared stores from
    // process-local ones. Keys live in the database, so they are not local.
    this.localKeys = false;
  }

  init(options) {
    if (options && Number.isFinite(Number(options.windowMs))) this.windowMs = Number(options.windowMs);
  }

  scopedKey(key) {
    return `${this.namespace}:${key}`;
  }

  async increment(key) {
    try {
      const row = await db.incrementRateLimit(this.scopedKey(key), this.windowMs);
      return { totalHits: row.count, resetTime: new Date(row.reset_at) };
    } catch (error) {
      if (!this.failClosed) throw error;
      // This instance is used only for admin login. A DB outage must never turn
      // into an authentication bypass: synthesize an over-limit count so the
      // normal 429 handler runs (including Retry-After) rather than next(error).
      console.warn(`⚠️  admin login rate-limit store failed closed (${this.namespace}):`, error && error.message ? error.message : error);
      return { totalHits: this.failureLimit + 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    await db.decrementRateLimit(this.scopedKey(key));
  }

  async resetKey(key) {
    await db.resetRateLimit(this.scopedKey(key));
  }

  async resetAll() {
    await db.resetRateLimits(`${this.namespace}:`);
  }

  async get(key) {
    const row = await db.getRateLimit(this.scopedKey(key));
    return row ? { totalHits: row.count, resetTime: new Date(row.reset_at) } : undefined;
  }
}

module.exports = { DatabaseRateLimitStore };

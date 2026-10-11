// ================================================================
// KAGE Culture — Rate limiters
// ================================================================
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../database');
const { DatabaseRateLimitStore } = require('./dbRateLimitStore');

// Turso is always shared. Local/self-hosted deployments can opt in explicitly;
// ordinary local development and tests keep express-rate-limit's in-memory
// store unless RATE_LIMIT_STORE=db is set.
const useDatabaseStore = db.USE_TURSO || String(process.env.RATE_LIMIT_STORE || '').trim().toLowerCase() === 'db';

function retryAfterSeconds(req) {
  const resetAt = req.rateLimit && req.rateLimit.resetTime instanceof Date
    ? req.rateLimit.resetTime.getTime()
    : Date.now() + 60 * 1000;
  return String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
}

function createLimiter({ namespace, limit, windowMs = 60 * 1000, message, failClosed = false }) {
  const options = {
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
    handler(req, res) {
      if (!res.headersSent) {
        res.setHeader('Retry-After', retryAfterSeconds(req));
        res.status(429).json({ error: message });
      }
    }
  };

  // Apply the availability policy to every store type: ordinary traffic logs
  // and passes on an increment failure; admin login never passes an error open.
  options.passOnStoreError = !failClosed;
  options.logger = {
    error(error, detail) {
      console.warn(`⚠️  rate-limit store error (${namespace})${detail ? `: ${detail}` : ''}:`, error && error.message ? error.message : error);
    },
    warn(error, detail) {
      console.warn(`⚠️  rate-limit warning (${namespace})${detail ? `: ${detail}` : ''}:`, error && error.message ? error.message : error);
    }
  };

  if (useDatabaseStore) {
    options.store = new DatabaseRateLimitStore({
      namespace,
      failClosed,
      failureLimit: limit
    });
  }

  return rateLimit(options);
}

// Keep express-rate-limit's built-in keyGenerator. It reads req.ip (Express
// trusts exactly Vercel's one proxy hop in server.js) and calls ipKeyGenerator
// so IPv6 clients are bucketed by subnet rather than bypassing limits by
// rotating through addresses. No custom X-Forwarded-For parsing is needed.
const globalLimiter = createLimiter({
  namespace: 'global',
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_GLOBAL,
  message: 'Too many requests. Please try again later.'
});

const strictLimiter = createLimiter({
  namespace: 'strict',
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_STRICT,
  message: 'Too many attempts. Please try again later.'
});

// Separate admin login namespace: fail-closed on a shared-store error. This
// keeps the existing 10/minute IP ceiling while leaving general strict routes
// on the fail-open policy.
const adminLoginLimiter = createLimiter({
  namespace: 'admin-login',
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_STRICT,
  message: 'Too many attempts. Please try again later.',
  failClosed: true
});

const customerLoginLimiter = createLimiter({
  namespace: 'customer-login',
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_STRICT,
  message: 'Too many attempts. Please try again later.'
});

const orderLimiter = createLimiter({
  namespace: 'orders',
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_ORDERS,
  message: 'Too many order attempts. Please try again later.'
});

const resetLimiter = createLimiter({
  namespace: 'reset',
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_RESET,
  message: 'Too many reset requests. Please try again later.'
});

module.exports = {
  globalLimiter,
  strictLimiter,
  adminLoginLimiter,
  customerLoginLimiter,
  orderLimiter,
  resetLimiter,
  useDatabaseStore
};

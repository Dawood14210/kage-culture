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

function createLimiter({ namespace, limit, windowMs = 60 * 1000, message, failClosed = false, keyGenerator }) {
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

  if (keyGenerator) options.keyGenerator = keyGenerator;

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

// ── F29: identity-aware keys for order/tracking traffic ──────────
// Carrier-grade NATs put many unrelated customers behind ONE egress IP, so a
// purely per-IP bucket lets one busy carrier exhaust the store's patience —
// and one rotating-identity attacker burn exactly the same budget as a whole
// neighbourhood. Order and tracking requests are therefore bucketed by
// IP + normalised phone (+ email for orders), with a RELAXED per-IP floor
// kept as a backstop. (The previous per-IP-only bucket at 8/min could not be
// kept unchanged: it would cap every NAT'd customer at 8 orders/min together,
// which is the bug this fixes. The floor is 5× the identity limit.)
// Phone normalisation matches the order lookup (last 10 digits, digits only);
// email is trimmed and lower-cased to match how it is stored.
const { ipKeyGenerator } = require('express-rate-limit');

function normalizePhoneIdentity(value) {
  return String(value == null ? '' : value).replace(/\D/g, '').slice(-10);
}

function normalizeEmailIdentity(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function compositeIdentityKey(req) {
  const body = req.body || {};
  const query = req.query || {};
  const ip = ipKeyGenerator((req.ip || '0.0.0.0').toString());
  const phone = normalizePhoneIdentity(body.phone !== undefined ? body.phone : query.phone);
  const email = normalizeEmailIdentity(body.email !== undefined ? body.email : query.email);
  return `${ip}|${phone}|${email}`;
}

// Per-IP floor: 5× the identity limit. Buckets rotating-identity floods from
// one address without throttling NAT'd neighbours.
const ORDER_IP_FLOOR = config.RATE_LIMIT_ORDERS * 5;
const TRACKING_IP_FLOOR = config.RATE_LIMIT_STRICT * 5;

// Kept as the per-IP floor for order placement (bug fix requires relaxing it;
// the identity limiter below is the operative per-customer control).
const orderIpFloorLimiter = createLimiter({
  namespace: 'orders',
  windowMs: 60 * 1000,
  limit: ORDER_IP_FLOOR,
  message: 'Too many order attempts. Please try again later.'
});

// The operative limit: 8 orders per minute per (IP, phone, email).
const orderIdentityLimiter = createLimiter({
  namespace: 'orders-id',
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_ORDERS,
  message: 'Too many order attempts. Please try again later.',
  keyGenerator: compositeIdentityKey
});

// Back-compat alias: older call sites asked for "orderLimiter"; the floor is
// what they get, with the identity limiter stacked on top at the route.
const orderLimiter = orderIpFloorLimiter;

// Tracking (POST /api/orders/track and the phone-verified GET): the operative
// limit is per (IP, phone). The floor keeps a single address from rotating
// phones forever.
const trackingIpFloorLimiter = createLimiter({
  namespace: 'tracking-ip',
  windowMs: 60 * 1000,
  limit: TRACKING_IP_FLOOR,
  message: 'Too many attempts. Please try again later.'
});

const trackingIdentityLimiter = createLimiter({
  namespace: 'tracking-id',
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_STRICT,
  message: 'Too many attempts. Please try again later.',
  keyGenerator: compositeIdentityKey
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
  orderIpFloorLimiter,
  orderIdentityLimiter,
  trackingIpFloorLimiter,
  trackingIdentityLimiter,
  resetLimiter,
  useDatabaseStore
};

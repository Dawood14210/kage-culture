// ================================================================
// KAGE Culture — Authentication middleware
// ================================================================
const crypto = require('crypto');
const { parseCookies } = require('../utils/helpers');
const { getSessionSecret } = require('../utils/secret');

// The secret is resolved on demand (never cached in a module-level constant) so
// this file, server.js, routes/auth.js and the CSRF signer all share the single
// rule in utils/secret.js. server.js still resolves it eagerly at boot, so a
// misconfigured deploy fails fast with a clear message instead of 500ing here.

// Constant-time comparison (timingSafeEqual throws on length mismatch)
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify and parse a `payload.sig` session cookie value.
 * Format is what routes/auth.js writes:
 *   payload = base64(JSON)   sig = HMAC-SHA256(payload, SESSION_SECRET) as base64
 * cookie-session writes the identical format for its `kage.session` cookie
 * (same secret, same algorithm), so its cookies verify here too.
 * Returns the parsed payload object, or null if missing/tampered/unsigned.
 */
function readSignedSession(value, secret = getSessionSecret()) {
  if (!value || typeof value !== 'string') return null;
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null; // no signature separator — reject
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  if (!safeEqual(expected, sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
  } catch (e) { return null; }
}

function requireAuth(req, res, next) {
  let adminId = req.session && req.session.adminId;
  if (!adminId) {
    // Fallback: read the signed session cookie directly.
    // SECURITY: the HMAC signature MUST be verified — trusting an unsigned
    // base64 payload here let anyone forge adminId (full admin takeover).
    const cookies = parseCookies(req.headers.cookie);
    const data = readSignedSession(cookies['kage.session']);
    if (data && data.adminId) adminId = data.adminId;
  }
  if (adminId) {
    req.adminId = adminId;
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
}

/**
 * Best-effort customer id for public routes (order placement): returns the
 * signed-in customer's id, or null. Never rejects — an anonymous visitor must
 * still be able to place an order.
 */
function optionalCustomerId(req) {
  let customerId = req.session && req.session.customerId;
  if (!customerId) {
    const cookies = parseCookies(req.headers.cookie);
    const data = readSignedSession(cookies['kage.cust']);
    if (data && data.customerId) customerId = data.customerId;
  }
  return customerId || null;
}

function requireCustomerAuth(req, res, next) {
  let customerId = req.session && req.session.customerId;
  if (!customerId) {
    const cookies = parseCookies(req.headers.cookie);
    const data = readSignedSession(cookies['kage.cust']);
    if (data && data.customerId) customerId = data.customerId;
  }
  if (customerId) {
    req.customerId = customerId;
    next();
  } else {
    res.status(401).json({ error: 'Please log in to continue.' });
  }
}

module.exports = { requireAuth, requireCustomerAuth, readSignedSession, optionalCustomerId };

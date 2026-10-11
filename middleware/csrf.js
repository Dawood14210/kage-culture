// ================================================================
// KAGE Culture — CSRF middleware (double-submit cookie)
// ----------------------------------------------------------------
// The token lives in the `kage.csrf` cookie and must be echoed back in the
// `X-CSRF-Token` header. The cookie is issued ONLY on responses a shared cache
// will not store (HTML pages, `GET /api/csrf`, and any other non-cached route).
//
// Publicly cacheable reads — `/api/products`, `/api/products/:id`, `/api/reviews`
// — must never carry `Set-Cookie`: a CDN/edge cache stores the response and
// would replay one visitor's cookie to everybody who receives the cached copy.
// The decision is made at header-flush time from the response's own
// `Cache-Control`, so any route that opts into shared caching is covered
// automatically, now and later.
//
// A browser with no cookie (fresh visitor, expired cookie, cookies cleared) gets
// one from the HTML page it loads; the storefront's fetch wrapper falls back to
// the no-store `GET /api/csrf` endpoint before its first state-changing request.
// ================================================================
const { generateCsrfToken, signCsrfToken, parseCookies } = require('../utils/helpers');

const CSRF_COOKIE_NAME = 'kage.csrf';
const CSRF_COOKIE_MAX_AGE = 86400; // seconds
const CSRF_ENDPOINT = '/api/csrf';

// A response is shared-cacheable when it opts into `public` or `s-maxage`;
// everything else (no-store, private, unset) may carry a cookie.
function isSharedCacheable(cacheControl) {
  const value = Array.isArray(cacheControl) ? cacheControl.join(', ') : String(cacheControl == null ? '' : cacheControl);
  return /(?:^|[\s,])public(?:[\s,]|$)/i.test(value) || /s-maxage/i.test(value);
}

function csrfCookieHeader(token) {
  const secureFlag = (process.env.NODE_ENV === 'production' || process.env.VERCEL) ? '; Secure' : '';
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; SameSite=Strict; Max-Age=${CSRF_COOKIE_MAX_AGE}${secureFlag}`;
}

// Append one Set-Cookie without disturbing any cookie another middleware set
// (the session cookie shares this header).
function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (existing === undefined) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', [].concat(existing, cookie));
}

// The headers passed to writeHead() win over setHeader() in Node, so the
// cacheability check has to look at both.
function cacheControlFromWriteHeadArgs(args) {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    const value = arg['Cache-Control'] !== undefined ? arg['Cache-Control'] : arg['cache-control'];
    if (value !== undefined) return value;
  }
  return undefined;
}

// Hold the new cookie until the response's Cache-Control is final, then either
// send it (non-cached response) or drop it (shared-cacheable response).
function deferCsrfCookie(res, cookie) {
  let decided = false;
  const originalWriteHead = res.writeHead;
  function decide(headersCacheControl) {
    if (decided) return;
    decided = true;
    try {
      if (res.headersSent) return;
      const cacheControl = headersCacheControl !== undefined ? headersCacheControl : res.getHeader('Cache-Control');
      if (isSharedCacheable(cacheControl)) return;
      appendSetCookie(res, cookie);
    } catch (err) {
      // A failed cookie must never break the response itself.
      console.warn('⚠️  CSRF cookie could not be set:', err.message);
    }
  }
  res.writeHead = function writeHead(...args) {
    decide(cacheControlFromWriteHeadArgs(args));
    return originalWriteHead.apply(this, args);
  };
}

function csrfMiddleware(req, res, next) {
  let existingToken = parseCookies(req.headers.cookie)[CSRF_COOKIE_NAME] || null;
  if (!existingToken) {
    existingToken = generateCsrfToken();
    deferCsrfCookie(res, csrfCookieHeader(existingToken));
  }
  req.csrfSignedToken = signCsrfToken(existingToken);
  req.csrfRawToken = existingToken;
  next();
}

function requireCsrf(req, res, next) {
  const headerToken = req.headers['x-csrf-token'];
  if (!headerToken || headerToken !== req.csrfRawToken) {
    return res.status(403).json({ error: 'Invalid CSRF token.' });
  }
  next();
}

module.exports = { csrfMiddleware, requireCsrf, isSharedCacheable, CSRF_COOKIE_NAME, CSRF_ENDPOINT };

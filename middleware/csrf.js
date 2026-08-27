// ================================================================
// KAGE Culture — CSRF middleware
// ================================================================
const { generateCsrfToken, signCsrfToken, parseCookies } = require('../utils/helpers');

function csrfMiddleware(req, res, next) {
  let existingToken = null;
  const cookies = parseCookies(req.headers.cookie);
  existingToken = cookies['kage.csrf'];
  if (!existingToken) {
    existingToken = generateCsrfToken();
    const secureFlag = (process.env.NODE_ENV === 'production' || process.env.VERCEL) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `kage.csrf=${existingToken}; Path=/; SameSite=Strict; Max-Age=86400${secureFlag}`);
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

module.exports = { csrfMiddleware, requireCsrf };

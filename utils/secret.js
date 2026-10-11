// ================================================================
// KAGE Culture — session secret resolution
// ================================================================
// ONE source of truth for the cookie-signing secret. server.js,
// middleware/auth.js, routes/auth.js and the CSRF signer all call this, so the
// fallback can never drift between them again.
//
// Rules:
//   - SESSION_SECRET set → must be at least MIN_SESSION_SECRET_LENGTH chars.
//   - SESSION_SECRET missing → the dev fallback is allowed ONLY when NODE_ENV
//     is exactly 'development' or 'test'.
//   - anything else — including NODE_ENV unset, 'staging', or a VPS / Render /
//     Railway / Docker deploy that forgot NODE_ENV=production — throws. The
//     fallback string lives in this public repo, so booting with it in any
//     reachable environment would let anyone forge an admin session cookie.
const MIN_SESSION_SECRET_LENGTH = 32;
const DEV_FALLBACK_SECRET = 'kage-dev-secret-not-for-production';
const GENERATE_HINT = 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';

function getSessionSecret() {
  const configured = String(process.env.SESSION_SECRET || '').trim();
  if (configured) {
    if (configured.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (got ${configured.length}). ${GENERATE_HINT}`);
    }
    return configured;
  }
  const env = process.env.NODE_ENV;
  if (env === 'development' || env === 'test') return DEV_FALLBACK_SECRET;
  throw new Error(`SESSION_SECRET is required. ${GENERATE_HINT} A local development fallback is allowed only when NODE_ENV is exactly 'development' or 'test'.`);
}

module.exports = { getSessionSecret, MIN_SESSION_SECRET_LENGTH, DEV_FALLBACK_SECRET };

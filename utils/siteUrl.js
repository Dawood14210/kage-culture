// ================================================================
// KAGE Culture — Canonical site URL configuration
// ================================================================

let warnedAboutMissingSiteUrl = false;

function getConfiguredSiteUrl() {
  const raw = String(process.env.SITE_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

// Page metadata and crawler files can safely use the current request origin
// when operators have not configured SITE_URL. Email links intentionally do
// not use this fallback: they require an explicit, stable public origin.
function getSiteUrlForRequest(req) {
  const configured = getConfiguredSiteUrl();
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production' && !warnedAboutMissingSiteUrl) {
    console.warn('SITE_URL is unset or invalid; page tags are falling back to the request origin. Configure SITE_URL in production.');
    warnedAboutMissingSiteUrl = true;
  }

  const protocol = req && req.protocol === 'https' ? 'https' : 'http';
  const host = req && typeof req.get === 'function' ? req.get('host') : req && req.headers && req.headers.host;
  if (!host) throw new Error('Cannot determine request origin for site metadata.');
  try {
    const url = new URL(`${protocol}://${host}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid request origin protocol.');
    return url.origin;
  } catch (_) {
    throw new Error('Cannot determine request origin for site metadata.');
  }
}

module.exports = { getConfiguredSiteUrl, getSiteUrlForRequest };

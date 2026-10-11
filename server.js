// ================================================================
// KAGE CULTURE — Server entry point
// Wires up middleware, routes, and starts the server.
// Route logic lives in routes/*.js, middleware in middleware/*.js.
// ================================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const dbModule = require('./database');
const config = require('./config');
const { globalLimiter } = require('./middleware/rateLimit');
const { csrfMiddleware } = require('./middleware/csrf');
const { requireAuth } = require('./middleware/auth');
const { getSessionSecret } = require('./utils/secret');
const { getSiteUrlForRequest } = require('./utils/siteUrl');
const demoProducts = require('./utils/demoProducts');

// Lazy-loaded heavy modules (loaded on first use, not on every cold start)
let helmet, compression, cookieSession, multer;
function loadHelmet() { return (helmet = helmet || require('helmet')); }
function loadCompression() { return (compression = compression || require('compression')); }
function loadCookieSession() { return (cookieSession = cookieSession || require('cookie-session')); }
function loadMulter() { return (multer = multer || require('multer')); }

let db = dbModule;

const app = express();
const PORT = process.env.PORT || 3000;

// M1: behind Vercel's proxy every request arrives with the proxy IP. Without
// `trust proxy`, express-rate-limit would bucket ALL visitors into one shared
// bucket — the 120/min global limit could knock the whole site over. Vercel is
// the single trusted hop, so req.ip resolves its X-Forwarded-For client value;
// express-rate-limit's built-in keyGenerator then applies ipKeyGenerator's
// IPv6 subnet normalization (we intentionally do not replace it).
app.set('trust proxy', 1);

const STOREFRONT_HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
function setHtmlNoStore(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}
function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function renderStorefrontHtml(req) {
  const siteUrl = getSiteUrlForRequest(req);
  const pagePath = req.path === '/index.html' ? '/' : req.path;
  const pageUrl = new URL(pagePath || '/', `${siteUrl}/`).href;
  return STOREFRONT_HTML_TEMPLATE
    .replaceAll('__SITE_URL__', siteUrl)
    .replaceAll('__PAGE_URL__', pageUrl);
}
function sendStorefrontHtml(req, res, status = 200) {
  setHtmlNoStore(res);
  res.status(status).type('html').send(renderStorefrontHtml(req));
}

// Session secret — resolved through the single rule in utils/secret.js:
// SESSION_SECRET must be >= 32 chars, and the development fallback is allowed
// only when NODE_ENV is exactly 'development' or 'test'. Every other case
// (NODE_ENV unset, 'staging', a VPS/Docker deploy, ...) refuses to boot rather
// than sign cookies with a string anyone can read in this repo.
let SESSION_SECRET;
try {
  SESSION_SECRET = getSessionSecret();
} catch (err) {
  console.error('FATAL: ' + err.message);
  process.exit(1);
}

// ── Security Headers ──────────────────────────────────────────
app.use(loadHelmet()({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      // REQUIRED: the storefront/admin are built on inline onclick/onkeydown
      // handlers — omitting this lets helmet default to script-src-attr 'none',
      // which silently blocks every click (prod incident 2026-09-23).
      // Long-term removal tracked in AUDIT.md as FE-H2 (event delegation).
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://*.blob.vercel-storage.com"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false
}));

// ── Rate Limiting ─────────────────────────────────────────────
app.use(globalLimiter);

// ── CSRF ──────────────────────────────────────────────────────
app.use(csrfMiddleware);

// ── Compression ───────────────────────────────────────────────
app.use(loadCompression()({ level: 6, threshold: 1024 }));

// ── Body Parsers ──────────────────────────────────────────────
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// ── Sessions ──────────────────────────────────────────────────
app.use(loadCookieSession()({
  name: 'kage.session',
  secret: SESSION_SECRET,
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
  sameSite: 'lax'
}));

// ── Static Files ──────────────────────────────────────────────
// L4: one canonical admin entry — redirect /admin.html to /admin BEFORE the
// static middleware can serve it directly.
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.redirect(301, '/admin');
  next();
});
// Vendored assets are treated as version-pinned; changing one should include a
// filename bump so its one-year cache can remain immutable.
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), {
  maxAge: '365d',
  immutable: true,
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
}));

// These small public documents and the storefront shell use the same canonical
// origin configuration. Keep them no-store: CSRF middleware may set a cookie
// on a first GET, and an origin is expected to be configured before crawling.
app.get('/sitemap.xml', (req, res) => {
  const siteUrl = escapeXml(getSiteUrlForRequest(req));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${siteUrl}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`;
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/xml').send(sitemap);
});
app.get('/robots.txt', (req, res) => {
  const siteUrl = getSiteUrlForRequest(req);
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
});
app.get(['/', '/index.html'], (req, res) => sendStorefrontHtml(req, res));

app.use(express.static(path.join(__dirname, 'public'), {
  // HTML stays uncacheable so deployments take effect immediately. Replaceable
  // static files get one day of public caching and must revalidate with ETag or
  // Last-Modified before a stale copy is used.
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate')
}));

// ── Cache-Control for API ─────────────────────────────────────
app.use((req, res, next) => {
  const sessionVaryingApi = /^\/api\/(?:admin|customers)(?:\/|$)/.test(req.path);
  if (sessionVaryingApi || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (req.method === 'GET') {
    if (req.path === '/api/products' || /^\/api\/products\/\d+$/.test(req.path)) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    } else if (req.path === '/api/reviews') {
      res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120');
    }
  }
  next();
});

// ── Uploads directory (local dev) ─────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  try { require('fs').mkdirSync(uploadsDir, { recursive: true }); } catch (e) { /* serverless */ }
}

// ── Routes ────────────────────────────────────────────────────
const createAuthRoutes = require('./routes/auth');
const createProductRoutes = require('./routes/products');
const createOrderRoutes = require('./routes/orders');
const createReviewRoutes = require('./routes/reviews');
const createAdminRoutes = require('./routes/admin');

// Routes are registered after DB init below (see startServer)
// HTML fallback routes are also registered there (after API routes).

// ── Error Handler ─────────────────────────────────────────────
// Registered in ensureReady() AFTER all routes: Express only routes errors
// to handlers that sit later in the middleware stack, so an early registration
// let route errors (e.g. multer upload rejections) fall through to the
// default HTML stack-trace page instead of JSON.
function jsonErrorHandler(err, req, res, next) {
  console.error('Server error:', err);
  if (res.headersSent) return next(err);
  if (err instanceof loadMulter().MulterError) return res.status(400).json({ error: 'Upload error: ' + err.message });
  if (err.status) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: 'Internal server error.' });
}

// ── One-time data bootstrap ──────────────────────────────────────
// Each step is recorded in the DATABASE (app_settings) under a versioned key,
// so it runs at most once per database — not once per cold start. That is what
// stops a live shop from getting its deleted products back, its removed sales
// re-applied and its deliberate unit_cost = 0 overwritten on every deploy.
const BOOTSTRAP_KEYS = {
  products: 'seed_products_v1',
  categories: 'normalize_demo_categories_v1',
  salePrices: 'sync_seed_sale_prices_v1',
  unitCosts: 'backfill_unit_costs_v1',
  emails: 'normalize_emails_v1'
};
let _bootstrapDone = false;

// Run `step` unless `key` is already recorded. The key is written only after
// the step resolved, so a failure is retried on the next request instead of
// being silently skipped forever.
async function runOnce(key, step) {
  if (await db.getSetting(key)) return false;
  const value = await step();
  await db.setSetting(key, value == null ? new Date().toISOString() : String(value));
  return true;
}

// Brand-new databases get the demo catalogue; databases that already have
// products (i.e. every existing deployment upgrading to this change) only get
// the marker — never a single product or sale price.
async function seedProductsOnce() {
  const count = await db.prepare('SELECT COUNT(*) as c FROM products').get();
  const existing = count && count.c != null ? Number(count.c) : 0;
  if (existing > 0) {
    console.log(`ℹ️  ${existing} product(s) already in the database — demo seed recorded as done, nothing re-inserted`);
    return 'existing';
  }
  const { added } = await demoProducts.seedDemoProducts(db);
  console.log('✅ Seeded ' + added + ' default products');
  return 'seeded';
}

// Earlier demo seeds stored the regular graphic tees as `anime`, while the
// storefront routes Graphic Tees using the `graphic-tees` collection key.
// Correct only those legacy defaults; an admin's other category edits survive.
async function normalizeDemoCategoriesOnce() {
  let changed = 0;
  for (const fix of demoProducts.LEGACY_CATEGORY_FIXES) {
    const result = await db.prepare('UPDATE products SET category = ? WHERE name = ? AND category = ?')
      .run(fix.to, fix.name, fix.from);
    changed += Number(result && result.changes) || 0;
  }
  if (changed) {
    await db.save();
    console.log(`🗂️  Corrected ${changed} legacy demo product categor${changed === 1 ? 'y' : 'ies'}`);
  }
  return 'normalized:' + changed;
}

async function syncSeedSalePricesOnce() {
  const seedState = await db.getSetting(BOOTSTRAP_KEYS.products);
  if (!seedState) throw new Error('seed step has not completed yet'); // retried with it
  if (seedState === 'existing') {
    console.log('ℹ️  catalogue predates the settings table — sale prices left exactly as the admin set them');
    return 'skipped-existing';
  }
  let changed = 0;
  for (const s of demoProducts.SEED_SALE_SYNCS) {
    const row = await db.prepare('SELECT id FROM products WHERE name = ? AND price = ? AND sale_price IS NULL').get(s.name, s.price);
    if (row) { await db.prepare('UPDATE products SET sale_price = ?, on_sale = ? WHERE id = ?').run(s.sale, 1, row.id); changed++; }
  }
  if (changed > 0) { await db.save(); console.log('💸 Synced sale prices for ' + changed + ' seeded product(s)'); }
  return 'synced:' + changed;
}

// unit_cost IS NULL only — a deliberate 0 (freebie, promo, unknown-but-zero)
// must survive, so 0 is never treated as "missing".
async function backfillUnitCostsOnce() {
  const missing = await db.prepare('SELECT id, price FROM products WHERE unit_cost IS NULL').all();
  if (missing.length === 0) return 'none';
  for (const p of missing) { await db.prepare('UPDATE products SET unit_cost = ? WHERE id = ?').run(Math.max(50, Math.round(p.price * 0.55)), p.id); }
  await db.save();
  console.log('💰 Backfilled unit costs for ' + missing.length + ' product(s)');
  return 'backfilled:' + missing.length;
}

// Emails are compared case-insensitively everywhere, so legacy mixed-case rows
// are normalised once per database. Duplicate-safe: see database.js.
async function normalizeEmailsOnce() {
  const stats = await db.normalizeEmailsMigration();
  const touched = stats.orders + stats.customersMerged + stats.customersLowered + stats.newsletterMerged + stats.newsletterLowered;
  if (touched) console.log(`📧 Normalised email casing (${JSON.stringify(stats)})`);
  return JSON.stringify(stats);
}

// Returns true when every step is known-done (nothing left to retry).
async function bootstrapData() {
  let complete = true;
  for (const [key, step] of [
    [BOOTSTRAP_KEYS.products, seedProductsOnce],
    [BOOTSTRAP_KEYS.categories, normalizeDemoCategoriesOnce],
    [BOOTSTRAP_KEYS.salePrices, syncSeedSalePricesOnce],
    [BOOTSTRAP_KEYS.unitCosts, backfillUnitCostsOnce],
    [BOOTSTRAP_KEYS.emails, normalizeEmailsOnce]
  ]) {
    try {
      await runOnce(key, step);
    } catch (e) {
      complete = false;
      console.error(`${key} skipped:`, e.message);
    }
  }
  return complete;
}

// ── Start ─────────────────────────────────────────────────────
// Idempotent bootstrap: init DB → seed → register routes. Safe to call from
// local dev, Vercel serverless, and tests.
async function ensureReady() {
  try { await dbModule.init(); } catch (e) { console.error('⚠️  Database init failed:', e.message); throw e; }
  db = dbModule;

  // One-time-per-database steps (app_settings keys), retried on the next
  // request if a step fails. A failure here must not take the site down.
  if (!_bootstrapDone) {
    if (await bootstrapData()) _bootstrapDone = true;
  }

  // Register routes (guard so repeated invocations don't double-register)
  if (!app._kageRoutesRegistered) {
    app._kageRoutesRegistered = true;
    app.use(createAuthRoutes(db));
    app.use(createProductRoutes(db));
    app.use(createOrderRoutes(db));
    app.use(createReviewRoutes(db));
    app.use(createAdminRoutes(db));

    // HTML fallback routes (registered AFTER API routes)
    // L4: admin.html IS the login page, so it must stay publicly reachable;
    // the data APIs behind it are the real protection. /admin.html already
    // redirects to /admin above (before static), giving one canonical entry.
    app.get('/admin', (req, res) => {
      setHtmlNoStore(res);
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });
    const spaPages = new Set(['/', '/about', '/contact', '/tracking', '/shipping', '/returns', '/privacy', '/terms', '/account', '/checkout', '/confirmation', '/reset-password', '/verify-email', '/custom-stickers', '/coming-soon']);
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
      const known = spaPages.has(req.path) || /^\/product\/\d+$/.test(req.path) || /^\/collection\/[a-z0-9-]+$/.test(req.path);
      sendStorefrontHtml(req, res, known ? 200 : 404);
    });

    // Must sit AFTER the routes so route/middleware errors reach it as JSON
    // (upload-filter rejections, multer limits, etc.).
    app.use(jsonErrorHandler);
  }
}

// ── Readiness ─────────────────────────────────────────────────
// The boot promise is cached ONLY while it is pending or fulfilled. A failed
// attempt clears the cache so the next request retries — the old one-shot
// `const serverReady = ensureReady()` replayed one rejection for the entire life
// of a serverless instance (every request 503 until it was recycled) and, on
// Node 15+, that rejected promise was also an unhandled rejection at creation.
let readyPromise = null;   // pending or fulfilled boot attempt
let readyError = null;     // last failure (cleared on success)
let readyFailedAt = 0;     // when it failed — drives the retry backoff

function getReady() {
  if (readyPromise) return readyPromise;                 // pending or ready
  if (readyError && Date.now() - readyFailedAt < config.READY_RETRY_BACKOFF_MS) {
    // Inside the backoff window: report the known failure immediately instead
    // of running another doomed init against a database that is already down.
    const cached = Promise.reject(readyError);
    cached.catch(() => {});                              // never unhandled
    return cached;
  }
  const attempt = ensureReady().then(
    (value) => { readyError = null; return value; },
    (err) => {
      readyPromise = null;                               // allow a retry
      readyError = err;
      readyFailedAt = Date.now();
      throw err;
    }
  );
  attempt.catch(() => {});                               // never unhandled
  readyPromise = attempt;
  return attempt;
}

// Middleware used by the serverless entrypoint (and by the tests): wait for the
// boot, or answer a JSON 503 with Retry-After. The real error stays in the
// server log — the response carries no connection strings or stack traces.
function sendUnavailable(res) {
  const retryAfter = String(Math.max(1, Math.ceil(config.READY_RETRY_BACKOFF_MS / 1000)));
  const body = { error: 'Service temporarily unavailable — the server is still starting up. Please retry in a moment.' };
  if (res.headersSent) return;
  res.setHeader('Retry-After', retryAfter);
  // Express-style response when mounted in Express (Vercel, tests); plain
  // writeHead/end when this runs behind a bare http server. Either way the
  // failure path itself must never throw.
  if (typeof res.status === 'function') return res.status(503).json(body);
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': retryAfter });
  res.end(JSON.stringify(body));
}

function readinessGate(req, res, next) {
  return getReady().then(() => next(), (err) => {
    console.error('Server not ready:', err.message);
    try { sendUnavailable(res); } catch (e) { console.error('503 write failed:', e.message); }
  });
}

// Vercel serverless entrypoint
module.exports = (req, res) => {
  readinessGate(req, res, () => app(req, res));
};
module.exports.app = app;          // tests: boot your own listener
module.exports.ensureReady = ensureReady;
module.exports.getReady = getReady;         // tests: retry/backoff behaviour
module.exports.bootstrapData = bootstrapData; // tests: one-time-per-database steps
module.exports.readinessGate = readinessGate;

// Local dev / direct execution: listen and manage the process lifecycle.
if (require.main === module) {
  getReady().then(() => {
    const server = app.listen(PORT, () => {
      const mode = dbModule.USE_TURSO ? 'Turso (cloud)' : (dbModule.activeBackend === 'mem' ? 'in-memory' : 'sql.js (local)');
      console.log(`\n╔══════════════════════════════════════════════════╗\n║         KAGE CULTURE — Admin System              ║\n╠══════════════════════════════════════════════════╣\n║  Public site:  http://localhost:${PORT}              ║\n║  Admin panel:  http://localhost:${PORT}/admin       ║\n║  Database:     ${mode}                                ║\n╚══════════════════════════════════════════════════╝\n    `);
    });
    process.on('SIGTERM', () => { console.log('SIGTERM received — shutting down gracefully...'); server.close(() => { process.exit(0); }); setTimeout(() => process.exit(1), 5000); });
  }).catch(err => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

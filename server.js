// ================================================================
// KAGE CULTURE — Server entry point
// Wires up middleware, routes, and starts the server.
// Route logic lives in routes/*.js, middleware in middleware/*.js.
// ================================================================
const express = require('express');
const path = require('path');
const dbModule = require('./database');
const config = require('./config');
const { globalLimiter } = require('./middleware/rateLimit');
const { csrfMiddleware } = require('./middleware/csrf');
const { requireAuth } = require('./middleware/auth');

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
// bucket — the 120/min global limit could knock the whole site over.
app.set('trust proxy', 1);

// Session secret — REQUIRED in production
if ((process.env.VERCEL || process.env.NODE_ENV === 'production') && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'kage-dev-secret-not-for-production';

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
app.use(express.static(path.join(__dirname, 'public'), {
  // M7: HTML stays uncacheable (fresh deployments must show immediately);
  // everything else (images, fonts, icons) is fingerprint-free but stable, so
  // clients may reuse it for a year with must-revalidate as a safety net.
  maxAge: '365d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));

// ── Cache-Control for API ─────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'GET') {
    if (req.path === '/api/products' || req.path === '/api/products/:id') res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    else if (req.path === '/api/reviews') res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120');
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) res.setHeader('Cache-Control', 'no-store');
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

// ── Seed & Migrate (runs once per cold start) ────────────────────
let _initialized = false;

async function backfillUnitCosts() {
  const missing = await db.prepare('SELECT id, price FROM products WHERE unit_cost IS NULL OR unit_cost = 0').all();
  if (missing.length === 0) return;
  for (const p of missing) { await db.prepare('UPDATE products SET unit_cost = ? WHERE id = ?').run(Math.max(50, Math.round(p.price * 0.55)), p.id); }
  await db.save(); console.log('💰 Backfilled unit costs for ' + missing.length + ' product(s)');
}

async function syncSeedSalePrices() {
  const syncs = [{ name: 'Rising Vermillion', price: 999, sale: 799 }, { name: 'Wrath Silhouette', price: 1249, sale: 1099 }];
  let changed = 0;
  for (const s of syncs) { const row = await db.prepare('SELECT id FROM products WHERE name = ? AND price = ? AND sale_price IS NULL').get(s.name, s.price); if (row) { await db.prepare('UPDATE products SET sale_price = ?, on_sale = ? WHERE id = ?').run(s.sale, 1, row.id); changed++; } }
  if (changed > 0) { await db.save(); console.log('💸 Synced sale prices for ' + changed + ' seeded product(s)'); }
}

async function seedProducts() {
  const count = await db.prepare('SELECT COUNT(*) as c FROM products').get();
  if (!count || (count.c != null && count.c > 0)) return;
  const defaults = [
    { name: 'Shadow Fit', price: 1499, cost: 820, stock: 4, category: 'anime', fit: 'Compression', size: 'L', desc: '4-way stretch muscle-fit compression shirt.' },
    { name: 'Oni Muscle Tee', price: 1599, cost: 875, stock: 8, category: 'anime', fit: 'Compression', size: 'XL', desc: 'Sleeveless compression with bold contrast panels.' },
    { name: 'Kage Core Compression', price: 1399, cost: 760, stock: 12, category: 'anime', fit: 'Compression', size: 'M', desc: 'Core compression layer — seamless, breathable.' },
    { name: 'Rising Vermillion', price: 999, sale: 799, cost: 545, stock: 3, category: 'anime', fit: 'Regular', size: 'XL', desc: 'Heavyweight 220GSM cotton tee.' },
    { name: 'Blade Wolf', price: 1149, cost: 620, stock: 10, category: 'anime', fit: 'Regular', size: 'L', desc: 'Silver ink on black — a lone wolf under a crescent moon.' },
    { name: 'Neon Fangs', price: 1049, cost: 570, stock: 6, category: 'anime', fit: 'Regular', size: 'M', desc: 'Electric strike — neon clash across heavyweight cotton.' },
    { name: 'Shinobi Mark', price: 999, cost: 540, stock: 15, category: 'anime', fit: 'Regular', size: 'S', desc: 'Minimalist shinobi crest.' },
    { name: 'Drift Oversized', price: 1199, cost: 650, stock: 5, category: 'streetwear', fit: 'Oversized', size: 'XL', desc: 'Drop-shoulder, relaxed fit.' },
    { name: 'Wrath Silhouette', price: 1249, sale: 1099, cost: 680, stock: 7, category: 'streetwear', fit: 'Oversized', size: 'L', desc: 'Boxy, cropped oversized fit.' },
    { name: 'Hollow Gaze', price: 1149, cost: 625, stock: 9, category: 'streetwear', fit: 'Oversized', size: 'XXL', desc: 'Extended drop-shoulder with raw hem.' },
    { name: 'Skeleton Vibes', price: 250, cost: 80, stock: 20, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'Premium vinyl sticker.' },
    { name: 'Frog Energy', price: 250, cost: 80, stock: 25, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'Just a frog vibing.' },
    { name: 'Pizza Lover', price: 250, cost: 80, stock: 18, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'High-quality vinyl.' },
    { name: 'Melting', price: 250, cost: 80, stock: 0, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'Not yet in stock.' },
    { name: 'Alien Sightings', price: 250, cost: 80, stock: 15, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'Peel-proof vinyl.' },
    { name: 'Robo Bro', price: 250, cost: 80, stock: 0, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'Coming soon.' },
    { name: 'Banana Flex', price: 250, cost: 80, stock: 22, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'Premium vinyl.' },
    { name: 'Duck Off', price: 250, cost: 80, stock: 12, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'High-quality vinyl sticker.' },
    { name: 'All-Seeing Eye', price: 300, cost: 100, stock: 0, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'Coming soon.' },
    { name: 'Cheese God', price: 250, cost: 80, stock: 10, category: 'goofy-wears', fit: 'Sticker', size: 'One Size', desc: 'Peel-proof, rain-proof.' }
  ];
  const insert = await db.prepare('INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, unit_cost, stock_qty, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  for (const p of defaults) {
    const exists = await db.prepare('SELECT id FROM products WHERE name = ?').get(p.name);
    if (exists) continue;
    await insert.run([p.name, p.category, p.fit, p.price, p.sale || null, p.sale ? 1 : 0, p.desc, JSON.stringify([p.size || 'L']), p.cost, p.stock, p.stock > 0 ? 1 : 0]);
    added++;
  }
  await db.save();
  if (added > 0) console.log('✅ Seeded ' + added + ' default products');
}

// ── Start ─────────────────────────────────────────────────────
// Idempotent bootstrap: init DB → seed → register routes. Safe to call from
// local dev, Vercel serverless, and tests.
async function ensureReady() {
  try { await dbModule.init(); } catch (e) { console.error('⚠️  Database init failed:', e.message); throw e; }
  db = dbModule;

  // Seed & migrate only once per cold start
  if (!_initialized) {
    _initialized = true;
    try { await seedProducts(); } catch (e) { console.error('seedProducts skipped:', e.message); }
    try { await backfillUnitCosts(); } catch (e) { console.error('backfillUnitCosts skipped:', e.message); }
    try { await syncSeedSalePrices(); } catch (e) { console.error('syncSeedSalePrices skipped:', e.message); }
  }

  // Register routes (guard so repeated invocations don't double-register)
  if (!app._kageRoutesRegistered) {
    app._kageRoutesRegistered = true;
    app.use(createAuthRoutes(db, SESSION_SECRET));
    app.use(createProductRoutes(db));
    app.use(createOrderRoutes(db));
    app.use(createReviewRoutes(db));
    app.use(createAdminRoutes(db));

    // HTML fallback routes (registered AFTER API routes)
    // L4: admin.html IS the login page, so it must stay publicly reachable;
    // the data APIs behind it are the real protection. /admin.html already
    // redirects to /admin above (before static), giving one canonical entry.
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
    const spaPages = new Set(['/', '/about', '/contact', '/tracking', '/shipping', '/returns', '/privacy', '/terms', '/account', '/checkout', '/confirmation', '/reset-password', '/kage-clothes', '/custom-stickers']);
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
      const known = spaPages.has(req.path) || /^\/product\/\d+$/.test(req.path) || /^\/collection\/[a-z0-9-]+$/.test(req.path);
      res.status(known ? 200 : 404).sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // Must sit AFTER the routes so route/middleware errors reach it as JSON
    // (upload-filter rejections, multer limits, etc.).
    app.use(jsonErrorHandler);
  }
}

const serverReady = ensureReady();

// Vercel serverless entrypoint
module.exports = async (req, res) => {
  try {
    await serverReady;
    return app(req, res);
  } catch (err) {
    // H2: fail loudly — if boot failed (e.g. Vercel without Turso) say so
    // instead of silently serving a data-loss in-memory DB.
    console.error('Server not ready:', err.message);
    if (!res.headersSent) res.status(503).json({ error: 'Server boot failed: ' + err.message });
  }
};
module.exports.app = app;          // tests: boot your own listener
module.exports.ensureReady = ensureReady;

// Local dev / direct execution: listen and manage the process lifecycle.
if (require.main === module) {
  serverReady.then(() => {
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

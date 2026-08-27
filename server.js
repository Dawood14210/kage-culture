// ================================================================
// KAGE CULTURE — Server entry point
// Wires up middleware, routes, and starts the server.
// Route logic lives in routes/*.js, middleware in middleware/*.js.
// ================================================================
const express = require('express');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const multer = require('multer');
const dbModule = require('./database');
const config = require('./config');
const { globalLimiter } = require('./middleware/rateLimit');
const { csrfMiddleware } = require('./middleware/csrf');
const { requireAuth } = require('./middleware/auth');

let db = dbModule;

const app = express();
const PORT = process.env.PORT || 3000;

// Session secret — REQUIRED in production
if ((process.env.VERCEL || process.env.NODE_ENV === 'production') && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'kage-dev-secret-not-for-production';

// ── Security Headers ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
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
app.use(compression({ level: 6, threshold: 1024 }));

// ── Body Parsers ──────────────────────────────────────────────
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// ── Sessions ──────────────────────────────────────────────────
app.use(cookieSession({
  name: 'kage.session',
  secret: SESSION_SECRET,
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
  sameSite: 'lax'
}));

// ── Static Files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true, lastModified: true }));
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
const createSpinRoutes = require('./routes/spin');
const createAdminRoutes = require('./routes/admin');

// Routes are registered after DB init below (see startServer)
// HTML fallback routes are also registered there (after API routes).

// ── Error Handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Upload error: ' + err.message });
  if (err.status) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Seed & Migrate ────────────────────────────────────────────
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
    await insert.run([p.name, p.category, p.fit, p.price, p.sale || null, p.sale ? 1 : 0, p.desc, JSON.stringify([p.size || 'L']), p.cost, p.stock, 1]);
    added++;
  }
  await db.save();
  if (added > 0) console.log('✅ Seeded ' + added + ' default products');
}

// ── Start ─────────────────────────────────────────────────────
async function startServer() {
  try { await dbModule.init(); db = dbModule; } catch (e) { console.error('⚠️  Database init failed:', e.message); db = dbModule; }
  try { await seedProducts(); } catch (e) { console.error('seedProducts skipped:', e.message); }
  try { await backfillUnitCosts(); } catch (e) { console.error('backfillUnitCosts skipped:', e.message); }
  try { await syncSeedSalePrices(); } catch (e) { console.error('syncSeedSalePrices skipped:', e.message); }

  // Register routes with DB reference
  app.use(createAuthRoutes(db, SESSION_SECRET));
  app.use(createProductRoutes(db));
  app.use(createOrderRoutes(db));
  app.use(createReviewRoutes(db));
  app.use(createSpinRoutes(db));
  app.use(createAdminRoutes(db));

  // HTML fallback routes (registered AFTER API routes)
  app.get('/admin', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  app.get('/admin/*', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  if (!process.env.VERCEL) {
    const server = app.listen(PORT, () => {
      const mode = dbModule.USE_TURSO ? 'Turso (cloud)' : 'sql.js (local file)';
      console.log(`\n╔══════════════════════════════════════════════════╗\n║         KAGE CULTURE — Admin System              ║\n╠══════════════════════════════════════════════════╣\n║  Public site:  http://localhost:${PORT}              ║\n║  Admin panel:  http://localhost:${PORT}/admin       ║\n║  Database:     ${mode}                                ║\n╚══════════════════════════════════════════════════╝\n    `);
    });
    process.on('SIGTERM', () => { console.log('SIGTERM received — shutting down gracefully...'); server.close(() => { process.exit(0); }); setTimeout(() => process.exit(1), 5000); });
  }
}

const serverReady = startServer().catch(err => { console.error('Failed to start server:', err); throw err; });

module.exports = async (req, res) => {
  try { await serverReady; return app(req, res); } catch (err) { console.error('Server not ready:', err.message); if (!res.headersSent) return res.status(500).json({ error: 'Server not ready yet. Please retry.' }); }
};

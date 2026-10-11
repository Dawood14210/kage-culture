// ================================================================
// KAGE Culture — Admin stats, upload, newsletter, clan, coming-soon routes
// ================================================================
const express = require('express');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth } = require('../middleware/auth');
const { persistImage } = require('../utils/helpers');
const productShape = require('../utils/productShape');
const sizeStock = require('../utils/sizes');

// SECURITY: without fileFilter, /api/upload accepted ANY file (e.g. .html/.js
// payloads served from /uploads). Same image-only filter as products routes.
const IMAGE_FILE_FILTER = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp|svg/;
  if (allowed.test(path.extname(file.originalname || '').toLowerCase()) && allowed.test(file.mimetype)) cb(null, true);
  else { const err = new Error('Only image files (JPEG, PNG, GIF, WebP, SVG) are allowed'); err.status = 400; cb(err); }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: IMAGE_FILE_FILTER
});

const demoProducts = require('../utils/demoProducts');

module.exports = function createAdminRoutes(db) {
  const router = express.Router();
  const LOW_STOCK_THRESHOLD = config.LOW_STOCK_THRESHOLD;

  // --- Products (admin) ---
  // The public catalog deliberately omits internal columns (unit_cost drives
  // the P&L and must stay private). The panel reads the full shape from here
  // instead — requireAuth only; GETs carry no CSRF token.
  router.get('/api/admin/products', requireAuth, async (req, res) => {
    try {
      const products = await db.prepare(`SELECT ${productShape.ADMIN_PRODUCT_SELECT} FROM products ORDER BY created_at DESC, id DESC`).all();
      const sold = await productShape.getSoldCounts(db);
      const revAgg = await productShape.loadReviewAggregates(db);
      const sizeStockById = await sizeStock.loadAllSizeStock(db);
      res.json(products.map(p => productShape.shapeAdminProduct(p, {
        size_stock: sizeStockById.get(Number(p.id)) || null,
        sold_count: sold.get(Number(p.id)) || 0,
        order_count: sold.get(Number(p.id)) || 0, // unchanged: mirrors sold_count
        ...productShape.ratingFields(revAgg.get(Number(p.id)))
      })));
    } catch (err) {
      console.error('admin products route failed:', err && err.message ? err.message : err);
      res.status(500).json({ error: 'Something went wrong loading products.' });
    }
  });

  router.get('/api/admin/products/:id', requireAuth, async (req, res) => {
    try {
      const p = await db.prepare(`SELECT ${productShape.ADMIN_PRODUCT_SELECT} FROM products WHERE id = ?`).get(req.params.id);
      if (!p) return res.status(404).json({ error: 'Product not found' });
      const sold = await productShape.getSoldCounts(db);
      const revAgg = await productShape.loadReviewAggregates(db);
      res.json(productShape.shapeAdminProduct(p, {
        size_stock: await sizeStock.loadSizeStock(db, p.id),
        sold_count: sold.get(Number(p.id)) || 0,
        order_count: sold.get(Number(p.id)) || 0, // unchanged: mirrors sold_count
        ...productShape.ratingFields(revAgg.get(Number(p.id)))
      }));
    } catch (err) {
      console.error('admin products route failed:', err && err.message ? err.message : err);
      res.status(500).json({ error: 'Something went wrong loading the product.' });
    }
  });

  // --- Dashboard stats ---
  router.get('/api/admin/stats/dashboard', requireAuth, async (req, res) => {
    try {
      const prodCount = (await db.prepare('SELECT COUNT(*) as c FROM products').get()).c;
      const orderCount = (await db.prepare('SELECT COUNT(*) as c FROM orders').get()).c;
      // Cancelled orders are not revenue — exclude them so the dashboard card
      // matches reality (it previously counted refunds as sales).
      const revenue = (await db.prepare("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE status != ?").get('cancelled')).s;
      const pendingOrders = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get()).c;
      const deliveredOrders = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'delivered'").get()).c;
      const outOfStock = (await db.prepare('SELECT COUNT(*) as c FROM products WHERE in_stock = 0').get()).c;
      const lowStockCount = (await db.prepare('SELECT COUNT(*) as c FROM products WHERE stock_qty IS NOT NULL AND stock_qty > 0 AND stock_qty < ?').get(LOW_STOCK_THRESHOLD)).c;
      const recentOrders = (await db.prepare('SELECT id, order_number, customer_name, total, status, created_at FROM orders ORDER BY created_at DESC, id DESC LIMIT 10').all());
      res.json({ products: prodCount, orders: orderCount, revenue: Math.round(revenue), pendingOrders, deliveredOrders, outOfStock, lowStockCount, lowStockThreshold: LOW_STOCK_THRESHOLD, recentOrders });
    } catch (err) { console.error('admin route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Sales summary ---
  router.get('/api/admin/stats/sales', requireAuth, async (req, res) => {
    try {
      const now = new Date();
      // Boundaries MUST use the same 'YYYY-MM-DD HH:MM:SS' format as the stored
      // created_at column (ISO 'T'/'Z' strings compared lexicographically against
      // space-separated ones drop every row on the boundary date — Revenue Today
      // was permanently 0). Boundaries are the UTC instant of the local day/week/
      // month start, formatted to match storage. Week starts Monday, matching the
      // P&L weekly buckets.
      const toTs = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
      const todayStart = toTs(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
      const weekStart = toTs(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() || 7) - 1)));
      const monthStart = toTs(new Date(now.getFullYear(), now.getMonth(), 1));
      const revToday = (await db.prepare("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE status != ? AND created_at >= ?").get('cancelled', todayStart)).s;
      const revWeek = (await db.prepare("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE status != ? AND created_at >= ?").get('cancelled', weekStart)).s;
      const revMonth = (await db.prepare("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE status != ? AND created_at >= ?").get('cancelled', monthStart)).s;
      const statusCounts = (await db.prepare('SELECT status, COUNT(*) as c FROM orders GROUP BY status').all());
      const byStatus = {}; statusCounts.forEach(r => { byStatus[r.status] = r.c; });
      const allOrders = (await db.prepare('SELECT items_json FROM orders WHERE status != ?').all('cancelled'));
      const unitMap = {};
      for (const o of allOrders) { let items = []; try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; } for (const it of items) { unitMap[it.id] = (unitMap[it.id] || 0) + (Number(it.qty) || 1); } }
      let bestProduct = null; let bestUnits = 0;
      for (const [pid, units] of Object.entries(unitMap)) { if (units > bestUnits) { bestUnits = units; const p = await db.prepare('SELECT id, name FROM products WHERE id = ?').get(Number(pid)); bestProduct = p ? p.name : ('Product #' + pid); } }
      res.json({ revenueToday: Math.round(revToday), revenueWeek: Math.round(revWeek), revenueMonth: Math.round(revMonth), ordersByStatus: byStatus, bestProduct: bestProduct ? { name: bestProduct, units: bestUnits } : null });
    } catch (err) { console.error('admin route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- P&L stats ---
  router.get('/api/admin/stats/pnl', requireAuth, async (req, res) => {
    try {
      const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'daily';
      // Cancelled orders must not contribute revenue, cost or profit.
      const orders = await db.prepare("SELECT total, created_at, items_json FROM orders WHERE status != ? ORDER BY created_at ASC, id ASC").all('cancelled');
      const pad = (n) => String(n).padStart(2, '0');
      const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const monthKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1);
      const parseTs = (ts) => new Date(String(ts || '').replace('T', ' ').replace(/-/g, '/'));
      const buckets = []; const now = new Date();
      if (period === 'daily') { for (let i = 13; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); buckets.push({ key: dayKey(d), label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), revenue: 0, cost: 0, profit: 0 }); } }
      else if (period === 'weekly') { for (let i = 11; i >= 0; i--) { const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() || 7) + 1 + 6 - i * 7); const start = new Date(end); start.setDate(end.getDate() - 6); buckets.push({ key: dayKey(start), label: start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' – ' + end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), revenue: 0, cost: 0, profit: 0 }); } }
      else { for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); buckets.push({ key: monthKey(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), revenue: 0, cost: 0, profit: 0 }); } }
      const bucketFor = (ts) => { const d = parseTs(ts); if (isNaN(d.getTime())) return null; if (period === 'daily') return dayKey(d); if (period === 'weekly') { const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() || 7) - 1)); return dayKey(monday); } return monthKey(d); };
      // Pre-fetch all product costs for legacy order items
      const allProducts = await db.prepare('SELECT id, unit_cost, price, sale_price FROM products').all();
      const productCostMap = {}; for (const p of allProducts) { productCostMap[p.id] = p; }
      let bucketedOrders = 0;
      for (const o of orders) {
        const items = JSON.parse(o.items_json || '[]'); let cost = 0;
        for (const it of items) {
          if (it.cost) { cost += it.cost; continue; }
          const p = it.id ? productCostMap[it.id] : null;
          const unit = (p && p.sale_price && p.sale_price < p.price) ? p.sale_price : (p ? p.price : null);
          const unitCost = (p && p.unit_cost && p.unit_cost > 0) ? p.unit_cost : (unit ? Math.round(unit * 0.55) : 0);
          cost += unitCost * (it.qty || 1);
        }
        const revenue = o.total; const profit = revenue - cost;
        const bk = buckets.find(b => b.key === bucketFor(o.created_at));
        if (bk) { bk.revenue += revenue; bk.cost += cost; bk.profit += profit; bucketedOrders++; }
      }
      const totals = buckets.reduce((acc, b) => { acc.revenue += b.revenue; acc.cost += b.cost; acc.profit += b.profit; return acc; }, { revenue: 0, cost: 0, profit: 0 });
      res.json({ period, labels: buckets.map(b => b.label), revenue: buckets.map(b => Math.round(b.revenue)), cost: buckets.map(b => Math.round(b.cost)), profit: buckets.map(b => Math.round(b.profit)), summary: { revenue: Math.round(totals.revenue), cost: Math.round(totals.cost), profit: Math.round(totals.profit), orders: bucketedOrders } });
    } catch (err) { console.error('admin route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Image upload (standalone) ---
  router.post('/api/upload', requireCsrf, requireAuth, upload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      const url = await persistImage(req.file.buffer, req.file.originalname); res.json({ url });
    } catch (err) {
      console.error('upload failed:', err && err.message ? err.message : err);
      if (err && err.publicMessage) return res.status(err.status || 500).json({ error: err.publicMessage, code: err.code });
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  // --- Newsletter ---
  router.post('/api/newsletter', requireCsrf, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Please provide a valid email address.' });
      const clean = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return res.status(400).json({ error: 'Please provide a valid email address.' });
      const existing = await db.prepare('SELECT id FROM newsletter_subscribers WHERE LOWER(TRIM(email)) = ?').get(clean);
      if (existing) return res.json({ success: true, message: 'You are already subscribed!' });
      await db.prepare('INSERT INTO newsletter_subscribers (email) VALUES (?)').run(clean);
      res.json({ success: true, message: 'Welcome to the clan!' });
    } catch (err) { res.status(500).json({ error: 'Something went wrong.' }); }
  });

  // --- KAGE Clan join ---
  router.post('/api/clan-join', requireCsrf, async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Please provide a valid email address.' });
      const clean = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return res.status(400).json({ error: 'Please provide a valid email address.' });
      const allOrders = await db.prepare('SELECT items_json FROM orders WHERE LOWER(TRIM(email)) = ?').all(clean);
      let totalShirts = 0;
      for (const o of allOrders) { const items = JSON.parse(o.items_json || '[]'); for (const it of items) { totalShirts += (it.qty || 0); } }
      if (totalShirts < config.CLAN_THRESHOLD) return res.status(403).json({ error: `You need to order at least ${config.CLAN_THRESHOLD} shirts to join the KAGE Clan.` });
      const existing = await db.prepare('SELECT id FROM newsletter_subscribers WHERE LOWER(TRIM(email)) = ?').get(clean);
      if (!existing) await db.prepare('INSERT INTO newsletter_subscribers (email) VALUES (?)').run(clean);
      res.json({ success: true, message: 'Welcome to the KAGE Clan!', total_shirts: totalShirts });
    } catch (err) { res.status(500).json({ error: 'Something went wrong.' }); }
  });

  // --- Coming soon notify-me ---
  router.post('/api/coming-soon', requireCsrf, async (req, res) => {
    try {
      const { email, category } = req.body || {};
      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Please provide a valid email address.' });
      const clean = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return res.status(400).json({ error: 'Please provide a valid email address.' });
      const cat = typeof category === 'string' ? category.trim().toLowerCase() : '';
      const allowed = ['graphic-tees', 'compression', 'oversized', 'sale', 'kage-bear-series', 'kage-white-tiger-series', 'kage-black-panther-series', 'kage-white-fox-series', 'custom-design-it-yourself', 'custom-kage-designs', 'custom-sticker-packs'];
      if (!allowed.includes(cat)) return res.status(400).json({ error: 'Unknown collection.' });
      const existing = await db.prepare('SELECT id FROM coming_soon_signups WHERE LOWER(TRIM(email)) = ? AND category = ?').get(clean, cat);
      if (existing) return res.json({ success: true, message: "You're on the list!" });
      await db.prepare('INSERT INTO coming_soon_signups (email, category) VALUES (?, ?)').run(clean, cat);
      res.json({ success: true, message: "You're on the list!" });
    } catch (err) { res.status(500).json({ error: 'Something went wrong.' }); }
  });

  // --- Health check ---
  // POST /api/admin/seed-demo — load the demo catalogue on purpose.
  // The launch products are seeded once per database (see BOOTSTRAP_KEYS in
  // server.js); if the shop deleted them, this is the deliberate way back.
  // Products already present (matched by name) are skipped, never duplicated.
  router.post('/api/admin/seed-demo', requireCsrf, requireAuth, async (req, res) => {
    try {
      const { added, skipped } = await demoProducts.seedDemoProducts(db);
      const total = await db.prepare('SELECT COUNT(*) as c FROM products').get();
      res.json({ success: true, added, skipped, products: total ? Number(total.c) : 0 });
    } catch (err) {
      console.error('seed-demo failed:', err && err.message ? err.message : err);
      res.status(500).json({ error: 'Could not load the demo products. Please try again.' });
    }
  });

  router.get('/api/health', async (req, res) => {
    try { await db.prepare('SELECT 1 as ok').get(); res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() }); } catch (err) { res.status(503).json({ status: 'error', error: 'Database unavailable.', uptime: process.uptime() }); }
  });

  return router;
};

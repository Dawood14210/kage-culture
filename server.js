const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dbModule = require('./database');
let db = dbModule;

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------
// MIDDLEWARE
// ----------------------------------------------------------------
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// Stateless sessions (cookie-session): the adminId travels in a signed
// cookie, so it survives serverless cold starts and multi-instance
// requests — MemoryStore would forget the login constantly on Vercel.
app.use(cookieSession({
  name: 'kage.session',
  secret: process.env.SESSION_SECRET || 'kage-culture-secret-key-change-in-production',
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
  sameSite: 'lax'
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists (local dev path only — on Vercel the
// serverless filesystem is read-only outside /tmp and Blob mode is used,
// so a throw here would take the whole function down).
const uploadsDir = path.join(__dirname, 'uploads');
if (!process.env.BLOB_READ_WRITE_TOKEN && !fs.existsSync(uploadsDir)) {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (e) {
    // Read-only filesystem (e.g. serverless) — Blob mode handles uploads.
  }
}

// Multer — memory storage so files can be forwarded to Vercel Blob
// (serverless has no writable disk) or written locally in dev.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB limit
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|svg/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    if (extOk && mimeOk) {
      cb(null, true);
    } else {
      const err = new Error('Only image files (JPEG, PNG, GIF, WebP, SVG) are allowed');
      err.status = 400;
      cb(err);
    }
  }
});

// ----------------------------------------------------------------
// IMAGE STORAGE HELPERS (Vercel Blob ↔ local disk)
// ----------------------------------------------------------------
const BLOB_ENABLED = !!process.env.BLOB_READ_WRITE_TOKEN;

async function persistImage(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.webp';
  if (BLOB_ENABLED) {
    const { put } = require('@vercel/blob');
    const key = `kage/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const blob = await put(key, buffer, { access: 'public' });
    return blob.url; // e.g. https://xxx.public.blob.vercel-storage.com/kage/...
  }
  const filename = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return '/uploads/' + filename;
}

async function removeImage(url) {
  if (!url) return;
  if (BLOB_ENABLED && /^https?:\/\//.test(url)) {
    const { del } = require('@vercel/blob');
    try { await del(url); } catch (e) { /* already gone */ }
    return;
  }
  const p = path.join(__dirname, url);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ----------------------------------------------------------------
// AUTH MIDDLEWARE
// ----------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
}

// ----------------------------------------------------------------
// ADMIN SETUP (first-run)
// ----------------------------------------------------------------
app.post('/api/admin/setup', async (req, res) => {
  try {
    const existing = await db.prepare('SELECT id FROM admin LIMIT 1').get();
    if (existing) {
      return res.status(400).json({ error: 'Admin account already exists. Use /api/admin/login instead.' });
    }
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const hash = await bcrypt.hash(password, 12);
    await db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?)').run(email, hash);
    res.json({ success: true, message: 'Admin account created.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// LOGIN
// ----------------------------------------------------------------
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    let admin = await db.prepare('SELECT * FROM admin WHERE email = ?').get(email);

    // Auto-create admin on first login (needed for serverless in-memory DBs
    // where data resets between cold starts).
    if (!admin && password.length >= 6) {
      const hash = await bcrypt.hash(password, 12);
      const result = await db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?)').run([email, hash]);
      admin = { id: result.lastInsertRowid, email, password_hash: hash };
      console.log('✅ Auto-created admin:', email);
    }

    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    req.session.adminId = admin.id;
    res.json({ success: true, admin: { email: admin.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// CHECK AUTH / LOGOUT
// ----------------------------------------------------------------
app.get('/api/admin/me', requireAuth, async (req, res) => {
  const admin = await db.prepare('SELECT id, email, created_at FROM admin WHERE id = ?').get(req.session.adminId);
  res.json({ admin });
});

app.post('/api/admin/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// ----------------------------------------------------------------
// CREATE NEW ADMIN (admin only)
// ----------------------------------------------------------------
app.post('/api/admin/create', requireAuth, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const existing = await db.prepare('SELECT id FROM admin WHERE email = ?').get(email);
    if (existing) {
      return res.status(400).json({ error: 'An admin with that email already exists.' });
    }
    const hash = await bcrypt.hash(password, 12);
    await db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?)').run(email, hash);
    res.json({ success: true, message: 'Admin account created.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// PRODUCT CRUD
// ----------------------------------------------------------------

// GET all products (public)
app.get('/api/products', async (req, res) => {
  try {
    const products = await db.prepare('SELECT * FROM products ORDER BY created_at DESC, id DESC').all();
    const parsed = products.map(p => ({
      ...p,
      sizes: JSON.parse(p.sizes || '["S","M","L","XL","XXL"]'),
      extra_images: JSON.parse(p.extra_images || '[]'),
      collections: JSON.parse(p.collections || '[]'),
      on_sale: Boolean(p.on_sale),
      in_stock: Boolean(p.in_stock)
    }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single product (public)
app.get('/api/products/:id', async (req, res) => {
  try {
    const p = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    p.sizes = JSON.parse(p.sizes || '["S","M","L","XL","XXL"]');
    p.extra_images = JSON.parse(p.extra_images || '[]');
    p.collections = JSON.parse(p.collections || '[]');
    p.on_sale = Boolean(p.on_sale);
    p.in_stock = Boolean(p.in_stock);
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create product (admin only)
app.post('/api/products', requireAuth, upload.fields([
  { name: 'front_image', maxCount: 1 },
  { name: 'back_image', maxCount: 1 },
  { name: 'extra_images', maxCount: 4 }
]), async (req, res) => {
  try {
    const { name, category, fit, price, sale_price, description, sizes, in_stock } = req.body;
    if (!name || !category || !price) {
      return res.status(400).json({ error: 'Name, category, and price are required.' });
    }

    const frontImage = req.files?.front_image?.[0]
      ? await persistImage(req.files.front_image[0].buffer, req.files.front_image[0].originalname)
      : null;
    const backImage = req.files?.back_image?.[0]
      ? await persistImage(req.files.back_image[0].buffer, req.files.back_image[0].originalname)
      : null;
    const extraImages = [];
    if (req.files?.extra_images) {
      for (const f of req.files.extra_images) {
        extraImages.push(await persistImage(f.buffer, f.originalname));
      }
    }

    const sizesArr = sizes || JSON.stringify(['S', 'M', 'L', 'XL', 'XXL']);
    const salePriceVal = sale_price || null;
    const onSale = sale_price ? 1 : 0;
    const inStock = in_stock !== undefined ? (in_stock === 'true' || in_stock === true ? 1 : 0) : 1;

    // New products get an estimated unit cost immediately (55% of list price)
    // so P&L is accurate even before the admin fine-tunes it in the edit form.
    const estCost = Math.max(50, Math.round(parseFloat(price) * 0.55));

    const result = await db.prepare(`
      INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, front_image, back_image, extra_images, in_stock, unit_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, category, fit || '', parseFloat(price), salePriceVal, onSale, description || '',
      JSON.stringify(Array.isArray(sizesArr) ? sizesArr : JSON.parse(sizesArr)),
      frontImage, backImage, JSON.stringify(extraImages), inStock, estCost);

    const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    product.sizes = JSON.parse(product.sizes || '[]');
    product.extra_images = JSON.parse(product.extra_images || '[]');
    product.collections = JSON.parse(product.collections || '[]');
    product.on_sale = Boolean(product.on_sale);
    product.in_stock = Boolean(product.in_stock);

    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update product (admin only)
app.put('/api/products/:id', requireAuth, upload.fields([
  { name: 'front_image', maxCount: 1 },
  { name: 'back_image', maxCount: 1 },
  { name: 'extra_images', maxCount: 4 }
]), async (req, res) => {
  try {
    const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });

    const { name, category, fit, price, sale_price, description, sizes, in_stock, unit_cost, remove_front, remove_back } = req.body;

    let frontImage = existing.front_image;
    let backImage = existing.back_image;

    if (req.files?.front_image?.[0]) {
      const newUrl = await persistImage(req.files.front_image[0].buffer, req.files.front_image[0].originalname);
      if (existing.front_image) await removeImage(existing.front_image);
      frontImage = newUrl;
    } else if (remove_front === 'true') {
      if (existing.front_image) await removeImage(existing.front_image);
      frontImage = null;
    }

    if (req.files?.back_image?.[0]) {
      const newUrl = await persistImage(req.files.back_image[0].buffer, req.files.back_image[0].originalname);
      if (existing.back_image) await removeImage(existing.back_image);
      backImage = newUrl;
    } else if (remove_back === 'true') {
      if (existing.back_image) await removeImage(existing.back_image);
      backImage = null;
    }

    let extraImages = [];
    try { extraImages = JSON.parse(existing.extra_images || '[]'); } catch (e) { extraImages = []; }
    if (req.files?.extra_images) {
      for (const f of req.files.extra_images) {
        extraImages.push(await persistImage(f.buffer, f.originalname));
      }
    }

    const sizesArr = sizes || existing.sizes;
    const salePriceVal = sale_price !== undefined ? sale_price : existing.sale_price;
    const onSale = sale_price ? 1 : 0;
    const finalName = name || existing.name;
    const finalCategory = category || existing.category;
    const finalFit = fit !== undefined ? fit : existing.fit;
    const finalPrice = price !== undefined ? parseFloat(price) : existing.price;
    const finalDesc = description !== undefined ? description : existing.description;
    const finalInStock = in_stock !== undefined ? (in_stock === 'true' || in_stock === true ? 1 : 0) : existing.in_stock;
    const finalUnitCost = unit_cost !== undefined && unit_cost !== '' ? Math.max(0, parseFloat(unit_cost) || 0) : existing.unit_cost;

    await db.prepare(`
      UPDATE products SET name=?, category=?, fit=?, price=?, sale_price=?, on_sale=?, description=?, sizes=?, front_image=?, back_image=?, extra_images=?, in_stock=?, unit_cost=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(finalName, finalCategory, finalFit, finalPrice, salePriceVal, onSale, finalDesc,
      JSON.stringify(Array.isArray(sizesArr) ? sizesArr : JSON.parse(sizesArr)),
      frontImage, backImage, JSON.stringify(extraImages),
      finalInStock, finalUnitCost, req.params.id);

    const updated = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    updated.sizes = JSON.parse(updated.sizes || '[]');
    updated.extra_images = JSON.parse(updated.extra_images || '[]');
    updated.collections = JSON.parse(updated.collections || '[]');
    updated.on_sale = Boolean(updated.on_sale);
    updated.in_stock = Boolean(updated.in_stock);

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE product (admin only)
app.delete('/api/products/:id', requireAuth, async (req, res) => {
  try {
    const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });

    if (existing.front_image) await removeImage(existing.front_image);
    if (existing.back_image) await removeImage(existing.back_image);
    let extraImages = [];
    try { extraImages = JSON.parse(existing.extra_images || '[]'); } catch (e) { extraImages = []; }
    for (const img of extraImages) await removeImage(img);

    await db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH toggle stock (admin only)
app.patch('/api/products/:id/stock', requireAuth, async (req, res) => {
  try {
    const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });

    const newStock = existing.in_stock ? 0 : 1;
    await db.prepare('UPDATE products SET in_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStock, req.params.id);
    res.json({ success: true, in_stock: Boolean(newStock) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// ORDERS
// ----------------------------------------------------------------

// POST place order (public) — prices are recomputed server-side from the DB
app.post('/api/orders', async (req, res) => {
  try {
    const { name, email, phone, address, city, notes, payment_method, items } = req.body;
    if (!name || !email || !phone || !address || !city) {
      return res.status(400).json({ error: 'Name, email, phone, address and city are required.' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }
    const method = payment_method === 'bank' ? 'bank' : 'cod';

    // Recompute from the DB — never trust prices sent by the client
    const lineItems = [];
    const skipped = [];
    let subtotal = 0;
    for (const it of items) {
      const id = parseInt(it.id, 10);
      const qty = Math.min(99, Math.max(1, parseInt(it.qty, 10) || 1));
      const size = String(it.size || '').slice(0, 10);
      const p = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!p || !p.in_stock) { skipped.push(it); continue; }
      const unit = (p.sale_price && p.sale_price < p.price) ? p.sale_price : p.price;
      const lineTotal = unit * qty;
      const unitCost = (p.unit_cost && p.unit_cost > 0) ? p.unit_cost : Math.round(unit * 0.55);
      subtotal += lineTotal;
      lineItems.push({
        id: p.id,
        name: p.name,
        size,
        qty,
        unit: Math.round(unit),
        total: Math.round(lineTotal),
        cost: Math.round(unitCost) * qty, // COGS snapshot for P&L
        image: p.front_image || null
      });
    }
    if (skipped.length > 0) {
      return res.status(400).json({ error: 'Some items in your cart are unavailable or out of stock. Please review your cart.' });
    }
    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const shipping = subtotal >= 2000 ? 0 : 150;
    const total = Math.round(subtotal) + shipping;

    // Unique, human-readable order number (random suffix — not guessable)
    let orderNumber;
    do {
      orderNumber = 'KAGE-' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 10).toUpperCase().padEnd(8, 'Z');
    } while (await db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber));

    const result = await db.prepare(`
      INSERT INTO orders (order_number, customer_name, email, phone, address, city, notes, payment_method, subtotal, shipping, total, items_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderNumber,
      String(name).slice(0, 120),
      String(email).slice(0, 160),
      String(phone).slice(0, 40),
      String(address).slice(0, 300),
      String(city).slice(0, 120),
      String(notes || '').slice(0, 500),
      method,
      Math.round(subtotal),
      shipping,
      total,
      JSON.stringify(lineItems)
    );

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
    order.items = JSON.parse(order.items_json || '[]');
    res.status(201).json({
      order_number: order.order_number,
      customer_name: order.customer_name,
      email: order.email,
      phone: order.phone,
      address: order.address,
      city: order.city,
      notes: order.notes,
      payment_method: order.payment_method,
      subtotal: order.subtotal,
      shipping: order.shipping,
      total: order.total,
      items: order.items,
      status: order.status,
      created_at: order.created_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single order by order number (public — powers the confirmation screen)
app.get('/api/orders/:orderNumber', async (req, res) => {
  try {
    const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(req.params.orderNumber);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const { email, phone, notes, items_json, ...safe } = order;
    safe.items = JSON.parse(order.items_json || '[]');
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all orders (admin only)
app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const orders = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
    orders.forEach(o => { o.items = JSON.parse(o.items_json || '[]'); });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update order status (admin only)
app.patch('/api/orders/:id/status', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid order ID' });
    const { status } = req.body;
    const allowed = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Allowed: ' + allowed.join(', ') });
    }
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
    const updated = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    updated.items = JSON.parse(updated.items_json || '[]');
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// DASHBOARD STATS (admin only)
// ----------------------------------------------------------------
app.get('/api/admin/stats/dashboard', requireAuth, async (req, res) => {
  try {
    const prodCount = (await db.prepare('SELECT COUNT(*) as c FROM products').get()).c;
    const orderCount = (await db.prepare('SELECT COUNT(*) as c FROM orders').get()).c;
    const revenue = (await db.prepare('SELECT COALESCE(SUM(total), 0) as s FROM orders').get()).s;
    const pendingOrders = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get()).c;
    const deliveredOrders = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'delivered'").get()).c;
    const outOfStock = (await db.prepare('SELECT COUNT(*) as c FROM products WHERE in_stock = 0').get()).c;
    res.json({
      products: prodCount,
      orders: orderCount,
      revenue: Math.round(revenue),
      pendingOrders,
      deliveredOrders,
      outOfStock
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// P&L STATS (admin only)
// ----------------------------------------------------------------
// Returns revenue / cost / profit bucketed over time for a period:
//   period=daily  → last 14 days, one bucket per day
//   period=weekly → last 12 weeks, one bucket per week
//   period=monthly→ last 12 months, one bucket per month
// Revenue = order total (goods + shipping). Cost = COGS snapshot from
// order line items (falls back to product unit_cost, then 55% of unit
// price for legacy orders placed before cost tracking).
app.get('/api/admin/stats/pnl', requireAuth, async (req, res) => {
  try {
    const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'daily';

    const orders = await db.prepare('SELECT total, created_at, items_json FROM orders ORDER BY created_at ASC, id ASC').all();

    // Local-time date keys — SQLite stores CURRENT_TIMESTAMP as UTC wall time,
    // so parse it as local (no 'Z') and build keys from local calendar dates.
    const pad = (n) => String(n).padStart(2, '0');
    const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const monthKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1);
    const parseTs = (ts) => new Date(String(ts || '').replace('T', ' ').replace(/-/g, '/'));

    const buckets = [];
    const now = new Date();
    if (period === 'daily') {
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        buckets.push({ key: dayKey(d), label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), revenue: 0, cost: 0, profit: 0 });
      }
    } else if (period === 'weekly') {
      for (let i = 11; i >= 0; i--) {
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() || 7) + 1 + 6 - i * 7);
        const start = new Date(end); start.setDate(end.getDate() - 6);
        buckets.push({
          key: dayKey(start),
          label: start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' – ' + end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
          revenue: 0, cost: 0, profit: 0
        });
      }
    } else {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        buckets.push({ key: monthKey(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), revenue: 0, cost: 0, profit: 0 });
      }
    }

    const bucketFor = (ts) => {
      const d = parseTs(ts);
      if (isNaN(d.getTime())) return null;
      if (period === 'daily') return dayKey(d);
      if (period === 'weekly') {
        // Monday of the week containing d (matches the window loop)
        const monday = new Date(d);
        monday.setDate(d.getDate() - ((d.getDay() || 7) - 1));
        return dayKey(monday);
      }
      return monthKey(d);
    };

    let bucketedOrders = 0;
    for (const o of orders) {
      const items = JSON.parse(o.items_json || '[]');
      let cost = 0;
      for (const it of items) {
        if (it.cost) { cost += it.cost; continue; }
        // Legacy orders (pre-cost-tracking): look up the product's current cost
        const p = it.id ? await db.prepare('SELECT unit_cost, price, sale_price FROM products WHERE id = ?').get(it.id) : null;
        const unit = (p && p.sale_price && p.sale_price < p.price) ? p.sale_price : (p ? p.price : null);
        const unitCost = (p && p.unit_cost && p.unit_cost > 0) ? p.unit_cost : (unit ? Math.round(unit * 0.55) : 0);
        cost += unitCost * (it.qty || 1);
      }
      const revenue = o.total;
      const profit = revenue - cost;
      const bk = buckets.find(b => b.key === bucketFor(o.created_at));
      if (bk) {
        bk.revenue += revenue;
        bk.cost += cost;
        bk.profit += profit;
        bucketedOrders++;
      }
    }

    const totals = buckets.reduce((acc, b) => {
      acc.revenue += b.revenue;
      acc.cost += b.cost;
      acc.profit += b.profit;
      return acc;
    }, { revenue: 0, cost: 0, profit: 0 });

    res.json({
      period,
      labels: buckets.map(b => b.label),
      revenue: buckets.map(b => Math.round(b.revenue)),
      cost: buckets.map(b => Math.round(b.cost)),
      profit: buckets.map(b => Math.round(b.profit)),
      summary: {
        revenue: Math.round(totals.revenue),
        cost: Math.round(totals.cost),
        profit: Math.round(totals.profit),
        orders: bucketedOrders
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// IMAGE UPLOAD (standalone)
// ----------------------------------------------------------------
app.post('/api/upload', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const url = await persistImage(req.file.buffer, req.file.originalname);
  res.json({ url });
});

// ----------------------------------------------------------------
// SEED DEFAULT PRODUCTS (if database is empty)
// ----------------------------------------------------------------
async function backfillUnitCosts() {
  const missing = await db.prepare('SELECT id, price FROM products WHERE unit_cost IS NULL OR unit_cost = 0').all();
  if (missing.length === 0) return;
  for (const p of missing) {
    const cost = Math.max(50, Math.round(p.price * 0.55));
    await db.prepare('UPDATE products SET unit_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(cost, p.id);
  }
  await db.save();
  console.log('💰 Backfilled unit costs for ' + missing.length + ' product(s)');
}

// Keeps the two marketed sale items on sale even in databases seeded before
// sale prices existed. Only touches rows that still match the original seed
// (exact name + price + no sale price yet), so admin edits are never overwritten.
async function syncSeedSalePrices() {
  const syncs = [
    { name: 'Rising Vermillion', price: 999, sale: 799 },
    { name: 'Wrath Silhouette', price: 1249, sale: 1099 }
  ];
  let changed = 0;
  for (const s of syncs) {
    const row = await db.prepare('SELECT id FROM products WHERE name = ? AND price = ? AND sale_price IS NULL').get(s.name, s.price);
    if (row) {
      await db.prepare('UPDATE products SET sale_price = ?, on_sale = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(s.sale, row.id);
      changed++;
    }
  }
  if (changed > 0) {
    await db.save();
    console.log('💸 Synced sale prices for ' + changed + ' seeded product(s)');
  }
}

async function seedProducts() {
  const count = await db.prepare('SELECT COUNT(*) as c FROM products').get();
  if (!count || (count.c != null && count.c > 0)) return;

  const defaults = [
    { name: 'Shadow Fit', price: 1499, cost: 820, category: 'compression', fit: 'Compression', desc: '4-way stretch muscle-fit compression shirt. Second-skin feel with maximum mobility.' },
    { name: 'Oni Muscle Tee', price: 1599, cost: 875, category: 'compression', fit: 'Compression', desc: 'Sleeveless compression with bold contrast panels. For those who train until the mask drops.' },
    { name: 'Kage Core Compression', price: 1399, cost: 760, category: 'compression', fit: 'Compression', desc: 'Core compression layer — seamless, breathable, built for combat-level intensity.' },
    { name: 'Rising Vermillion', price: 999, sale: 799, cost: 545, category: 'graphic-tees', fit: 'Regular', desc: 'Heavyweight 220GSM cotton tee. A gradient sky turned crimson.' },
    { name: 'Blade Wolf', price: 1149, cost: 620, category: 'graphic-tees', fit: 'Regular', desc: 'Silver ink on black — a lone wolf under a crescent moon.' },
    { name: 'Neon Fangs', price: 1049, cost: 570, category: 'graphic-tees', fit: 'Regular', desc: 'Electric strike — neon clash across heavyweight cotton.' },
    { name: 'Shinobi Mark', price: 999, cost: 540, category: 'graphic-tees', fit: 'Regular', desc: 'Minimalist shinobi crest. High-contrast placement on premium cotton.' },
    { name: 'Drift Oversized', price: 1199, cost: 650, category: 'oversized', fit: 'Oversized', desc: 'Drop-shoulder, relaxed fit — heavyweight cotton.' },
    { name: 'Wrath Silhouette', price: 1249, sale: 1099, cost: 680, category: 'oversized', fit: 'Oversized', desc: 'Boxy, cropped oversized fit. Built for those who take up space.' },
    { name: 'Hollow Gaze', price: 1149, cost: 625, category: 'oversized', fit: 'Oversized', desc: 'Extended drop-shoulder with raw hem. Unsettling and calm.' }
  ];

  const insert = await db.prepare(`
    INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, unit_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, '["S","M","L","XL","XXL"]', ?)
  `);

  // Per-name existence check makes seeding idempotent even if two cold-start
  // instances race (serverless can boot more than one at a time).
  let added = 0;
  for (const p of defaults) {
    const exists = await db.prepare('SELECT id FROM products WHERE name = ?').get(p.name);
    if (exists) continue;
    await insert.run([p.name, p.category, p.fit, p.price, p.sale || null, p.sale ? 1 : 0, p.desc, p.cost]);
    added++;
  }
  await db.save();

  if (added > 0) console.log('✅ Seeded ' + added + ' default products');
}

// ----------------------------------------------------------------
// SERVE HTML FALLBACK
// ----------------------------------------------------------------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback to index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------------------------------------------
// ERROR HANDLER
// ----------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Upload error: ' + err.message });
  }
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error.' });
});

// ----------------------------------------------------------------
// START
// ----------------------------------------------------------------
async function startServer() {
  try {
    await dbModule.init();
    db = dbModule;
  } catch (e) {
    console.error('⚠️  Database init failed:', e.message);
    db = dbModule;
  }
  try { await seedProducts(); } catch (e) { console.error('seedProducts skipped:', e.message); }
  try { await backfillUnitCosts(); } catch (e) { console.error('backfillUnitCosts skipped:', e.message); }
  try { await syncSeedSalePrices(); } catch (e) { console.error('syncSeedSalePrices skipped:', e.message); }

  if (!process.env.VERCEL) {
    app.listen(PORT, () => {
      const mode = dbModule.USE_TURSO ? 'Turso (cloud)' : 'sql.js (local file)';
      console.log(`
╔══════════════════════════════════════════════════╗
║         KAGE CULTURE — Admin System              ║
╠══════════════════════════════════════════════════╣
║  Public site:  http://localhost:${PORT}              ║
║  Admin panel:  http://localhost:${PORT}/admin       ║
║  Database:     ${mode}                                ║
╚══════════════════════════════════════════════════╝
    `);
    });
  }
}

// Warn loudly if running in production without a real session secret
if ((process.env.VERCEL || process.env.NODE_ENV === 'production') &&
    !process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET is not set — using the fallback secret. Set a strong random value for production.');
}

const serverReady = startServer().catch(err => {
  console.error('Failed to start server:', err);
  throw err;
});

// Export for Vercel (@vercel/node builder). Wait for DB init + seeding to
// finish before handling requests — otherwise a cold-start request could
// hit the database before it is ready.
module.exports = async (req, res) => {
  try {
    await serverReady;
    return app(req, res);
  } catch (err) {
    console.error('Server not ready:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Server not ready yet. Please retry.' });
    }
  }
};

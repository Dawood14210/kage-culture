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
const LOW_STOCK_THRESHOLD = 5; // products with stock_qty < this are flagged as low-stock

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
  // Try session first, then parse cookie directly
  let adminId = req.session && req.session.adminId;
  if (!adminId) {
    // Parse cookie manually as fallback
    const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
    const sessionCookie = cookies.find(c => c.startsWith('kage.session='));
    if (sessionCookie) {
      try {
        const parts = sessionCookie.split('=')[1].split('.');
        const data = JSON.parse(Buffer.from(parts[0], 'base64').toString());
        adminId = data.adminId;
      } catch (e) { /* invalid cookie */ }
    }
  }
  if (adminId) {
    req.adminId = adminId;
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
    // Force cookie to be set even if cookie-session middleware doesn't
    const cookieVal = Buffer.from(JSON.stringify({ adminId: admin.id })).toString('base64');
    const sig = require('crypto').createHmac('sha256', process.env.SESSION_SECRET || 'kage-culture-secret-key-change-in-production').update(cookieVal).digest('base64');
    res.setHeader('Set-Cookie', `kage.session=${cookieVal}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    res.json({ success: true, admin: { email: admin.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// CHECK AUTH / LOGOUT
// ----------------------------------------------------------------
app.get('/api/admin/me', requireAuth, async (req, res) => {
  const admin = await db.prepare('SELECT id, email, created_at FROM admin WHERE id = ?').get(req.adminId);
  res.json({ admin });
});

app.post('/api/admin/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// ----------------------------------------------------------------
// CHANGE PASSWORD (admin only)
// ----------------------------------------------------------------
app.post('/api/admin/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    const admin = await db.prepare('SELECT * FROM admin WHERE id = ?').get(req.adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found.' });
    }
    const match = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const newHash = await bcrypt.hash(newPassword, 12);
    await db.prepare('UPDATE admin SET password_hash = ? WHERE id = ?').run(newHash, req.adminId);
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
// CUSTOMER ACCOUNTS
// ----------------------------------------------------------------
function requireCustomerAuth(req, res, next) {
  let customerId = req.session && req.session.customerId;
  if (!customerId) {
    const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
    const sessionCookie = cookies.find(c => c.startsWith('kage.cust='));
    if (sessionCookie) {
      try {
        const parts = sessionCookie.split('=')[1].split('.');
        const data = JSON.parse(Buffer.from(parts[0], 'base64').toString());
        customerId = data.customerId;
      } catch (e) { /* invalid cookie */ }
    }
  }
  if (customerId) {
    req.customerId = customerId;
    next();
  } else {
    res.status(401).json({ error: 'Please log in to continue.' });
  }
}

// POST customer signup
app.post('/api/customers/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const existing = await db.prepare('SELECT id FROM customers WHERE email = ?').get(clean);
    if (existing) {
      return res.status(400).json({ error: 'An account with that email already exists.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const customerName = String(name || '').trim().slice(0, 80);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const result = await db.prepare('INSERT INTO customers (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)')
      .run(clean, hash, customerName, now);
    const customerId = result.lastInsertRowid;
    req.session.customerId = customerId;
    const cookieVal = Buffer.from(JSON.stringify({ customerId })).toString('base64');
    const sig = require('crypto').createHmac('sha256', process.env.SESSION_SECRET || 'kage-culture-secret-key-change-in-production').update(cookieVal).digest('base64');
    res.setHeader('Set-Cookie', `kage.cust=${cookieVal}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    res.json({ success: true, customer: { id: customerId, email: clean, name: customerName } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST customer login
app.post('/api/customers/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const customer = await db.prepare('SELECT * FROM customers WHERE email = ?').get(email.trim().toLowerCase());
    if (!customer) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const match = await bcrypt.compare(password, customer.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    req.session.customerId = customer.id;
    const cookieVal = Buffer.from(JSON.stringify({ customerId: customer.id })).toString('base64');
    const sig = require('crypto').createHmac('sha256', process.env.SESSION_SECRET || 'kage-culture-secret-key-change-in-production').update(cookieVal).digest('base64');
    res.setHeader('Set-Cookie', `kage.cust=${cookieVal}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    res.json({ success: true, customer: { id: customer.id, email: customer.email, name: customer.name, phone: customer.phone, address: customer.address, city: customer.city } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST customer logout
app.post('/api/customers/logout', (req, res) => {
  req.session = null;
  res.setHeader('Set-Cookie', 'kage.cust=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

// GET current customer profile
app.get('/api/customers/me', requireCustomerAuth, async (req, res) => {
  try {
    const c = await db.prepare('SELECT id, email, name, phone, address, city, created_at FROM customers WHERE id = ?').get(req.customerId);
    if (!c) return res.status(404).json({ error: 'Account not found.' });
    res.json({ customer: c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update customer profile
app.put('/api/customers/me', requireCustomerAuth, async (req, res) => {
  try {
    const { name, phone, address, city, currentPassword, newPassword } = req.body;
    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customerId);
    if (!customer) return res.status(404).json({ error: 'Account not found.' });

    // Password change
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required to set a new password.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }
      const match = await bcrypt.compare(currentPassword, customer.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
      const newHash = await bcrypt.hash(newPassword, 12);
      await db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(newHash, req.customerId);
    }

    const finalName = name !== undefined ? String(name).trim().slice(0, 80) : customer.name;
    const finalPhone = phone !== undefined ? String(phone).trim().slice(0, 40) : customer.phone;
    const finalAddress = address !== undefined ? String(address).trim().slice(0, 300) : customer.address;
    const finalCity = city !== undefined ? String(city).trim().slice(0, 120) : customer.city;
    await db.prepare('UPDATE customers SET name=?, phone=?, address=?, city=? WHERE id=?')
      .run(finalName, finalPhone, finalAddress, finalCity, req.customerId);

    res.json({ success: true, customer: { id: req.customerId, email: customer.email, name: finalName, phone: finalPhone, address: finalAddress, city: finalCity } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET customer order history
app.get('/api/customers/orders', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await db.prepare('SELECT email, phone FROM customers WHERE id = ?').get(req.customerId);
    if (!customer) return res.status(404).json({ error: 'Account not found.' });
    // Match orders by email OR phone (covers orders placed before account creation)
    const orders = await db.prepare(
      'SELECT * FROM orders WHERE email = ? OR phone = ? ORDER BY created_at DESC, id DESC'
    ).all(customer.email, customer.phone);
    orders.forEach(o => { o.items = JSON.parse(o.items_json || '[]'); });
    res.json({ orders });
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

    // Real sold counts — summed from order line items, excluding cancelled orders.
    // Parameters (not inline literals) keep this working on the in-memory fallback backend.
    const orders = await db.prepare('SELECT status, items_json FROM orders WHERE status != ?').all('cancelled');
    const sold = {};
    for (const o of orders) {
      let items = [];
      try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; }
      for (const it of items) sold[it.id] = (sold[it.id] || 0) + (Number(it.qty) || 1);
    }

    // Approved-review aggregates (only approved reviews count toward ratings)
    let reviewRows = [];
    try { reviewRows = await db.prepare('SELECT product_id, rating FROM reviews WHERE status = ?').all('approved'); } catch (e) { reviewRows = []; }
    const revAgg = {};
    for (const r of reviewRows) {
      const a = revAgg[r.product_id] || (revAgg[r.product_id] = { sum: 0, n: 0 });
      a.sum += Number(r.rating) || 0;
      a.n += 1;
    }

    const parsed = products.map(p => {
      const agg = revAgg[p.id];
      const stock = (p.stock_qty != null && p.stock_qty !== '') ? Number(p.stock_qty) : null;
      return {
        ...p,
        sizes: JSON.parse(p.sizes || '["S","M","L","XL","XXL"]'),
        extra_images: JSON.parse(p.extra_images || '[]'),
        collections: JSON.parse(p.collections || '[]'),
        on_sale: Boolean(p.on_sale),
        in_stock: Boolean(p.in_stock),
        stock_qty: stock,
        sold_count: sold[p.id] || 0,
        order_count: sold[p.id] || 0, // drives Best Sellers on the storefront
        avg_rating: agg ? Math.round((agg.sum / agg.n) * 10) / 10 : null,
        review_count: agg ? agg.n : 0
      };
    });
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
    const { name, category, fit, price, sale_price, description, sizes, in_stock, stock_qty } = req.body;
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
    const stockQty = (stock_qty !== undefined && stock_qty !== '' && stock_qty !== null)
      ? Math.max(0, Number(stock_qty) || 0) : null;

    // New products get an estimated unit cost immediately (55% of list price)
    // so P&L is accurate even before the admin fine-tunes it in the edit form.
    const estCost = Math.max(50, Math.round(parseFloat(price) * 0.55));

    const result = await db.prepare(`
      INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, front_image, back_image, extra_images, in_stock, unit_cost, stock_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, category, fit || '', parseFloat(price), salePriceVal, onSale, description || '',
      JSON.stringify(Array.isArray(sizesArr) ? sizesArr : JSON.parse(sizesArr)),
      frontImage, backImage, JSON.stringify(extraImages), inStock, estCost, stockQty);

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

    const { name, category, fit, price, sale_price, description, sizes, in_stock, unit_cost, stock_qty, remove_front, remove_back } = req.body;

    let frontImage = existing.front_image ?? null;
    let backImage = existing.back_image ?? null;

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

    const sizesArr = sizes || existing.sizes || JSON.stringify(['S', 'M', 'L', 'XL', 'XXL']);
    const salePriceVal = sale_price !== undefined ? sale_price : existing.sale_price;
    const onSale = sale_price ? 1 : 0;
    const finalName = name || existing.name;
    const finalCategory = category || existing.category;
    const finalFit = fit !== undefined ? fit : existing.fit;
    const finalPrice = price !== undefined ? parseFloat(price) : existing.price;
    const finalDesc = description !== undefined ? description : existing.description;
    const finalInStock = in_stock !== undefined ? (in_stock === 'true' || in_stock === true ? 1 : 0) : existing.in_stock;
    const finalUnitCost = unit_cost !== undefined && unit_cost !== '' ? Math.max(0, parseFloat(unit_cost) || 0) : existing.unit_cost;
    const finalStockQty = (stock_qty !== undefined && stock_qty !== '' && stock_qty !== null)
      ? Math.max(0, Number(stock_qty) || 0) : existing.stock_qty;

    // updated_at passed as a parameter — one placeholder per SET column is
    // required for the in-memory fallback backend.
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const runResult = await db.prepare(`
      UPDATE products SET name=?, category=?, fit=?, price=?, sale_price=?, on_sale=?, description=?, sizes=?, front_image=?, back_image=?, extra_images=?, in_stock=?, unit_cost=?, stock_qty=?, updated_at=?
      WHERE id=?
    `).run(finalName, finalCategory, finalFit, finalPrice, salePriceVal, onSale, finalDesc,
      JSON.stringify(Array.isArray(sizesArr) ? sizesArr : JSON.parse(sizesArr)),
      frontImage, backImage, JSON.stringify(extraImages),
      finalInStock, finalUnitCost, finalStockQty, now, req.params.id);

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
    await db.prepare('UPDATE products SET in_stock = ? WHERE id = ?').run(newStock, req.params.id);
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
      const stock = (p.stock_qty != null && p.stock_qty !== '') ? Number(p.stock_qty) : null;
      // Honest inventory: never oversell a known stock count.
      if (stock != null && qty > stock) {
        return res.status(400).json({ error: `Only ${stock} ${stock === 1 ? 'unit' : 'units'} of "${p.name}" left in stock. Please reduce the quantity.` });
      }
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
        image: p.front_image || null,
        stock
      });
    }
    if (skipped.length > 0) {
      return res.status(400).json({ error: 'Some items in your cart are unavailable or out of stock. Please review your cart.' });
    }
    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const shipping = 150; // Flat delivery charge (free-shipping threshold removed)
    const total = Math.round(subtotal) + shipping;

    // Unique, human-readable order number (random suffix — not guessable)
    let orderNumber;
    do {
      orderNumber = 'KAGE-' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 10).toUpperCase().padEnd(8, 'Z');
    } while (await db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber));

    // status + created_at passed explicitly (not via SQL DEFAULTs) so rows look
    // identical on Turso, sql.js AND the pure-JS in-memory fallback backend.
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const result = await db.prepare(`
      INSERT INTO orders (order_number, customer_name, email, phone, address, city, notes, payment_method, subtotal, shipping, total, items_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(lineItems),
      'pending',
      now
    );

    // Decrement real inventory for each item (skip products with unknown stock).
    // When a product hits 0 units it is automatically marked out of stock.
    for (const it of lineItems) {
      if (it.stock == null) continue;
      const newStock = Math.max(0, it.stock - it.qty);
      // One placeholder per SET column — required by the in-memory fallback parser.
      await db.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(newStock, it.id);
      if (newStock === 0) {
        await db.prepare('UPDATE products SET in_stock = ? WHERE id = ?').run(0, it.id);
      }
    }

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

// GET track order (public — order number + phone required, no account needed)
// Defined BEFORE /api/orders/:orderNumber so 'track' never matches as an order number.
app.get('/api/orders/track', async (req, res) => {
  try {
    const { number, phone } = req.query;
    if (!number || !phone) {
      return res.status(400).json({ error: 'Order number and phone are required.' });
    }
    // Phone matching is lenient (digits only, last 10) so formatting differences
    // like "+92-300-1234567" vs "03001234567" still verify.
    const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10);
    const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?')
      .get(String(number).trim().toUpperCase());
    if (!order || normPhone(order.phone) !== normPhone(phone)) {
      return res.status(404).json({ error: "We couldn't find an order with that number and phone. Please double-check and try again." });
    }
    const { email, address, notes, items_json, ...safe } = order;
    safe.items = JSON.parse(order.items_json || '[]');
    res.json(safe);
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

    // Cancelling an order restores the reserved stock so the units go back on sale.
    if (status === 'cancelled' && order.status !== 'cancelled') {
      let items = [];
      try { items = JSON.parse(order.items_json || '[]'); } catch (e) { items = []; }
      for (const it of items) {
        const p = await db.prepare('SELECT id, stock_qty FROM products WHERE id = ?').get(it.id);
        if (!p || p.stock_qty == null) continue;
        await db.prepare('UPDATE products SET stock_qty = ?, in_stock = ? WHERE id = ?')
          .run(Number(p.stock_qty) + (Number(it.qty) || 1), 1, it.id);
      }
    }

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
    const lowStockCount = (await db.prepare('SELECT COUNT(*) as c FROM products WHERE stock_qty IS NOT NULL AND stock_qty > 0 AND stock_qty < ?').get(LOW_STOCK_THRESHOLD)).c;
    // Last 10 orders, newest first
    const recentOrders = (await db.prepare('SELECT id, order_number, customer_name, total, status, created_at FROM orders ORDER BY created_at DESC, id DESC LIMIT 10').all());
    res.json({
      products: prodCount,
      orders: orderCount,
      revenue: Math.round(revenue),
      pendingOrders,
      deliveredOrders,
      outOfStock,
      lowStockCount,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      recentOrders
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH quick-update stock quantity (admin only)
// ----------------------------------------------------------------
app.patch('/api/products/:id/stock-qty', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid product ID' });
    const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    const { stock_qty } = req.body;
    if (stock_qty == null || stock_qty === '' || isNaN(Number(stock_qty))) {
      return res.status(400).json({ error: 'stock_qty must be a number' });
    }
    const qty = Math.max(0, Math.floor(Number(stock_qty)));
    await db.prepare('UPDATE products SET stock_qty = ?, in_stock = ? WHERE id = ?').run(qty, qty > 0 ? 1 : 0, id);
    const updated = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.json({ success: true, stock_qty: updated.stock_qty, in_stock: Boolean(updated.in_stock) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// SALES SUMMARY (admin only)
// ----------------------------------------------------------------
app.get('/api/admin/stats/sales', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const revToday = (await db.prepare('SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE created_at >= ?').get(todayStart)).s;
    const revWeek = (await db.prepare('SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE created_at >= ?').get(weekStart)).s;
    const revMonth = (await db.prepare('SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE created_at >= ?').get(monthStart)).s;

    // Order counts by status
    const statusCounts = (await db.prepare('SELECT status, COUNT(*) as c FROM orders GROUP BY status').all());
    const byStatus = {};
    statusCounts.forEach(r => { byStatus[r.status] = r.c; });

    // Best-selling product by units sold
    const allOrders = (await db.prepare('SELECT items_json FROM orders WHERE status != ?').all('cancelled'));
    const unitMap = {};
    for (const o of allOrders) {
      let items = [];
      try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; }
      for (const it of items) {
        const pid = it.id;
        unitMap[pid] = (unitMap[pid] || 0) + (Number(it.qty) || 1);
      }
    }
    let bestProduct = null;
    let bestUnits = 0;
    for (const [pid, units] of Object.entries(unitMap)) {
      if (units > bestUnits) {
        bestUnits = units;
        const p = await db.prepare('SELECT id, name FROM products WHERE id = ?').get(Number(pid));
        bestProduct = p ? p.name : ('Product #' + pid);
      }
    }

    res.json({
      revenueToday: Math.round(revToday),
      revenueWeek: Math.round(revWeek),
      revenueMonth: Math.round(revMonth),
      ordersByStatus: byStatus,
      bestProduct: bestProduct ? { name: bestProduct, units: bestUnits } : null
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
// NEWSLETTER (public)
// ----------------------------------------------------------------
app.post('/api/newsletter', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    // Check if already subscribed
    const existing = await db.prepare('SELECT id FROM newsletter_subscribers WHERE email = ?').get(clean);
    if (existing) {
      return res.json({ success: true, message: 'You are already subscribed! Welcome back to the clan.' });
    }
    await db.prepare('INSERT INTO newsletter_subscribers (email) VALUES (?)').run(clean);
    res.json({ success: true, message: 'Welcome to the clan! Stay tuned for restock alerts and early drop access.' });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ----------------------------------------------------------------
// COMING SOON NOTIFY-ME (per category)
// ----------------------------------------------------------------

// POST notify-me — store an email tagged with the category they're waiting for.
app.post('/api/coming-soon', async (req, res) => {
  try {
    const { email, category } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    const cat = typeof category === 'string' ? category.trim().toLowerCase() : '';
    const allowed = ['graphic-tees', 'compression', 'oversized', 'sale'];
    if (!allowed.includes(cat)) {
      return res.status(400).json({ error: 'Unknown collection.' });
    }
    // Avoid duplicates for the same email + category
    const existing = await db.prepare('SELECT id FROM coming_soon_signups WHERE email = ? AND category = ?').get(clean, cat);
    if (existing) {
      return res.json({ success: true, message: "You're on the list! We'll let you know when this drop lands." });
    }
    await db.prepare('INSERT INTO coming_soon_signups (email, category) VALUES (?, ?)').run(clean, cat);
    res.json({ success: true, message: "You're on the list! We'll let you know when this drop lands." });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ----------------------------------------------------------------
// REVIEWS & RATINGS
// ----------------------------------------------------------------

// POST submit a review (public) — must verify a DELIVERED order containing the
// product, and only one review per order+product. Inserted as 'pending' so the
// admin can approve it before it appears publicly (anti-fake moderation).
app.post('/api/reviews', async (req, res) => {
  try {
    const { product_id, order_number, phone, rating, comment, name } = req.body;
    const pid = parseInt(product_id, 10);
    const rf = parseFloat(rating);
    const r = Math.round(rf);
    if (!pid || isNaN(pid)) return res.status(400).json({ error: 'Invalid product.' });
    if (isNaN(rf) || r < 1 || r > 5) return res.status(400).json({ error: 'Please select a rating from 1 to 5 stars.' });
    const num = String(order_number || '').trim().toUpperCase();
    const ph = String(phone || '').trim();
    if (!num || !ph) {
      return res.status(400).json({ error: 'Order number and phone are required to verify your purchase.' });
    }

    const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10);
    const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(num);
    if (!order || normPhone(order.phone) !== normPhone(ph)) {
      return res.status(404).json({ error: "We couldn't find an order matching that number and phone." });
    }
    if (order.status !== 'delivered') {
      return res.status(403).json({
        error: 'Reviews unlock once your order is delivered. Current status: ' + order.status + '.'
      });
    }
    let items = [];
    try { items = JSON.parse(order.items_json || '[]'); } catch (e) { items = []; }
    if (!items.some(i => String(i.id) === String(pid))) {
      return res.status(403).json({ error: "That product wasn't part of this order." });
    }
    const dup = await db.prepare('SELECT id FROM reviews WHERE order_number = ? AND product_id = ?').get(num, pid);
    if (dup) {
      return res.status(409).json({ error: 'You have already reviewed this product.' });
    }

    const cleanComment = String(comment || '').trim().slice(0, 1000);
    const customerName = String(name || '').trim().slice(0, 60) || 'Verified Buyer';
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await db.prepare('INSERT INTO reviews (product_id, order_number, customer_name, rating, comment, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(pid, num, customerName, r, cleanComment, 'pending', now);
    res.status(201).json({ success: true, message: 'Thanks for your review! It will appear on the site once approved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET approved reviews for a product (public)
app.get('/api/reviews', async (req, res) => {
  try {
    const pid = parseInt(req.query.product_id, 10);
    if (!pid || isNaN(pid)) return res.json([]);
    const rows = await db.prepare('SELECT id, customer_name, rating, comment, created_at FROM reviews WHERE product_id = ? AND status = ?')
      .all(pid, 'approved');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all reviews (admin only — moderation queue)
app.get('/api/reviews/all', requireAuth, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM reviews ORDER BY id DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH review status (admin only — approve / reject)
app.patch('/api/reviews/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid review ID.' });
    const { status } = req.body;
    if (!['approved', 'pending', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Allowed: approved, pending, rejected.' });
    }
    const existing = await db.prepare('SELECT id FROM reviews WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Review not found.' });
    await db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE review (admin only)
app.delete('/api/reviews/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid review ID.' });
    await db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// SEED DEFAULT PRODUCTS (if database is empty)
// ----------------------------------------------------------------
async function backfillUnitCosts() {
  const missing = await db.prepare('SELECT id, price FROM products WHERE unit_cost IS NULL OR unit_cost = 0').all();
  if (missing.length === 0) return;
  for (const p of missing) {
    const cost = Math.max(50, Math.round(p.price * 0.55));
    await db.prepare('UPDATE products SET unit_cost = ? WHERE id = ?').run(cost, p.id);
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
      await db.prepare('UPDATE products SET sale_price = ?, on_sale = ? WHERE id = ?').run(s.sale, 1, row.id);
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

  // Initial stock represents the brand's opening inventory per SKU (units).
  // A couple of items start intentionally low so the "Only N left" urgency
  // badge is real from day one; the admin fine-tunes these in the admin panel.
  const defaults = [
    { name: 'Shadow Fit', price: 1499, cost: 820, stock: 4, category: 'compression', fit: 'Compression', desc: '4-way stretch muscle-fit compression shirt. Second-skin feel with maximum mobility.' },
    { name: 'Oni Muscle Tee', price: 1599, cost: 875, stock: 8, category: 'compression', fit: 'Compression', desc: 'Sleeveless compression with bold contrast panels. For those who train until the mask drops.' },
    { name: 'Kage Core Compression', price: 1399, cost: 760, stock: 12, category: 'compression', fit: 'Compression', desc: 'Core compression layer — seamless, breathable, built for combat-level intensity.' },
    { name: 'Rising Vermillion', price: 999, sale: 799, cost: 545, stock: 3, category: 'graphic-tees', fit: 'Regular', desc: 'Heavyweight 220GSM cotton tee. A gradient sky turned crimson.' },
    { name: 'Blade Wolf', price: 1149, cost: 620, stock: 10, category: 'graphic-tees', fit: 'Regular', desc: 'Silver ink on black — a lone wolf under a crescent moon.' },
    { name: 'Neon Fangs', price: 1049, cost: 570, stock: 6, category: 'graphic-tees', fit: 'Regular', desc: 'Electric strike — neon clash across heavyweight cotton.' },
    { name: 'Shinobi Mark', price: 999, cost: 540, stock: 15, category: 'graphic-tees', fit: 'Regular', desc: 'Minimalist shinobi crest. High-contrast placement on premium cotton.' },
    { name: 'Drift Oversized', price: 1199, cost: 650, stock: 5, category: 'oversized', fit: 'Oversized', desc: 'Drop-shoulder, relaxed fit — heavyweight cotton.' },
    { name: 'Wrath Silhouette', price: 1249, sale: 1099, cost: 680, stock: 7, category: 'oversized', fit: 'Oversized', desc: 'Boxy, cropped oversized fit. Built for those who take up space.' },
    { name: 'Hollow Gaze', price: 1149, cost: 625, stock: 9, category: 'oversized', fit: 'Oversized', desc: 'Extended drop-shoulder with raw hem. Unsettling and calm.' }
  ];

  // Every column is a placeholder (no inline literals, no reliance on SQL
  // DEFAULTs) so seeding produces identical rows on Turso, sql.js AND the
  // pure-JS in-memory fallback backend.
  const insert = await db.prepare(`
    INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, unit_cost, stock_qty, in_stock)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Per-name existence check makes seeding idempotent even if two cold-start
  // instances race (serverless can boot more than one at a time).
  let added = 0;
  for (const p of defaults) {
    const exists = await db.prepare('SELECT id FROM products WHERE name = ?').get(p.name);
    if (exists) continue;
    await insert.run([p.name, p.category, p.fit, p.price, p.sale || null, p.sale ? 1 : 0, p.desc,
      JSON.stringify(['S', 'M', 'L', 'XL', 'XXL']), p.cost, p.stock, 1]);
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

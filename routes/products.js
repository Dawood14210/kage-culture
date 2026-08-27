// ================================================================
// KAGE Culture — Product routes
// ================================================================
const express = require('express');
const multer = require('multer');
const path = require('path');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth } = require('../middleware/auth');
const { persistImage, removeImage } = require('../utils/helpers');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|svg/;
    if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) cb(null, true);
    else { const err = new Error('Only image files (JPEG, PNG, GIF, WebP, SVG) are allowed'); err.status = 400; cb(err); }
  }
});

module.exports = function createProductRoutes(db) {
  const router = express.Router();

  // GET all products (public)
  router.get('/api/products', async (req, res) => {
    try {
      const products = await db.prepare('SELECT * FROM products ORDER BY created_at DESC, id DESC').all();
      const orders = await db.prepare('SELECT status, items_json FROM orders WHERE status != ?').all('cancelled');
      const sold = {};
      for (const o of orders) {
        let items = []; try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; }
        for (const it of items) sold[it.id] = (sold[it.id] || 0) + (Number(it.qty) || 1);
      }
      let reviewRows = [];
      try { reviewRows = await db.prepare('SELECT product_id, rating FROM reviews WHERE status = ?').all('approved'); } catch (e) { reviewRows = []; }
      const revAgg = {};
      for (const r of reviewRows) {
        const a = revAgg[r.product_id] || (revAgg[r.product_id] = { sum: 0, n: 0 });
        a.sum += Number(r.rating) || 0; a.n += 1;
      }
      const parsed = products.map(p => {
        const agg = revAgg[p.id];
        const stock = (p.stock_qty != null && p.stock_qty !== '') ? Number(p.stock_qty) : null;
        return { ...p, sizes: JSON.parse(p.sizes || '["S","M","L","XL","XXL"]'), extra_images: JSON.parse(p.extra_images || '[]'), collections: JSON.parse(p.collections || '[]'), on_sale: Boolean(p.on_sale), in_stock: Boolean(p.in_stock), stock_qty: stock, sold_count: sold[p.id] || 0, order_count: sold[p.id] || 0, avg_rating: agg ? Math.round((agg.sum / agg.n) * 10) / 10 : null, review_count: agg ? agg.n : 0 };
      });
      res.json(parsed);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET single product (public)
  router.get('/api/products/:id', async (req, res) => {
    try {
      const p = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!p) return res.status(404).json({ error: 'Product not found' });
      p.sizes = JSON.parse(p.sizes || '["S","M","L","XL","XXL"]'); p.extra_images = JSON.parse(p.extra_images || '[]'); p.collections = JSON.parse(p.collections || '[]'); p.on_sale = Boolean(p.on_sale); p.in_stock = Boolean(p.in_stock);
      res.json(p);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST create product (admin only)
  router.post('/api/products', requireCsrf, requireAuth, upload.fields([{ name: 'front_image', maxCount: 1 }, { name: 'back_image', maxCount: 1 }, { name: 'extra_images', maxCount: 4 }]), async (req, res) => {
    try {
      const { name, category, fit, price, sale_price, description, sizes, in_stock, stock_qty } = req.body;
      if (!name || !category || !price) return res.status(400).json({ error: 'Name, category, and price are required.' });
      const frontImage = req.files?.front_image?.[0] ? await persistImage(req.files.front_image[0].buffer, req.files.front_image[0].originalname) : null;
      const backImage = req.files?.back_image?.[0] ? await persistImage(req.files.back_image[0].buffer, req.files.back_image[0].originalname) : null;
      const extraImages = []; if (req.files?.extra_images) { for (const f of req.files.extra_images) { extraImages.push(await persistImage(f.buffer, f.originalname)); } }
      const sizesArr = sizes || JSON.stringify(['S', 'M', 'L', 'XL', 'XXL']); const salePriceVal = sale_price || null; const onSale = sale_price ? 1 : 0;
      const inStock = in_stock !== undefined ? (in_stock === 'true' || in_stock === true ? 1 : 0) : 1;
      const stockQty = (stock_qty !== undefined && stock_qty !== '' && stock_qty !== null) ? Math.max(0, Number(stock_qty) || 0) : null;
      const estCost = Math.max(50, Math.round(parseFloat(price) * 0.55));
      const result = await db.prepare('INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, front_image, back_image, extra_images, in_stock, unit_cost, stock_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name, category, fit || '', parseFloat(price), salePriceVal, onSale, description || '', JSON.stringify(Array.isArray(sizesArr) ? sizesArr : JSON.parse(sizesArr)), frontImage, backImage, JSON.stringify(extraImages), inStock, estCost, stockQty);
      const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
      product.sizes = JSON.parse(product.sizes || '[]'); product.extra_images = JSON.parse(product.extra_images || '[]'); product.collections = JSON.parse(product.collections || '[]'); product.on_sale = Boolean(product.on_sale); product.in_stock = Boolean(product.in_stock);
      res.status(201).json(product);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PUT update product (admin only)
  router.put('/api/products/:id', requireCsrf, requireAuth, upload.fields([{ name: 'front_image', maxCount: 1 }, { name: 'back_image', maxCount: 1 }, { name: 'extra_images', maxCount: 4 }]), async (req, res) => {
    try {
      const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Product not found' });
      const { name, category, fit, price, sale_price, description, sizes, in_stock, unit_cost, stock_qty, remove_front, remove_back } = req.body;
      let frontImage = existing.front_image ?? null; let backImage = existing.back_image ?? null;
      if (req.files?.front_image?.[0]) { const newUrl = await persistImage(req.files.front_image[0].buffer, req.files.front_image[0].originalname); if (existing.front_image) await removeImage(existing.front_image); frontImage = newUrl; } else if (remove_front === 'true') { if (existing.front_image) await removeImage(existing.front_image); frontImage = null; }
      if (req.files?.back_image?.[0]) { const newUrl = await persistImage(req.files.back_image[0].buffer, req.files.back_image[0].originalname); if (existing.back_image) await removeImage(existing.back_image); backImage = newUrl; } else if (remove_back === 'true') { if (existing.back_image) await removeImage(existing.back_image); backImage = null; }
      let extraImages = []; try { extraImages = JSON.parse(existing.extra_images || '[]'); } catch (e) { extraImages = []; }
      if (req.files?.extra_images) { for (const f of req.files.extra_images) { extraImages.push(await persistImage(f.buffer, f.originalname)); } }
      const sizesArr = sizes || existing.sizes || JSON.stringify(['S', 'M', 'L', 'XL', 'XXL']); const salePriceVal = sale_price !== undefined ? sale_price : existing.sale_price; const onSale = sale_price ? 1 : 0;
      const finalName = name || existing.name; const finalCategory = category || existing.category; const finalFit = fit !== undefined ? fit : existing.fit; const finalPrice = price !== undefined ? parseFloat(price) : existing.price; const finalDesc = description !== undefined ? description : existing.description;
      const finalInStock = in_stock !== undefined ? (in_stock === 'true' || in_stock === true ? 1 : 0) : existing.in_stock; const finalUnitCost = unit_cost !== undefined && unit_cost !== '' ? Math.max(0, parseFloat(unit_cost) || 0) : existing.unit_cost;
      const finalStockQty = (stock_qty !== undefined && stock_qty !== '' && stock_qty !== null) ? Math.max(0, Number(stock_qty) || 0) : existing.stock_qty;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      await db.prepare('UPDATE products SET name=?, category=?, fit=?, price=?, sale_price=?, on_sale=?, description=?, sizes=?, front_image=?, back_image=?, extra_images=?, in_stock=?, unit_cost=?, stock_qty=?, updated_at=? WHERE id=?').run(finalName, finalCategory, finalFit, finalPrice, salePriceVal, onSale, finalDesc, JSON.stringify(Array.isArray(sizesArr) ? sizesArr : JSON.parse(sizesArr)), frontImage, backImage, JSON.stringify(extraImages), finalInStock, finalUnitCost, finalStockQty, now, req.params.id);
      const updated = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      updated.sizes = JSON.parse(updated.sizes || '[]'); updated.extra_images = JSON.parse(updated.extra_images || '[]'); updated.collections = JSON.parse(updated.collections || '[]'); updated.on_sale = Boolean(updated.on_sale); updated.in_stock = Boolean(updated.in_stock);
      res.json(updated);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // DELETE product (admin only)
  router.delete('/api/products/:id', requireCsrf, requireAuth, async (req, res) => {
    try {
      const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Product not found' });
      if (existing.front_image) await removeImage(existing.front_image); if (existing.back_image) await removeImage(existing.back_image);
      let extraImages = []; try { extraImages = JSON.parse(existing.extra_images || '[]'); } catch (e) { extraImages = []; }
      for (const img of extraImages) await removeImage(img);
      await db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PATCH toggle stock (admin only)
  router.patch('/api/products/:id/stock', requireCsrf, requireAuth, async (req, res) => {
    try {
      const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Product not found' });
      const newStock = existing.in_stock ? 0 : 1;
      await db.prepare('UPDATE products SET in_stock = ? WHERE id = ?').run(newStock, req.params.id);
      res.json({ success: true, in_stock: Boolean(newStock) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PATCH quick-update stock quantity (admin only)
  router.patch('/api/products/:id/stock-qty', requireCsrf, requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid product ID' });
      const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Product not found' });
      const { stock_qty } = req.body;
      if (stock_qty == null || stock_qty === '' || isNaN(Number(stock_qty))) return res.status(400).json({ error: 'stock_qty must be a number' });
      const qty = Math.max(0, Math.floor(Number(stock_qty)));
      await db.prepare('UPDATE products SET stock_qty = ?, in_stock = ? WHERE id = ?').run(qty, qty > 0 ? 1 : 0, id);
      const updated = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      res.json({ success: true, stock_qty: updated.stock_qty, in_stock: Boolean(updated.in_stock) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};

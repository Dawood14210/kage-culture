// ================================================================
// KAGE Culture — Product routes
// ================================================================
const express = require('express');
const multer = require('multer');
const path = require('path');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth } = require('../middleware/auth');
const { persistImage, removeImage } = require('../utils/helpers');
const sizeStock = require('../utils/sizes');
const productShape = require('../utils/productShape');

function respondToProductWriteError(err, res) {
  console.error('products route failed:', err && err.message ? err.message : err);
  if (err && err.publicMessage) {
    return res.status(err.status || 500).json({ error: err.publicMessage, code: err.code });
  }
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Same filter as /api/upload must use — only real image types get through.
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
  // Payload is built from the public allow-list in utils/productShape.js —
  // `unit_cost` (cost of goods) and the other internal columns stay out of it.
  router.get('/api/products', async (req, res) => {
    try {
      const products = await db.prepare(`SELECT ${productShape.PUBLIC_PRODUCT_SELECT} FROM products ORDER BY created_at DESC, id DESC`).all();
      const sold = await productShape.getSoldCounts(db);
      const revAgg = await productShape.loadReviewAggregates(db);
      const sizeStockById = await sizeStock.loadAllSizeStock(db);
      const parsed = products.map(p => productShape.shapePublicProduct(p, {
        size_stock: sizeStockById.get(Number(p.id)) || null,
        sold_count: sold.get(Number(p.id)) || 0,
        order_count: sold.get(Number(p.id)) || 0, // unchanged: mirrors sold_count
        ...productShape.ratingFields(revAgg.get(Number(p.id)))
      }));
      res.json(parsed);
    } catch (err) { console.error('products route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET single product (public)
  router.get('/api/products/:id', async (req, res) => {
    try {
      const p = await db.prepare(`SELECT ${productShape.PUBLIC_PRODUCT_SELECT} FROM products WHERE id = ?`).get(req.params.id);
      if (!p) return res.status(404).json({ error: 'Product not found' });
      const sold = await productShape.getSoldCounts(db);
      const revAgg = await productShape.loadReviewAggregates(db);
      res.json(productShape.shapePublicProduct(p, {
        size_stock: await sizeStock.loadSizeStock(db, p.id),
        sold_count: sold.get(Number(p.id)) || 0,
        order_count: sold.get(Number(p.id)) || 0, // unchanged: mirrors sold_count
        ...productShape.ratingFields(revAgg.get(Number(p.id)))
      }));
    } catch (err) { console.error('products route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // POST create product (admin only)
  router.post('/api/products', requireCsrf, requireAuth, upload.fields([{ name: 'front_image', maxCount: 1 }, { name: 'back_image', maxCount: 1 }, { name: 'extra_images', maxCount: config.MAX_EXTRA_IMAGES }]), async (req, res) => {
    try {
      const { name, category, fit, price, sale_price, description, sizes, in_stock, stock_qty, unit_cost, size_stock } = req.body;
      const cleanName = String(name || '').trim().slice(0, 120);
      if (!cleanName || !category || price === undefined || price === '' || price === null) return res.status(400).json({ error: 'Name, category, and price are required.' });
      const priceVal = Number(price);
      if (!Number.isFinite(priceVal) || priceVal <= 0) return res.status(400).json({ error: 'Price must be a positive number.' });
      const salePriceVal = sale_price ? Number(sale_price) : null;
      if (salePriceVal != null && (!Number.isFinite(salePriceVal) || salePriceVal <= 0 || salePriceVal >= priceVal)) return res.status(400).json({ error: 'Sale price must be lower than the regular price.' });
      let stockQty = null;
      if (stock_qty !== undefined && stock_qty !== '' && stock_qty !== null) {
        const q = Number(stock_qty);
        if (!Number.isSafeInteger(q) || q < 0) return res.status(400).json({ error: 'Stock quantity must be a non-negative whole number.' });
        stockQty = q;
      }
      let unitCostVal = null;
      if (unit_cost !== undefined && unit_cost !== '' && unit_cost !== null) {
        const c = Number(unit_cost);
        if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: 'Unit cost must be a non-negative number.' });
        unitCostVal = c;
      }
      let sizesParsed = [...sizeStock.DEFAULT_SIZES];
      if (sizes) {
        sizesParsed = sizeStock.parseSizesInput(sizes);
        if (!sizesParsed) return res.status(400).json({ error: 'Invalid sizes format.' });
      }
      // Per-size stock: when given, it is authoritative and the total is its sum.
      const sizeStockInput = sizeStock.parseSizeStockInput(size_stock, sizesParsed);
      if (sizeStockInput.error) return res.status(400).json({ error: sizeStockInput.error });
      if (sizeStockInput.value) stockQty = sizeStock.totalOf(sizeStockInput.value);
      // Persist images only AFTER the body validates, so a 400 never orphans uploads.
      const frontImage = req.files?.front_image?.[0] ? await persistImage(req.files.front_image[0].buffer, req.files.front_image[0].originalname) : null;
      const backImage = req.files?.back_image?.[0] ? await persistImage(req.files.back_image[0].buffer, req.files.back_image[0].originalname) : null;
      const extraImages = []; if (req.files?.extra_images) { for (const f of req.files.extra_images) { extraImages.push(await persistImage(f.buffer, f.originalname)); } }
      const onSale = salePriceVal != null ? 1 : 0;
      const requestedInStock = in_stock !== undefined ? (in_stock === 'true' || in_stock === true ? 1 : 0) : 1;
      const inStock = stockQty === 0 ? 0 : requestedInStock;
      // Honor an admin-entered unit cost (previously this field was silently
      // discarded on create and replaced with a 55% estimate); estimate only
      // when none was provided.
      const estCost = unitCostVal != null ? unitCostVal : Math.max(50, Math.round(priceVal * 0.55));
      const result = await db.prepare('INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, front_image, back_image, extra_images, in_stock, unit_cost, stock_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(cleanName, category, String(fit || '').trim().slice(0, 60), priceVal, salePriceVal, onSale, String(description || '').slice(0, 2000), JSON.stringify(sizesParsed), frontImage, backImage, JSON.stringify(extraImages), inStock, estCost, stockQty);
      if (sizeStockInput.value) await sizeStock.replaceSizeStock(db, result.lastInsertRowid, sizeStockInput.value);
      const product = await db.prepare(`SELECT ${productShape.ADMIN_PRODUCT_SELECT} FROM products WHERE id = ?`).get(result.lastInsertRowid);
      // Admin-only route (requireAuth + requireCsrf): returns the full shape so
      // the panel keeps unit_cost for the edit form and the P&L.
      res.status(201).json(productShape.shapeAdminProduct(product, { size_stock: await sizeStock.loadSizeStock(db, product.id) }));
    } catch (err) { respondToProductWriteError(err, res); }
  });

  // PUT update product (admin only)
  router.put('/api/products/:id', requireCsrf, requireAuth, upload.fields([{ name: 'front_image', maxCount: 1 }, { name: 'back_image', maxCount: 1 }, { name: 'extra_images', maxCount: config.MAX_EXTRA_IMAGES }]), async (req, res) => {
    try {
      const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Product not found' });
      const { name, category, fit, price, sale_price, description, sizes, in_stock, unit_cost, stock_qty, remove_front, remove_back, remove_extra, size_stock } = req.body;
      // Optional JSON array of existing extra-image URLs to delete (the admin
      // form sends it when a gallery photo is removed while editing).
      let removeExtraUrls = [];
      if (remove_extra !== undefined && remove_extra !== null && remove_extra !== '') {
        try { removeExtraUrls = JSON.parse(remove_extra); } catch (e) { return res.status(400).json({ error: 'Invalid extra-image removal list.' }); }
        if (!Array.isArray(removeExtraUrls) || removeExtraUrls.some(u => typeof u !== 'string' || !u.trim())) return res.status(400).json({ error: 'Invalid extra-image removal list.' });
      }
      // Validate the body BEFORE touching files: a rejected request must not
      // delete the existing images or orphan freshly uploaded ones.
      const finalName = name !== undefined && String(name).trim() ? String(name).trim().slice(0, 120) : existing.name;
      const finalCategory = category || existing.category;
      const finalFit = fit !== undefined && fit !== null ? String(fit).trim().slice(0, 60) : existing.fit;
      const finalDesc = description !== undefined && description !== null ? String(description).slice(0, 2000) : existing.description;
      let finalPrice = existing.price;
      if (price !== undefined) {
        const pv = Number(price);
        if (!Number.isFinite(pv) || pv <= 0) return res.status(400).json({ error: 'Price must be a positive number.' });
        finalPrice = pv;
      }
      const salePriceVal = sale_price === undefined ? existing.sale_price : (sale_price === '' || sale_price === null ? null : Number(sale_price));
      if (salePriceVal != null && (!Number.isFinite(salePriceVal) || salePriceVal >= finalPrice || salePriceVal <= 0)) return res.status(400).json({ error: 'Sale price must be lower than the regular price.' });
      const onSale = salePriceVal != null && salePriceVal > 0 ? 1 : 0;
      let finalUnitCost = existing.unit_cost;
      if (unit_cost !== undefined && unit_cost !== '' && unit_cost !== null) {
        const c = Number(unit_cost);
        if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: 'Unit cost must be a non-negative number.' });
        finalUnitCost = c;
      }
      let finalStockQty = existing.stock_qty;
      if (stock_qty !== undefined && stock_qty !== '' && stock_qty !== null) {
        const q = Number(stock_qty);
        if (!Number.isSafeInteger(q) || q < 0) return res.status(400).json({ error: 'Stock quantity must be a non-negative whole number.' });
        finalStockQty = q;
      }
      const finalInStock = in_stock !== undefined ? (in_stock === 'true' || in_stock === true ? 1 : 0) : existing.in_stock;
      let sizesParsed;
      if (sizes !== undefined) {
        sizesParsed = sizeStock.parseSizesInput(sizes);
        if (!sizesParsed) return res.status(400).json({ error: 'Invalid sizes format.' });
      } else {
        sizesParsed = sizeStock.parseSizeColumn(existing.sizes);
      }
      // Stock plan for this save:
      //  * size_stock given       -> replace each size's quantity (every size required)
      //  * already tracked per size -> keep each kept size's quantity, new sizes start at 0
      //  * otherwise               -> legacy shared pool (finalStockQty above)
      const existingSizeStock = await sizeStock.loadSizeStock(db, existing.id);
      const sizeStockInput = sizeStock.parseSizeStockInput(size_stock, sizesParsed);
      if (sizeStockInput.error) return res.status(400).json({ error: sizeStockInput.error });
      let nextSizeStock = sizeStockInput.value;
      if (!nextSizeStock && existingSizeStock) {
        if (stock_qty !== undefined && stock_qty !== '' && stock_qty !== null) return res.status(400).json({ error: 'This product tracks stock per size. Enter a quantity for each size.' });
        nextSizeStock = sizeStock.reconcileSizeStock(existingSizeStock, sizesParsed);
      }
      if (nextSizeStock) finalStockQty = sizeStock.totalOf(nextSizeStock);
      let frontImage = existing.front_image ?? null; let backImage = existing.back_image ?? null;
      if (req.files?.front_image?.[0]) { const newUrl = await persistImage(req.files.front_image[0].buffer, req.files.front_image[0].originalname); if (existing.front_image) await removeImage(existing.front_image); frontImage = newUrl; } else if (remove_front === 'true') { if (existing.front_image) await removeImage(existing.front_image); frontImage = null; }
      if (req.files?.back_image?.[0]) { const newUrl = await persistImage(req.files.back_image[0].buffer, req.files.back_image[0].originalname); if (existing.back_image) await removeImage(existing.back_image); backImage = newUrl; } else if (remove_back === 'true') { if (existing.back_image) await removeImage(existing.back_image); backImage = null; }
      let extraImages = []; try { extraImages = JSON.parse(existing.extra_images || '[]'); } catch (e) { extraImages = []; }
      // Drop any gallery photos the admin removed; ignore URLs that don't
      // belong to this product so a stale form can't delete other files.
      const removedExtras = extraImages.filter(u => u && removeExtraUrls.includes(u));
      extraImages = extraImages.filter(u => !u || !removeExtraUrls.includes(u));
      // Enforce the gallery cap BEFORE persisting anything, so a rejected
      // request neither orphans uploads nor deletes kept images. Only checked
      // when new photos arrive, so legacy products already over the cap can
      // still be edited (and trimmed back down).
      const incomingExtras = req.files?.extra_images?.length || 0;
      if (incomingExtras && extraImages.length + incomingExtras > config.MAX_EXTRA_IMAGES) {
        return res.status(400).json({ error: `A product can have at most ${config.MAX_EXTRA_IMAGES} extra photos.` });
      }
      if (req.files?.extra_images) { for (const f of req.files.extra_images) { extraImages.push(await persistImage(f.buffer, f.originalname)); } }
      for (const url of removedExtras) { try { await removeImage(url); } catch (err) { console.error('extra image cleanup failed:', err && err.message ? err.message : err); } }
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      await db.prepare('UPDATE products SET name=?, category=?, fit=?, price=?, sale_price=?, on_sale=?, description=?, sizes=?, front_image=?, back_image=?, extra_images=?, in_stock=?, unit_cost=?, stock_qty=?, updated_at=? WHERE id=?').run(finalName, finalCategory, finalFit, finalPrice, salePriceVal, onSale, finalDesc, JSON.stringify(sizesParsed), frontImage, backImage, JSON.stringify(extraImages), finalStockQty === 0 ? 0 : finalInStock, finalUnitCost, finalStockQty, now, req.params.id);
      if (nextSizeStock) await sizeStock.replaceSizeStock(db, existing.id, nextSizeStock);
      const updated = await db.prepare(`SELECT ${productShape.ADMIN_PRODUCT_SELECT} FROM products WHERE id = ?`).get(req.params.id);
      res.json(productShape.shapeAdminProduct(updated, { size_stock: await sizeStock.loadSizeStock(db, existing.id) }));
    } catch (err) { respondToProductWriteError(err, res); }
  });

  // DELETE a selected batch of products (admin only)
  // Kept before /:id so Express doesn't treat "batch" as a product ID.
  router.delete('/api/products/batch', requireCsrf, requireAuth, async (req, res) => {
    try {
      const rawIds = req.body && req.body.ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0) return res.status(400).json({ error: 'Select at least one product to delete.' });
      if (rawIds.length > config.MAX_BATCH_PRODUCT_DELETE) return res.status(400).json({ error: `You can delete up to ${config.MAX_BATCH_PRODUCT_DELETE} products at a time.` });
      const ids = [...new Set(rawIds.map(value => typeof value === 'string' && value.trim() ? Number(value) : value))];
      if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: 'Product IDs must be positive whole numbers.' });

      const productsToDelete = [];
      for (const id of ids) {
        const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (product) productsToDelete.push(product);
      }
      if (productsToDelete.length !== ids.length) return res.status(409).json({ error: 'Some selected products no longer exist. Refresh the list and try again.' });

      const deletedIds = [];
      for (const product of productsToDelete) {
        await db.prepare('DELETE FROM product_size_stock WHERE product_id = ?').run(product.id);
        const result = await db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
        if (result && result.changes != null && Number(result.changes) === 0) continue;
        deletedIds.push(Number(product.id));
      }

      // Product rows are removed first; image cleanup is best-effort so a Blob
      // outage cannot leave deleted products stuck in the admin list.
      const imagesToClean = new Set();
      for (const product of productsToDelete) {
        if (!deletedIds.includes(Number(product.id))) continue;
        if (product.front_image) imagesToClean.add(product.front_image);
        if (product.back_image) imagesToClean.add(product.back_image);
        try {
          const extras = JSON.parse(product.extra_images || '[]');
          if (Array.isArray(extras)) extras.forEach(image => { if (image) imagesToClean.add(image); });
        } catch (_) {}
      }
      for (const image of imagesToClean) {
        try { await removeImage(image); }
        catch (err) { console.error('batch product image cleanup failed:', err && err.message ? err.message : err); }
      }

      if (deletedIds.length !== ids.length) return res.status(409).json({ error: 'Some selected products were deleted by another request. Refresh the list and try again.', deletedIds });
      res.json({ success: true, deletedCount: deletedIds.length, deletedIds });
    } catch (err) {
      console.error('batch product delete failed:', err && err.message ? err.message : err);
      res.status(500).json({ error: 'Something went wrong deleting the selected products. Please try again.' });
    }
  });

  // DELETE product (admin only)
  router.delete('/api/products/:id', requireCsrf, requireAuth, async (req, res) => {
    try {
      const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Product not found' });
      if (existing.front_image) await removeImage(existing.front_image); if (existing.back_image) await removeImage(existing.back_image);
      let extraImages = []; try { extraImages = JSON.parse(existing.extra_images || '[]'); } catch (e) { extraImages = []; }
      for (const img of extraImages) await removeImage(img);
      await db.prepare('DELETE FROM product_size_stock WHERE product_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { console.error('products route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // PATCH toggle stock (admin only)
  router.patch('/api/products/:id/stock', requireCsrf, requireAuth, async (req, res) => {
    try {
      const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Product not found' });
      const newStock = existing.in_stock ? 0 : 1;
      if (newStock && existing.stock_qty != null && Number(existing.stock_qty) <= 0) return res.status(400).json({ error: 'Restock this product before marking it in stock.' });
      await db.prepare('UPDATE products SET in_stock = ? WHERE id = ?').run(newStock, req.params.id);
      res.json({ success: true, in_stock: Boolean(newStock) });
    } catch (err) { console.error('products route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // PATCH quick-update stock quantity (admin only)
  router.patch('/api/products/:id/stock-qty', requireCsrf, requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid product ID' });
      const existing = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Product not found' });
      const { stock_qty } = req.body;
      const parsedQty = Number(stock_qty);
      if (stock_qty == null || stock_qty === '' || !Number.isSafeInteger(parsedQty) || parsedQty < 0) return res.status(400).json({ error: 'Stock quantity must be a non-negative whole number.' });
      const qty = parsedQty;
      const perSize = await sizeStock.loadSizeStock(db, id);
      if (perSize) {
        // A single total cannot be split across several sizes; those are edited per size.
        const sizes = sizeStock.parseSizeColumn(existing.sizes);
        if (sizes.length !== 1) return res.status(400).json({ error: 'This product tracks stock per size. Edit the product to set each size.' });
        await sizeStock.replaceSizeStock(db, id, { [sizes[0]]: qty });
        await db.prepare('UPDATE products SET in_stock = ? WHERE id = ?').run(qty > 0 ? 1 : 0, id);
        const tracked = await db.prepare('SELECT stock_qty, in_stock FROM products WHERE id = ?').get(id);
        return res.json({ success: true, stock_qty: Number(tracked.stock_qty), in_stock: Boolean(tracked.in_stock) });
      }
      await db.prepare('UPDATE products SET stock_qty = ?, in_stock = ? WHERE id = ?').run(qty, qty > 0 ? 1 : 0, id);
      const updated = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      res.json({ success: true, stock_qty: updated.stock_qty, in_stock: Boolean(updated.in_stock) });
    } catch (err) { console.error('products route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  return router;
};

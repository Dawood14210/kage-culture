// ================================================================
// KAGE Culture — Review routes
// ================================================================
const express = require('express');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth } = require('../middleware/auth');

module.exports = function createReviewRoutes(db) {
  const router = express.Router();
  const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10);

  // POST submit review (public)
  router.post('/api/reviews', requireCsrf, async (req, res) => {
    try {
      const { product_id, order_number, phone, rating, comment, name } = req.body;
      const pid = parseInt(product_id, 10); const rf = parseFloat(rating); const r = Math.round(rf);
      if (!pid || isNaN(pid)) return res.status(400).json({ error: 'Invalid product.' });
      if (isNaN(rf) || r < 1 || r > 5) return res.status(400).json({ error: 'Please select a rating from 1 to 5 stars.' });
      const num = String(order_number || '').trim().toUpperCase(); const ph = String(phone || '').trim();
      if (!num || !ph) return res.status(400).json({ error: 'Order number and phone are required to verify your purchase.' });
      const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(num);
      if (!order || normPhone(order.phone) !== normPhone(ph)) return res.status(404).json({ error: "We couldn't find an order matching that number and phone." });
      if (order.status !== 'delivered') return res.status(403).json({ error: 'Reviews unlock once your order is delivered. Current status: ' + order.status + '.' });
      let items = []; try { items = JSON.parse(order.items_json || '[]'); } catch (e) { items = []; }
      if (!items.some(i => String(i.id) === String(pid))) return res.status(403).json({ error: "That product wasn't part of this order." });
      const dup = await db.prepare('SELECT id FROM reviews WHERE order_number = ? AND product_id = ?').get(num, pid);
      if (dup) return res.status(409).json({ error: 'You have already reviewed this product.' });
      const cleanComment = String(comment || '').trim().slice(0, 1000); const customerName = String(name || '').trim().slice(0, 60) || 'Verified Buyer';
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      await db.prepare('INSERT INTO reviews (product_id, order_number, customer_name, rating, comment, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(pid, num, customerName, r, cleanComment, 'pending', now);
      res.status(201).json({ success: true, message: 'Thanks for your review! It will appear on the site once approved.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET approved reviews for a product (public)
  router.get('/api/reviews', async (req, res) => {
    try {
      const pid = parseInt(req.query.product_id, 10);
      if (!pid || isNaN(pid)) return res.json([]);
      const rows = await db.prepare('SELECT id, customer_name, rating, comment, created_at FROM reviews WHERE product_id = ? AND status = ?').all(pid, 'approved');
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET all reviews (admin only)
  router.get('/api/reviews/all', requireAuth, async (req, res) => {
    try { const rows = await db.prepare('SELECT * FROM reviews ORDER BY id DESC').all(); res.json(rows); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PATCH review status (admin only)
  router.patch('/api/reviews/:id', requireCsrf, requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid review ID.' });
      const { status } = req.body;
      if (!['approved', 'pending', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
      const existing = await db.prepare('SELECT id FROM reviews WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Review not found.' });
      await db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // DELETE review (admin only)
  router.delete('/api/reviews/:id', requireCsrf, requireAuth, async (req, res) => {
    try { const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid review ID.' }); await db.prepare('DELETE FROM reviews WHERE id = ?').run(id); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};

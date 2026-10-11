// ================================================================
// KAGE Culture — Review routes
// ================================================================
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth } = require('../middleware/auth');

// Reviews strictly above this rating skip moderation and publish immediately.
// Ratings are integers 1–5, so > 3.5 means 4- and 5-star reviews auto-approve.
const AUTO_APPROVE_ABOVE = config.REVIEW_AUTO_APPROVE_ABOVE;

// Per-browser token that lets a reviewer see their OWN pending review right
// away. It is a capability token (only reveals "your" pending reviews), so it
// is deliberately low-ceremony: sanitized to [A-Za-z0-9_-], max 64 chars.
function sanitizeViewerToken(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

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
      // Keep the browser's existing viewer token if it sent a sane one;
      // otherwise mint a fresh one so the submitter can see their own
      // pending review immediately on this device.
      const viewerToken = sanitizeViewerToken(req.body.viewer_token) || crypto.randomBytes(24).toString('hex');
      // 4- and 5-star reviews (> 3.5) publish without moderation; anything
      // lower waits for admin approval but is still visible to its author.
      const autoApproved = rf > AUTO_APPROVE_ABOVE;
      const status = autoApproved ? 'approved' : 'pending';
      await db.prepare('INSERT INTO reviews (product_id, order_number, customer_name, rating, comment, status, viewer_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(pid, num, customerName, r, cleanComment, status, viewerToken, now);
      res.status(201).json({
        success: true,
        approved: autoApproved,
        viewer_token: viewerToken,
        message: autoApproved
          ? "Thanks for your review! It's live on the site."
          : 'Thanks for your review! It is visible to you below and will appear publicly once approved.'
      });
    } catch (err) { console.error('reviews route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET reviews for a product (public)
  // Everyone sees approved reviews; a reviewer holding the viewer_token that
  // was returned to them at submit time also sees their OWN pending review,
  // so it appears for them immediately (rejected reviews never surface).
  router.get('/api/reviews', async (req, res) => {
    try {
      const pid = parseInt(req.query.product_id, 10);
      if (!pid || isNaN(pid)) return res.json([]);
      const viewer = sanitizeViewerToken(req.query.viewer_token);
      const rows = await db.prepare('SELECT id, customer_name, rating, comment, created_at, status, viewer_token FROM reviews WHERE product_id = ? AND status != ?').all(pid, 'rejected');
      const visible = rows.filter(rv => rv.status === 'approved' || (rv.status === 'pending' && viewer && rv.viewer_token === viewer));
      res.json(visible.map(rv => ({
        id: rv.id,
        customer_name: rv.customer_name,
        rating: rv.rating,
        comment: rv.comment,
        created_at: rv.created_at,
        status: rv.status,
        is_own: rv.status !== 'approved'
      })));
    } catch (err) { console.error('reviews route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET all reviews (admin only)
  router.get('/api/reviews/all', requireAuth, async (req, res) => {
    try { const rows = await db.prepare('SELECT * FROM reviews ORDER BY id DESC').all(); res.json(rows); } catch (err) { console.error('reviews route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
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
    } catch (err) { console.error('reviews route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // DELETE review (admin only)
  router.delete('/api/reviews/:id', requireCsrf, requireAuth, async (req, res) => {
    try { const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid review ID.' }); await db.prepare('DELETE FROM reviews WHERE id = ?').run(id); res.json({ success: true }); } catch (err) { console.error('reviews route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  return router;
};

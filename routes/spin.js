// ================================================================
// KAGE Culture — Spin wheel routes
// ================================================================
const express = require('express');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { spinLimiter } = require('../middleware/rateLimit');

const KAGE_ANIMALS = ['bear', 'black-panther', 'white-fox', 'white-tiger'];
const KAGE_RARITY = { 'bear': { rarity: 'common', weight: 45 }, 'black-panther': { rarity: 'uncommon', weight: 25 }, 'white-fox': { rarity: 'rare', weight: 20 }, 'white-tiger': { rarity: 'mythic', weight: 10 } };

module.exports = function createSpinRoutes(db) {
  const router = express.Router();

  // GET spin status
  router.get('/api/spin/status', async (req, res) => {
    try {
      const { email } = req.query;
      if (!email) return res.status(400).json({ error: 'Email is required.' });
      const clean = String(email).trim().toLowerCase();
      const allOrders = await db.prepare('SELECT items_json FROM orders WHERE email = ?').all(clean);
      let totalShirts = 0;
      for (const o of allOrders) { const items = JSON.parse(o.items_json || '[]'); for (const it of items) { totalShirts += (it.qty || 0); } }
      let ticket = await db.prepare('SELECT * FROM spin_tickets WHERE email = ?').get(clean);
      if (!ticket) { await db.prepare('INSERT INTO spin_tickets (email, spins_remaining, total_spins_earned) VALUES (?, 0, 0)').run(clean); ticket = await db.prepare('SELECT * FROM spin_tickets WHERE email = ?').get(clean); }
      const spinsOwed = Math.max(0, totalShirts - (ticket.total_spins_earned || 0));
      if (spinsOwed > 0) {
        const newRemaining = (ticket.spins_remaining || 0) + spinsOwed; const newEarned = (ticket.total_spins_earned || 0) + spinsOwed;
        await db.prepare('UPDATE spin_tickets SET spins_remaining = ?, total_spins_earned = ? WHERE email = ?').run(newRemaining, newEarned, clean);
        ticket.spins_remaining = newRemaining; ticket.total_spins_earned = newEarned;
      }
      let stickers = []; try { stickers = await db.prepare('SELECT animal, count FROM sticker_collection WHERE email = ?').all(clean); } catch (_) { stickers = []; }
      const collection = {}; KAGE_ANIMALS.forEach(a => { collection[a] = 0; }); stickers.forEach(s => { collection[s.animal] = s.count || 0; });
      const uniqueCount = Object.values(collection).filter(v => v > 0).length;
      res.json({ email: clean, total_shirts: totalShirts, spins_remaining: ticket.spins_remaining || 0, total_spins_earned: ticket.total_spins_earned || 0, total_spins_used: ticket.total_spins_used || 0, collection, unique_count: uniqueCount, has_all_four: uniqueCount >= 4, animals: KAGE_ANIMALS });
    } catch (err) { console.error('spin route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // POST execute spin
  router.post('/api/spin/execute', spinLimiter, requireCsrf, async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ error: 'Email is required.' });
      const clean = String(email).trim().toLowerCase();
      let ticket = await db.prepare('SELECT * FROM spin_tickets WHERE email = ?').get(clean);
      if (!ticket || (ticket.spins_remaining || 0) <= 0) return res.status(403).json({ error: 'No spins remaining. Order more shirts to earn spins!' });
      await db.prepare('UPDATE spin_tickets SET spins_remaining = ?, total_spins_used = ? WHERE email = ?').run(ticket.spins_remaining - 1, (ticket.total_spins_used || 0) + 1, clean);
      const roll = Math.random() * 100; let cumulative = 0; let animal = 'bear';
      for (const a of KAGE_ANIMALS) { cumulative += KAGE_RARITY[a].weight; if (roll < cumulative) { animal = a; break; } }
      const existing = await db.prepare('SELECT id, count FROM sticker_collection WHERE email = ? AND animal = ?').get(clean, animal);
      if (existing) await db.prepare('UPDATE sticker_collection SET count = ? WHERE id = ?').run(existing.count + 1, existing.id);
      else await db.prepare('INSERT INTO sticker_collection (email, animal, count) VALUES (?, ?, 1)').run(clean, animal);
      const updatedTicket = await db.prepare('SELECT * FROM spin_tickets WHERE email = ?').get(clean);
      const stickers = await db.prepare('SELECT animal, count FROM sticker_collection WHERE email = ?').all(clean);
      const collection = {}; KAGE_ANIMALS.forEach(a => { collection[a] = 0; }); stickers.forEach(s => { collection[s.animal] = s.count || 0; });
      const uniqueCount = Object.values(collection).filter(v => v > 0).length;
      res.json({ success: true, animal, spins_remaining: updatedTicket.spins_remaining || 0, collection, unique_count: uniqueCount, has_all_four: uniqueCount >= 4 });
    } catch (err) { console.error('spin route failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // POST re-spin — DISABLED
  router.post('/api/spin/respin', spinLimiter, requireCsrf, async (req, res) => {
    res.status(503).json({ error: 'Re-spins are temporarily unavailable while we set up payment verification.' });
  });

  return router;
};

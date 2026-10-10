// ================================================================
// KAGE Culture — Order routes
// ================================================================
const express = require('express');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth, requireCustomerAuth } = require('../middleware/auth');
const { orderLimiter } = require('../middleware/rateLimit');
const { sendOrderConfirmation, sendStatusUpdate } = require('../utils/email');
const sizeStock = require('../utils/sizes');

module.exports = function createOrderRoutes(db) {
  const router = express.Router();
  const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10);

  // Put back (direction +1) or take out (direction -1) one order line's units.
  // Per-size lines adjust that size's row; legacy lines adjust the shared pool.
  // Removing floors at 0 so concurrent sales can never drive stock negative.
  async function adjustLineStock(db, it, direction) {
    const qty = Number(it.qty) || 1;
    const p = await db.prepare('SELECT id, stock_qty FROM products WHERE id = ?').get(it.id);
    if (!p) return;
    const perSize = await sizeStock.loadSizeStock(db, p.id);
    if (perSize) {
      if (!Object.prototype.hasOwnProperty.call(perSize, it.size)) return;
      const next = Math.max(0, (perSize[it.size] || 0) + direction * qty);
      await db.prepare('UPDATE product_size_stock SET stock_qty = ? WHERE product_id = ? AND size = ?').run(next, p.id, it.size);
      await sizeStock.syncProductStock(db, p.id);
      if (direction > 0) await db.prepare('UPDATE products SET in_stock = 1 WHERE id = ?').run(p.id);
      return;
    }
    if (p.stock_qty == null) return;
    const newQty = direction > 0 ? Number(p.stock_qty) + qty : Math.max(0, Number(p.stock_qty) - qty);
    await db.prepare('UPDATE products SET stock_qty = ?, in_stock = ? WHERE id = ?').run(newQty, direction > 0 || newQty > 0 ? 1 : 0, p.id);
  }

  // POST place order (public)
  router.post('/api/orders', orderLimiter, requireCsrf, async (req, res) => {
    try {
      const { name, email, phone, address, city, notes, payment_method, payment_ref, items } = req.body;
      if (!name || !email || !phone || !address || !city) return res.status(400).json({ error: 'Name, email, phone, address and city are required.' });
      if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Your cart is empty.' });
      const method = payment_method === 'bank' ? 'bank' : payment_method === 'jazzcash' ? 'jazzcash' : 'cod';
      if ((method === 'jazzcash' || method === 'bank') && !payment_ref) return res.status(400).json({ error: 'Payment reference number is required for JazzCash/Bank Transfer.' });

      const lineItems = []; const skipped = []; let subtotal = 0;
      for (const it of items) {
        const id = parseInt(it.id, 10); const qty = Math.min(99, Math.max(1, parseInt(it.qty, 10) || 1)); const size = String(it.size || '').slice(0, 10);
        const p = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (!p || !p.in_stock) { skipped.push(it); continue; }
        if (!sizeStock.parseSizeColumn(p.sizes).includes(size)) return res.status(400).json({ error: `Size "${size}" is not offered for "${p.name}". Please review your cart.` });
        // Per-size products check the requested size's own count; legacy products use the shared pool.
        const perSize = await sizeStock.loadSizeStock(db, p.id);
        const stock = perSize ? (perSize[size] || 0) : ((p.stock_qty != null && p.stock_qty !== '') ? Number(p.stock_qty) : null);
        if (stock != null && qty > stock) {
          if (perSize && stock === 0) return res.status(400).json({ error: `"${p.name}" is sold out in size ${size}. Please review your cart.` });
          return res.status(400).json({ error: `Only ${stock} ${stock === 1 ? 'unit' : 'units'} of "${p.name}"${perSize ? ` in size ${size}` : ''} left in stock. Please reduce the quantity.` });
        }
        const unit = (p.sale_price && p.sale_price < p.price) ? p.sale_price : p.price; const lineTotal = unit * qty;
        const unitCost = (p.unit_cost && p.unit_cost > 0) ? p.unit_cost : Math.round(unit * 0.55);
        subtotal += lineTotal;
        lineItems.push({ id: p.id, name: p.name, size, qty, unit: Math.round(unit), total: Math.round(lineTotal), cost: Math.round(unitCost) * qty, image: p.front_image || null, stock, perSize: !!perSize });
      }
      if (skipped.length > 0) return res.status(400).json({ error: 'Some items in your cart are unavailable or out of stock. Please review your cart.' });
      if (lineItems.length === 0) return res.status(400).json({ error: 'Your cart is empty.' });

      const shipping = config.SHIPPING_COST; const total = Math.round(subtotal) + shipping;
      let orderNumber;
      do { orderNumber = 'KAGE-' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 10).toUpperCase().padEnd(8, 'Z'); } while (await db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber));
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const initialStatus = method === 'cod' ? 'pending' : 'awaiting_verification';
      const result = await db.prepare('INSERT INTO orders (order_number, customer_name, email, phone, address, city, notes, payment_method, payment_ref, subtotal, shipping, total, items_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(orderNumber, String(name).slice(0, 120), String(email).slice(0, 160), String(phone).slice(0, 40), String(address).slice(0, 300), String(city).slice(0, 120), String(notes || '').slice(0, 500), method, String(payment_ref || '').slice(0, 100) || null, Math.round(subtotal), shipping, total, JSON.stringify(lineItems), initialStatus, now);

      // Atomic stock decrement — `WHERE stock_qty >= ?` guards against the
      // SELECT-then-UPDATE overselling race: if stock changed between the
      // availability check above and now, the UPDATE matches 0 rows and we
      // reject the order. (Backends report `changes`; a backend without it
      // is assumed to have applied the guarded UPDATE.)
      // Lines already decremented are restored if a later line fails, so a
      // rejected order never leaves stock consumed.
      const applied = [];
      const restoreApplied = async () => {
        for (const a of applied.reverse()) {
          if (a.perSize) {
            await db.prepare('UPDATE product_size_stock SET stock_qty = stock_qty + ? WHERE product_id = ? AND size = ?').run(a.qty, a.id, a.size);
            await sizeStock.syncProductStock(db, a.id);
          } else {
            await db.prepare('UPDATE products SET stock_qty = stock_qty + ?, in_stock = 1 WHERE id = ?').run(a.qty, a.id);
          }
        }
      };
      for (const it of lineItems) {
        if (it.stock == null) continue;
        let changed;
        if (it.perSize) {
          // Guarded per-size decrement: the WHERE clause rejects the sale if that size ran out meanwhile.
          const upd = await db.prepare('UPDATE product_size_stock SET stock_qty = stock_qty - ? WHERE product_id = ? AND size = ? AND stock_qty >= ?').run(it.qty, it.id, it.size, it.qty);
          changed = upd && upd.changes != null ? Number(upd.changes) : 1;
          if (changed) { applied.push({ id: it.id, size: it.size, qty: it.qty, perSize: true }); await sizeStock.syncProductStock(db, it.id); }
        } else {
          const upd = await db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?').run(it.qty, it.id, it.qty);
          changed = upd && upd.changes != null ? Number(upd.changes) : 1;
          if (changed) { applied.push({ id: it.id, qty: it.qty, perSize: false }); await db.prepare('UPDATE products SET in_stock = ? WHERE id = ? AND stock_qty <= 0').run(0, it.id); }
        }
        if (!changed) {
          // Roll back the just-inserted order and any earlier decrements so no phantom order remains.
          try { await restoreApplied(); } catch (_) {}
          try { await db.prepare('DELETE FROM orders WHERE id = ?').run(result.lastInsertRowid); } catch (_) {}
          return res.status(400).json({ error: `Sorry — "${it.name}"${it.perSize ? ` (size ${it.size})` : ''} just sold out or has fewer units left than requested. Please review your cart.` });
        }
      }

      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
      order.items = JSON.parse(order.items_json || '[]');

      let totalShirts = 0;
      try { const allOrders = await db.prepare('SELECT items_json FROM orders WHERE email = ?').all(String(email).toLowerCase()); for (const o of allOrders) { const itms = JSON.parse(o.items_json || '[]'); for (const it of itms) { totalShirts += (it.qty || 0); } } } catch (_) {}
      const clanEligible = totalShirts >= config.CLAN_THRESHOLD;
      const alreadyMember = !!(await db.prepare('SELECT id FROM newsletter_subscribers WHERE email = ?').get(String(email).toLowerCase()));

      const payload = { order_number: order.order_number, customer_name: order.customer_name, email: order.email, phone: order.phone, address: order.address, city: order.city, notes: order.notes, payment_method: order.payment_method, payment_ref: order.payment_ref, subtotal: order.subtotal, shipping: order.shipping, total: order.total, items: order.items, status: order.status, created_at: order.created_at, total_shirts: totalShirts, clan_eligible: clanEligible, clan_member: alreadyMember };

      // Await the confirmation email BEFORE responding — on Vercel the lambda
      // can freeze right after res.json(), killing fire-and-forget promises.
      try { await sendOrderConfirmation({ ...order, items: order.items }); }
      catch (e) { console.error('Order confirmation email failed:', e.message); }

      res.status(201).json(payload);
    } catch (err) { console.error('order placement failed:', err.message); res.status(500).json({ error: 'Something went wrong placing your order. Please try again.' }); }
  });

  // GET track order (public) — requires order number + matching phone
  router.get('/api/orders/track', async (req, res) => {
    try {
      const { number, phone } = req.query;
      if (!number || !phone) return res.status(400).json({ error: 'Order number and phone are required.' });
      const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(number).trim().toUpperCase());
      if (!order || normPhone(order.phone) !== normPhone(phone)) return res.status(404).json({ error: "We couldn't find an order with that number and phone." });
      const { email, address, notes, items_json, ...safe } = order; safe.items = JSON.parse(order.items_json || '[]'); res.json(safe);
    } catch (err) { console.error('order track failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET single order (public) — requires the order number AND matching phone
  // (same verification as /track). Previously this returned name, address and
  // payment details to anyone who knew/guessed an order number.
  router.get('/api/orders/:orderNumber', async (req, res) => {
    try {
      const { phone } = req.query;
      if (!phone) return res.status(401).json({ error: 'Phone verification required. Use /api/orders/track?number=...&phone=... instead.' });
      const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(req.params.orderNumber).trim().toUpperCase());
      if (!order || normPhone(order.phone) !== normPhone(phone)) return res.status(404).json({ error: "We couldn't find an order with that number and phone." });
      const { email, address, notes, items_json, ...safe } = order; safe.items = JSON.parse(order.items_json || '[]'); res.json(safe);
    } catch (err) { console.error('order lookup failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET all orders (admin only) — supports search
  router.get('/api/orders', requireAuth, async (req, res) => {
    try {
      const { search, status } = req.query;
      let orders;
      if (search && search.trim()) {
        const q = '%' + search.trim().toLowerCase() + '%';
        orders = await db.prepare("SELECT * FROM orders WHERE LOWER(customer_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(order_number) LIKE ? ORDER BY created_at DESC, id DESC").all(q, q, q);
      } else if (status && status.trim()) {
        orders = await db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC, id DESC').all(status.trim());
      } else {
        orders = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
      }
      orders.forEach(o => { o.items = JSON.parse(o.items_json || '[]'); }); res.json(orders);
    } catch (err) { console.error('orders list failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET CSV export (admin only)
  router.get('/api/orders/export/csv', requireAuth, async (req, res) => {
    try {
      const { status } = req.query;
      let orders = status && status.trim() ? await db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC, id DESC').all(status.trim()) : await db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
      const header = 'Order Number,Customer Name,Email,Phone,Address,City,Payment Method,Payment Reference,COD Confirmed,Subtotal,Shipping,Total,Status,Created At\n';
      const rows = orders.map(o => [o.order_number, `"${String(o.customer_name || '').replace(/"/g, '""')}"`, o.email, o.phone, `"${String(o.address || '').replace(/"/g, '""')}"`, o.city, o.payment_method, o.payment_ref || '', o.cod_confirmed ? 'Yes' : 'No', o.subtotal, o.shipping, o.total, o.status, o.created_at].join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="kage-orders-${new Date().toISOString().slice(0,10)}.csv"`);
      res.send(header + rows);
    } catch (err) { console.error('orders CSV export failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // PATCH update order status (admin only)
  router.patch('/api/orders/:id/status', requireCsrf, requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid order ID' });
      const { status } = req.body;
      if (!config.ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status. Allowed: ' + config.ORDER_STATUSES.join(', ') });
      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (status === 'cancelled' && order.status !== 'cancelled') {
        let items = []; try { items = JSON.parse(order.items_json || '[]'); } catch (e) { items = []; }
        for (const it of items) { await adjustLineStock(db, it, +1); }
      } else if (order.status === 'cancelled' && status !== 'cancelled') {
        // Reactivating a cancelled order must take the units back out of stock,
        // otherwise cancel → reset → cancel cycles inflate inventory forever.
        // Floor at 0 so concurrent sales can never drive stock negative.
        let items = []; try { items = JSON.parse(order.items_json || '[]'); } catch (e) { items = []; }
        for (const it of items) { await adjustLineStock(db, it, -1); }
      }
      const oldStatus = order.status;
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
      const updated = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      updated.items = JSON.parse(updated.items_json || '[]');
      if (oldStatus !== status) {
        // Await BEFORE responding — serverless lambdas freeze after res.json()
        try { await sendStatusUpdate({ ...updated, items: updated.items }, oldStatus); }
        catch (e) { console.error('Status email failed:', e.message); }
      }
      res.json(updated);
    } catch (err) { console.error('order status update failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // PATCH mark payment verified (admin only)
  router.patch('/api/orders/:id/verify-payment', requireCsrf, requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid order ID' });
      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      await db.prepare('UPDATE orders SET payment_verified = ? WHERE id = ?').run(req.body.verified !== false ? 1 : 0, id);
      const updated = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id); updated.items = JSON.parse(updated.items_json || '[]'); res.json(updated);
    } catch (err) { console.error('payment verify failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // PATCH confirm COD payment (admin only)
  router.patch('/api/orders/:id/cod-confirm', requireCsrf, requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid order ID' });
      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.payment_method !== 'cod') return res.status(400).json({ error: 'This order is not a COD order.' });
      await db.prepare('UPDATE orders SET cod_confirmed = ? WHERE id = ?').run(req.body.confirmed !== false ? 1 : 0, id);
      const updated = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id); updated.items = JSON.parse(updated.items_json || '[]'); res.json(updated);
    } catch (err) { console.error('COD confirm failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET customer order history
  router.get('/api/customers/orders', requireCustomerAuth, async (req, res) => {
    try {
      const customer = await db.prepare('SELECT email, phone FROM customers WHERE id = ?').get(req.customerId);
      if (!customer) return res.status(404).json({ error: 'Account not found.' });
      const orders = await db.prepare('SELECT * FROM orders WHERE email = ? OR phone = ? ORDER BY created_at DESC, id DESC').all(customer.email, customer.phone);
      orders.forEach(o => { o.items = JSON.parse(o.items_json || '[]'); }); res.json({ orders });
    } catch (err) { console.error('customer orders failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  return router;
};

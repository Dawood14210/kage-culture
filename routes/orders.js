// ================================================================
// KAGE Culture — Order routes
// ================================================================
const express = require('express');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth, requireCustomerAuth, optionalCustomerId } = require('../middleware/auth');
const { orderLimiter, strictLimiter } = require('../middleware/rateLimit');
const { sendOrderConfirmation, sendStatusUpdate } = require('../utils/email');
const sizeStock = require('../utils/sizes');
const productShape = require('../utils/productShape');
const { hasControlChars, isValidEmail, csvCell } = require('../utils/helpers');

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

  // Which lines cannot be fully re-taken? Returns [] when every line fits.
  // A missing product or size row counts as a shortage (nothing to take back).
  async function findStockShortages(db, items) {
    const shortages = [];
    for (const it of items) {
      const qty = Number(it.qty) || 1;
      const product = await db.prepare('SELECT id, name, stock_qty FROM products WHERE id = ?').get(it.id);
      if (!product) { shortages.push({ name: it.name || `product #${it.id}`, size: it.size || null, needed: qty, available: null }); continue; }
      const perSize = await sizeStock.loadSizeStock(db, product.id);
      if (perSize) {
        if (!Object.prototype.hasOwnProperty.call(perSize, it.size)) { shortages.push({ name: product.name, size: it.size || null, needed: qty, available: null }); continue; }
        const available = Number(perSize[it.size]) || 0;
        if (available < qty) shortages.push({ name: product.name, size: it.size, needed: qty, available });
        continue;
      }
      const available = Number(product.stock_qty) || 0;
      if (available < qty) shortages.push({ name: product.name, size: it.size || null, needed: qty, available });
    }
    return shortages;
  }

  function shortageMessage(shortages) {
    const detail = shortages.map((s) => {
      const label = `"${s.name}"` + (s.size ? ` (size ${s.size})` : '');
      return s.available === null
        ? `${label} is no longer stocked`
        : `${label} — ${s.needed} needed, ${s.available} available`;
    }).join('; ');
    return `Cannot reactivate this order: not enough stock — ${detail}. Nothing was changed.`;
  }

  // POST place order (public)
  router.post('/api/orders', orderLimiter, requireCsrf, async (req, res) => {
    try {
      const { name, email, phone, address, city, notes, payment_method, payment_ref, items } = req.body;
      if (!name || !email || !phone || !address || !city) return res.status(400).json({ error: 'Name, email, phone, address and city are required.' });
      // Normalise the email at the door: order history is matched on the
      // lowercased value, so "Buyer@Kage.test" must not become a second,
      // unreachable history for the same person.
      const cleanEmail = String(email).trim().toLowerCase();
      // Same rule as signup: an unvalidated address is both an unusable
      // confirmation email and a header-injection vector.
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      // Order fields are single-line. Control characters (CR/LF/NUL/tab) are
      // how email header injection and display spoofing start, so reject them
      // outright instead of trying to clean them up.
      for (const [field, value] of [['name', name], ['address', address], ['city', city], ['notes', notes], ['payment_ref', payment_ref]]) {
        if (hasControlChars(value)) return res.status(400).json({ error: `The ${field} field contains invalid characters.` });
      }
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

      // Delivery charges are confirmed with the customer after placement; do not
      // add an unconfirmed flat fee to the checkout/API total.
      const shipping = 0; const shippingPending = 1; const total = Math.round(subtotal);
      let orderNumber;
      do { orderNumber = 'KAGE-' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 10).toUpperCase().padEnd(8, 'Z'); } while (await db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber));
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const initialStatus = method === 'cod' ? 'pending' : 'awaiting_verification';
      // Attribute the order to the signed-in customer when there is one; the
      // order history endpoint matches on this id (plus a verified email).
      const orderCustomerId = optionalCustomerId(req);
      const result = await db.prepare('INSERT INTO orders (order_number, customer_name, email, phone, address, city, notes, payment_method, payment_ref, subtotal, shipping, shipping_pending, total, items_json, status, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(orderNumber, String(name).slice(0, 120), cleanEmail.slice(0, 160), String(phone).slice(0, 40), String(address).slice(0, 300), String(city).slice(0, 120), String(notes || '').slice(0, 500), method, String(payment_ref || '').slice(0, 100) || null, Math.round(subtotal), shipping, shippingPending, total, JSON.stringify(lineItems), initialStatus, orderCustomerId, now);
      // A new order changes every affected product's sold_count — drop the
      // cached aggregate so the storefront shows it right away.
      productShape.invalidateProductAggregates();

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
      try { const allOrders = await db.prepare('SELECT items_json FROM orders WHERE LOWER(TRIM(email)) = ?').all(String(email).trim().toLowerCase()); for (const o of allOrders) { const itms = JSON.parse(o.items_json || '[]'); for (const it of itms) { totalShirts += (it.qty || 0); } } } catch (_) {}
      const clanEligible = totalShirts >= config.CLAN_THRESHOLD;
      const alreadyMember = !!(await db.prepare('SELECT id FROM newsletter_subscribers WHERE LOWER(TRIM(email)) = ?').get(String(email).trim().toLowerCase()));

      const payload = { order_number: order.order_number, customer_name: order.customer_name, email: order.email, phone: order.phone, address: order.address, city: order.city, notes: order.notes, payment_method: order.payment_method, payment_ref: order.payment_ref, subtotal: order.subtotal, shipping: order.shipping, shipping_pending: !!order.shipping_pending, total: order.total, items: order.items, status: order.status, created_at: order.created_at, total_shirts: totalShirts, clan_eligible: clanEligible, clan_member: alreadyMember };

      // Await the confirmation email BEFORE responding — on Vercel the lambda
      // can freeze right after res.json(), killing fire-and-forget promises.
      try { await sendOrderConfirmation({ ...order, items: order.items }); }
      catch (e) { console.error('Order confirmation email failed:', e.message); }

      res.status(201).json(payload);
    } catch (err) { console.error('order placement failed:', err.message); res.status(500).json({ error: 'Something went wrong placing your order. Please try again.' }); }
  });

  // GET track order (public) — requires order number + matching phone
  router.get('/api/orders/track', strictLimiter, async (req, res) => {
    try {
      const { number, phone } = req.query;
      if (!number || !phone) return res.status(400).json({ error: 'Order number and phone are required.' });
      const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(number).trim().toUpperCase());
      if (!order || normPhone(order.phone) !== normPhone(phone)) return res.status(404).json({ error: "We couldn't find an order with that number and phone." });
      const { email, address, notes, items_json, ...safe } = order; safe.items = JSON.parse(order.items_json || '[]'); safe.shipping_pending = !!safe.shipping_pending; res.json(safe);
    } catch (err) { console.error('order track failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET single order (public) — requires the order number AND matching phone
  // (same verification as /track). Previously this returned name, address and
  // payment details to anyone who knew/guessed an order number.
  router.get('/api/orders/:orderNumber', strictLimiter, async (req, res) => {
    try {
      const { phone } = req.query;
      if (!phone) return res.status(401).json({ error: 'Phone verification required. Use /api/orders/track?number=...&phone=... instead.' });
      const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(req.params.orderNumber).trim().toUpperCase());
      if (!order || normPhone(order.phone) !== normPhone(phone)) return res.status(404).json({ error: "We couldn't find an order with that number and phone." });
      const { email, address, notes, items_json, ...safe } = order; safe.items = JSON.parse(order.items_json || '[]'); safe.shipping_pending = !!safe.shipping_pending; res.json(safe);
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
      // Every text column goes through csvCell (RFC 4180 quoting + formula
      // shielding); the three money columns may stay unquoted, but only when
      // they are genuinely finite numbers.
      const csvNumber = (value) => {
        if (value === null || value === undefined || value === '') return '';
        const n = Number(value);
        return Number.isFinite(n) ? String(n) : csvCell(value);
      };
      const header = ['Order Number', 'Customer Name', 'Email', 'Phone', 'Address', 'City',
        'Payment Method', 'Payment Reference', 'COD Confirmed', 'Subtotal', 'Shipping',
        'Delivery Charge Pending', 'Total', 'Status', 'Created At', 'Notes'].map(csvCell).join(',');
      const rows = orders.map(o => [
        csvCell(o.order_number), csvCell(o.customer_name), csvCell(o.email), csvCell(o.phone),
        csvCell(o.address), csvCell(o.city), csvCell(o.payment_method), csvCell(o.payment_ref),
        csvCell(o.cod_confirmed ? 'Yes' : 'No'), csvNumber(o.subtotal), csvNumber(o.shipping),
        csvCell(o.shipping_pending && o.status !== 'cancelled' ? 'Yes' : 'No'), csvNumber(o.total),
        csvCell(o.status), csvCell(o.created_at), csvCell(o.notes)
      ].join(','));
      // BOM so Excel reads non-ASCII names; CRLF is the RFC 4180 line ending.
      const csv = '\uFEFF' + header + '\r\n' + (rows.length ? rows.join('\r\n') + '\r\n' : '');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="kage-orders-${new Date().toISOString().slice(0,10)}.csv"`);
      res.send(csv);
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
        // Check EVERY line first: if any of them cannot be fully re-taken (the
        // stock was sold to someone else meanwhile) refuse the whole change with
        // a 409 and change nothing — the old floor-at-0 silently under-counted.
        let items = []; try { items = JSON.parse(order.items_json || '[]'); } catch (e) { items = []; }
        const shortages = await findStockShortages(db, items);
        if (shortages.length) return res.status(409).json({ error: shortageMessage(shortages) });
        for (const it of items) { await adjustLineStock(db, it, -1); }
      }
      const oldStatus = order.status;
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
      // Cancel/reactivate moves units in or out of the sold totals.
      if (oldStatus !== status) productShape.invalidateProductAggregates();
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

  // Customer-facing order shape: exactly what the account page renders.
  // SECURITY: never the raw row — `notes`, `payment_ref`, `email`, `phone`,
  // `address`, `payment_verified`, `customer_id` and the per-line `cost`
  // (unit cost) must not leave the server.
  function sanitizeCustomerOrder(o) {
    let items = [];
    try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; }
    return {
      order_number: o.order_number,
      status: o.status,
      payment_method: o.payment_method,
      items: (Array.isArray(items) ? items : []).map((it) => ({
        id: it.id, name: it.name, size: it.size, qty: it.qty,
        unit: it.unit, total: it.total, image: it.image
      })),
      subtotal: o.subtotal,
      shipping: o.shipping,
      shipping_pending: !!o.shipping_pending,
      total: o.total,
      created_at: o.created_at
    };
  }

  // GET customer order history
  // SECURITY: matched on customer_id, or on the account's own email once that
  // email is verified. Phone is NOT a match key any more — a profile phone is
  // unverified, so anyone could type a stranger's number and read their orders.
  router.get('/api/customers/orders', requireCustomerAuth, async (req, res) => {
    try {
      const customer = await db.prepare('SELECT id, email, email_verified FROM customers WHERE id = ?').get(req.customerId);
      if (!customer) return res.status(404).json({ error: 'Account not found.' });
      const verified = Number(customer.email_verified) === 1;
      if (!verified) {
        // Unverified signups (which may be someone else's address) get no
        // history — the UI shows the "verify your email" prompt instead.
        return res.json({ orders: [], email_verified: false });
      }
      const email = String(customer.email || '').trim().toLowerCase();
      const byId = await db.prepare('SELECT * FROM orders WHERE customer_id = ?').all(customer.id);
      const byEmail = await db.prepare('SELECT * FROM orders WHERE LOWER(TRIM(email)) = ?').all(email);
      const merged = new Map();
      for (const o of [...(byId || []), ...(byEmail || [])]) if (!merged.has(o.id)) merged.set(o.id, o);
      const orders = [...merged.values()].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id - a.id));
      res.json({ orders: orders.map(sanitizeCustomerOrder), email_verified: true });
    } catch (err) { console.error('customer orders failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  return router;
};

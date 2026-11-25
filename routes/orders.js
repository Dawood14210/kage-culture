// ================================================================
// KAGE Culture — Order routes
// ================================================================
const express = require('express');
const crypto = require('crypto');
const path = require('node:path');
const { waitUntil } = require('@vercel/functions');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth, requireCustomerAuth, optionalCustomerId } = require('../middleware/auth');
const { orderIpFloorLimiter, orderIdentityLimiter, trackingIpFloorLimiter, trackingIdentityLimiter, clearOrdersLimiter } = require('../middleware/rateLimit');
const bcrypt = require('bcryptjs');
const { sendOrderConfirmation, sendStatusUpdate } = require('../utils/email');
const sizeStock = require('../utils/sizes');
const productShape = require('../utils/productShape');
const { adjustLineStock, findStockShortages, shortageMessage } = require('../utils/orderStock');
const { ordersToCsv } = require('../utils/ordersCsv');
const { clearAllOrders, CLEAR_PHRASE } = require('../utils/clearOrders');
const { hasControlChars, isValidEmail, isValidPkMobile } = require('../utils/helpers');

// Response-first email delivery. On Vercel a promise created after res.json()
// can be frozen with the lambda, so hand it to waitUntil(); everywhere else
// (local/dev/test) the handler awaits it *after* the response has been sent,
// keeping email assertions deterministic without making clients wait for SMTP.
function afterResponse(res, job, label) {
  const task = Promise.resolve().then(job).then(
    (sent) => {
      if (sent === false) console.error(`[email_failed] ${label}: provider reported failure`);
      else console.info(`[email_sent] ${label}`);
      return sent;
    },
    (err) => {
      console.error(`[email_failed] ${label}:`, err && err.message ? err.message : err);
    }
  );
  if (process.env.VERCEL && typeof waitUntil === 'function') {
    waitUntil(task);
    return Promise.resolve();
  }
  // res.json() has already flushed by this point; awaiting here cannot add to
  // the client's latency, it only keeps the local process alive for the send.
  void res;
  return task;
}

module.exports = function createOrderRoutes(db) {
  const router = express.Router();
  const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10);

  // POST place order (public)
  router.post('/api/orders', orderIpFloorLimiter, orderIdentityLimiter, requireCsrf, async (req, res) => {
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
      // Pakistani mobile only — the delivery rider calls this number, so a
      // landline or a typo'd digit is a failed delivery. Spaces/dashes are OK.
      if (!isValidPkMobile(phone)) {
        return res.status(400).json({ error: 'Enter a valid mobile number, e.g. 0300 1234567.' });
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

      // D1: customers see the published Rs. 250–500 band; the exact fee
      // (DELIVERY_FEES per city, F3) is confirmed by phone before dispatch,
      // so no flat fee enters the total.
      const shipping = 0; const shippingPending = 1; const total = Math.round(subtotal);
      let orderNumber;
      // F30: unguessable, collision-checked order numbers from CSPRNG bytes
      // (Math.random is predictable and too weak for an order identifier).
      do { orderNumber = 'KAGE-' + crypto.randomBytes(4).toString('hex').toUpperCase(); } while (await db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber));
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

  // POST track order (public) — requires order number + matching phone.
  // F16: POST + CSRF + strict rate limit. Order numbers and phone numbers
  // no longer travel in the URL (browser history, shared caches, CDN and
  // proxy logs), and a cross-site page cannot replay the lookup as a GET.
  router.post('/api/orders/track', trackingIpFloorLimiter, trackingIdentityLimiter, requireCsrf, async (req, res) => {
    try {
      const { number, phone } = req.body || {};
      if (!number || !phone) return res.status(400).json({ error: 'Order number and phone are required.' });
      const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(number).trim().toUpperCase());
      if (!order || normPhone(order.phone) !== normPhone(phone)) return res.status(404).json({ error: "We couldn't find an order with that number and phone." });
      const { email, address, notes, items_json, ...safe } = order; safe.items = JSON.parse(order.items_json || '[]'); safe.shipping_pending = !!safe.shipping_pending; res.json(safe);
    } catch (err) { console.error('order track failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET single order (public) — requires the order number AND matching phone
  // (same verification as /track). Previously this returned name, address and
  // payment details to anyone who knew/guessed an order number.
  router.get('/api/orders/:orderNumber', trackingIpFloorLimiter, trackingIdentityLimiter, async (req, res) => {
    try {
      const { phone } = req.query;
      if (!phone) return res.status(401).json({ error: 'Phone verification required. Use POST /api/orders/track with { number, phone } instead.' });
      const order = await db.prepare('SELECT * FROM orders WHERE order_number = ?').get(String(req.params.orderNumber).trim().toUpperCase());
      if (!order || normPhone(order.phone) !== normPhone(phone)) return res.status(404).json({ error: "We couldn't find an order with that number and phone." });
      const { email, address, notes, items_json, ...safe } = order; safe.items = JSON.parse(order.items_json || '[]'); safe.shipping_pending = !!safe.shipping_pending; res.json(safe);
    } catch (err) { console.error('order lookup failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET orders (admin only) — server-side status/search filters + pagination.
  // Response: { orders, total, limit, offset }. The CSV export below stays
  // unpaginated; only the interactive list is paged.
  router.get('/api/orders', requireAuth, async (req, res) => {
    try {
      const search = String(req.query.search || '').trim().toLowerCase();
      const status = String(req.query.status || '').trim();
      const limit = Math.min(config.ORDER_LIST_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || config.ORDER_LIST_DEFAULT_LIMIT));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const matches = (o) => (!status || o.status === status) && (!search || [o.order_number, o.customer_name, o.email, o.phone]
        .some(v => String(v || '').toLowerCase().includes(search)));
      const sortRows = (rows) => rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (Number(b.id) - Number(a.id)));

      let rows, total;
      // The dev-only in-memory store emulates a small subset of SQL (it cannot
      // parse the OR/LIMIT parts), so filter and page it in JS. Turso and
      // sql.js do the work in the database, which is the point of pagination.
      const backend = require('../database').activeBackend;
      if (backend === 'mem') {
        const all = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
        const filtered = sortRows(all.filter(matches));
        total = filtered.length;
        rows = filtered.slice(offset, offset + limit);
      } else {
        const clauses = [];
        const args = [];
        if (status) { clauses.push('status = ?'); args.push(status); }
        if (search) {
          clauses.push('(LOWER(customer_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(order_number) LIKE ? OR LOWER(phone) LIKE ?)');
          const q = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
          args.push(q, q, q, q);
        }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        const [countRow, page] = await Promise.all([
          db.prepare(`SELECT COUNT(*) AS c FROM orders ${where}`).get(...args),
          db.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
        ]);
        total = Number(countRow && countRow.c) || 0;
        rows = sortRows(page);
      }
      // F3: the fee we will confirm by phone before dispatch. Placeholder
      // rates from config.DELIVERY_FEES until the owner confirms them —
      // admin-only, the customer-facing total contract is unchanged.
      const orders = rows.map(o => ({ ...o, items: JSON.parse(o.items_json || '[]'), delivery_fee_expected: config.deliveryFeeForCity(o.city) }));
      res.setHeader('X-Total-Count', String(total));
      res.json({ orders, total, limit, offset });
    } catch (err) { console.error('orders list failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // GET CSV export (admin only)
  router.get('/api/orders/export/csv', requireAuth, async (req, res) => {
    try {
      const { status, search } = req.query;
      let orders = status && status.trim() ? await db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC, id DESC').all(status.trim()) : await db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
      // CSV is deliberately unpaginated; the same search box narrows it too.
      if (search && String(search).trim()) {
        const q = String(search).trim().toLowerCase();
        orders = orders.filter(o => [o.order_number, o.customer_name, o.email, o.phone].some(v => String(v || '').toLowerCase().includes(q)));
      }
      const csv = ordersToCsv(orders);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="kage-orders-${new Date().toISOString().slice(0,10)}.csv"`);
      res.send(csv);
    } catch (err) { console.error('orders CSV export failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // Settings → Danger zone reads the live count before showing the modal, and
  // can download the very CSV that the automatic backup will also contain.
  router.get('/api/admin/orders/count', requireAuth, async (req, res) => {
    try {
      const row = await db.prepare('SELECT COUNT(*) AS c FROM orders').get();
      res.json({ count: Number(row && row.c) || 0 });
    } catch (err) { console.error('orders count failed:', err.message); res.status(500).json({ error: 'Something went wrong.' }); }
  });

  router.get('/api/admin/orders/backup', requireAuth, async (req, res) => {
    try {
      const orders = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="kage-orders-backup-${new Date().toISOString().slice(0,10)}.csv"`);
      res.send(ordersToCsv(orders));
    } catch (err) { console.error('orders backup download failed:', err.message); res.status(500).json({ error: 'Something went wrong.' }); }
  });

  // Destructive, deliberate and NEVER automatic: rate-limited admin + CSRF +
  // current password + exact phrase. The shared tool backs up before writing.
  router.delete('/api/orders/all', clearOrdersLimiter, requireCsrf, requireAuth, async (req, res) => {
    try {
      if (String((req.body || {}).phrase || (req.body || {}).confirm) !== CLEAR_PHRASE) {
        return res.status(400).json({ error: `Type ${CLEAR_PHRASE} exactly to clear all orders.` });
      }
      const admin = await db.prepare('SELECT password_hash FROM admin WHERE id = ?').get(req.adminId);
      const match = admin ? await bcrypt.compare(String((req.body || {}).password || ''), admin.password_hash) : false;
      if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
      const result = await clearAllOrders(db, {
        phrase: CLEAR_PHRASE,
        source: 'admin',
        actor: req.adminId
      });
      res.json({
        cleared: result.count,
        restoredOrders: result.restoredOrders,
        restoredLines: result.restoredLines,
        backups: Object.fromEntries(Object.entries(result.backups).map(([k, v]) => [k, path.basename(v)]))
      });
    } catch (err) {
      console.error('[orders_cleared_failed]', err.message);
      if (err.code === 'BACKUP_FAILED') return res.status(500).json({ error: 'Backup could not be written. No orders were deleted.' });
      res.status(500).json({ error: 'Could not clear orders. No orders were deleted.' });
    }
  });

  // PATCH update order status (admin only)
  router.patch('/api/orders/:id/status', requireCsrf, requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (isNaN(id)) return res.status(400).json({ error: 'Invalid order ID' });
      const { status, silent } = req.body;
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
      // One write, then reconcile from the row we already read: a second SELECT
      // after the UPDATE is another Turso hop for a value we already know.
      // RETURNING would save it too, but the local sql.js and mem adapters
      // don't expose returning rows, so the shared path stays portable.
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
      // Cancel/reactivate moves units in or out of the sold totals.
      if (oldStatus !== status) productShape.invalidateProductAggregates();
      let items = [];
      try { items = JSON.parse(order.items_json || '[]'); } catch (e) { items = []; }
      const updated = { ...order, status, items };
      res.json(updated);
      // Email is a side effect, not part of the mutation contract. `silent`
      // is used by the undo button so a status round-trip never double-mails a
      // customer. On Vercel waitUntil keeps the send alive; locally the
      // handler awaits it after the response for deterministic tests.
      if (oldStatus === status) return;
      if (silent === true) {
        console.info('[email_skipped] status update for order', order.order_number, '(silent undo)');
        return;
      }
      await afterResponse(res, () => sendStatusUpdate(updated, oldStatus), `status update for order ${order.order_number}`);
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
  // SECURITY: an explicit allow-list, never the raw row. The account page needs
  // the order's own delivery and payment facts, so those are included here —
  // but only behind a verified session (see loadCustomerHistory, which is the
  // only caller). What must never leave the server: `customer_id`, `items_json`,
  // `email`, the per-line `cost` (unit cost), stock and any margin column.
  // Full detail for the account page: what was ordered, what it cost, how it
  // was paid for and where it went.
  function sanitizeCustomerOrder(o) {
    let items = [];
    try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; }
    const sanitized = {
      order_number: o.order_number,
      status: o.status,
      payment_method: o.payment_method,
      payment_ref: o.payment_ref || null,
      payment_verified: Number(o.payment_verified) === 1,
      cod_confirmed: Number(o.cod_confirmed) === 1,
      items: (Array.isArray(items) ? items : []).map((it) => ({
        id: it.id, name: it.name, size: it.size, qty: it.qty,
        unit: it.unit, total: it.total, image: it.image
      })),
      subtotal: o.subtotal,
      shipping: o.shipping,
      shipping_pending: !!o.shipping_pending,
      total: o.total,
      notes: o.notes || null,
      created_at: o.created_at,
      customer_name: o.customer_name,
      address: o.address,
      city: o.city,
      phone: o.phone
    };
    return sanitized;
  }

  // ----------------------------------------------------------------
  // Order history for a signed-in customer
  // ----------------------------------------------------------------
  // Matching is customer_id OR the account's own email. Both columns are
  // written by checkout, so the history is complete even for orders placed
  // as a guest with the same address. Phone is NOT a match key: a profile
  // phone is unverified, so anyone could type a stranger's number and read
  // their orders.
  //
  // Verification gates access, not the shape of the response: an account that
  // has not proven the address sees nothing, because that address may not be
  // theirs at all.
  async function loadCustomerHistory(customerId) {
    const customer = await db.prepare('SELECT id, email, email_verified FROM customers WHERE id = ?').get(customerId);
    if (!customer) return null;
    const verified = Number(customer.email_verified) === 1;
    const email = String(customer.email || '').trim().toLowerCase();
    const byId = await db.prepare('SELECT * FROM orders WHERE customer_id = ?').all(customer.id);
    const byEmail = await db.prepare('SELECT * FROM orders WHERE LOWER(TRIM(email)) = ?').all(email);
    const merged = new Map();
    for (const o of [...(byId || []), ...(byEmail || [])]) if (!merged.has(o.id)) merged.set(o.id, o);
    const orders = [...merged.values()].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id - a.id));
    return { customer, verified, orders };
  }

  router.get('/api/customers/orders', requireCustomerAuth, async (req, res) => {
    try {
      const history = await loadCustomerHistory(req.customerId);
      if (!history) return res.status(404).json({ error: 'Account not found.' });
      if (!history.verified) {
        // Unverified signups (which may be someone else's address) get no
        // history — the UI shows the "verify your email" prompt instead.
        return res.json({ orders: [], email_verified: false });
      }
      res.json({ orders: history.orders.map(sanitizeCustomerOrder), email_verified: true });
    } catch (err) { console.error('customer orders failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // One order, for API clients that want a single record. Scoped to the caller's
  // own history — an order number belonging to somebody else answers 404, not
  // 403, so it cannot be used to probe which numbers exist.
  router.get('/api/customers/orders/:number', requireCustomerAuth, async (req, res) => {
    try {
      const history = await loadCustomerHistory(req.customerId);
      if (!history) return res.status(404).json({ error: 'Account not found.' });
      if (!history.verified) return res.status(403).json({ error: 'Verify your email address to view your orders.' });
      const wanted = String(req.params.number || '').trim().toUpperCase();
      const order = history.orders.find((o) => String(o.order_number).toUpperCase() === wanted);
      if (!order) return res.status(404).json({ error: 'Order not found in your history.' });
      res.json({ order: sanitizeCustomerOrder(order), email_verified: true });
    } catch (err) { console.error('customer order detail failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  return router;
};

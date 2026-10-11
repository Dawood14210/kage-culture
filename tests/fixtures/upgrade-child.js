// ================================================================
// Spawned by tests/upgrade-migration.test.js — boots the server against a
// LEGACY database file (tests/fixtures/legacy-schema.js) and reports what
// happened as one `RESULT: {json}` line.
// ----------------------------------------------------------------
// Usage: node upgrade-child.js <snapshot|exercise>
//   snapshot  boot, then report the database state (used for the second boot
//             that must be a complete no-op)
//   exercise  boot + report, then place an order, sign up + verify a customer,
//             read that customer's order history, and log in as a merged
//             duplicate account — all over HTTP against the real app
//
// Backend is chosen by the parent: KAGE_DB_FILE → sql.js file backend,
// TURSO_DATABASE_URL → libsql/Turso backend (`file:/abs/path` works locally).
//
// KAGE_UPGRADE_DB_MODULE optionally points at a JS file to load as database.js
// instead of the working-tree module — the negative control runs this exact
// fixture against the pre-fix database.js saved from git.
// ================================================================
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'upgrade-fixture-secret-0123456789abcdef';
process.env.SITE_URL = process.env.SITE_URL || 'https://shop.kage.test';
process.env.EMAIL_API_KEY = '';

const path = require('path');
const http = require('http');

// Negative-control hook: pre-populate the require cache for the working-tree
// database.js so every `require('./database')` (server.js, routes, …) gets the
// supplied implementation instead. Never used by the normal run.
if (process.env.KAGE_UPGRADE_DB_MODULE) {
  const target = require.resolve('../../database.js');
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: require(path.resolve(process.env.KAGE_UPGRADE_DB_MODULE))
  };
}

const db = require('../../database.js');
const serverModule = require('../../server.js');
const app = serverModule.app || serverModule;

const [command] = process.argv.slice(2);

// ---------------------------------------------------------------- HTTP
function request(port, method, pathname, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(headers || {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { /* non-JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieHeader(res) {
  return (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
}

// CSRF middleware sets the cookie on the first GET; the token is its value.
async function getCsrf(port) {
  const r = await request(port, 'GET', '/api/products');
  const sc = (r.headers['set-cookie'] || []).find((c) => c.startsWith('kage.csrf='));
  if (!sc) throw new Error('no CSRF cookie issued');
  const cookie = sc.split(';')[0];
  return { cookie, token: cookie.split('=')[1] };
}

// ---------------------------------------------------------------- snapshot
const names = (rows) => (rows || []).map((r) => String(r.name));
const rowsOf = (rows, keys) => (rows || []).map((r) => Object.fromEntries(keys.map((k) => [k, r[k] === undefined ? null : r[k]])));

async function snapshot() {
  const tableList = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const indexList = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").all();
  const columns = {};
  for (const table of names(tableList)) {
    const info = await db.prepare(`PRAGMA table_info(${table})`).all();
    columns[table] = names(info).sort();
  }
  return {
    backend: db.activeBackend,
    tables: names(tableList),
    indexes: names(indexList),
    columns,
    settings: await db.prepare('SELECT key, value FROM app_settings ORDER BY key').all(),
    orders: rowsOf(await db.prepare('SELECT id, order_number, customer_name, email, phone, address, city, notes, payment_method, subtotal, shipping, total, status, items_json, created_at, customer_id FROM orders ORDER BY id').all(),
      ['id', 'order_number', 'customer_name', 'email', 'phone', 'address', 'city', 'notes', 'payment_method', 'subtotal', 'shipping', 'total', 'status', 'items_json', 'created_at', 'customer_id']),
    customers: rowsOf(await db.prepare('SELECT id, email, name, phone, address, city, created_at, email_verified FROM customers ORDER BY id').all(),
      ['id', 'email', 'name', 'phone', 'address', 'city', 'created_at', 'email_verified']),
    products: rowsOf(await db.prepare('SELECT id, name, category, price, sale_price, on_sale, stock_qty, in_stock, unit_cost FROM products ORDER BY id').all(),
      ['id', 'name', 'category', 'price', 'sale_price', 'on_sale', 'stock_qty', 'in_stock', 'unit_cost']),
    reviews: rowsOf(await db.prepare('SELECT id, product_id, order_number, customer_name, rating, comment, status, viewer_token FROM reviews ORDER BY id').all(),
      ['id', 'product_id', 'order_number', 'customer_name', 'rating', 'comment', 'status', 'viewer_token']),
    newsletter: rowsOf(await db.prepare('SELECT id, email FROM newsletter_subscribers ORDER BY id').all(), ['id', 'email']),
    sizeStock: rowsOf(await db.prepare('SELECT product_id, size, stock_qty FROM product_size_stock ORDER BY product_id, size').all(), ['product_id', 'size', 'stock_qty']),
    passwordResetTokens: rowsOf(await db.prepare('SELECT id, user_type, user_id, token_hash, used FROM password_reset_tokens ORDER BY id').all(), ['id', 'user_type', 'user_id', 'token_hash', 'used'])
  };
}

// ---------------------------------------------------------------- exercise
async function exercise(port) {
  const flow = {};
  const step = async (name, fn) => {
    try { flow[name] = { ok: true, ...(await fn()) }; }
    catch (e) { flow[name] = { ok: false, error: e.message }; }
    return flow[name];
  };

  await step('storefront', async () => {
    const r = await request(port, 'GET', '/api/products');
    const legacy = (r.json || []).find((p) => p.name === 'Legacy Graphic Tee');
    return { status: r.status, legacyVisible: !!legacy, legacyId: legacy && legacy.id, legacyStock: legacy && legacy.stock_qty };
  });

  await step('order', async () => {
    const csrf = await getCsrf(port);
    const r = await request(port, 'POST', '/api/orders', {
      body: {
        name: 'Legacy Buyer',
        email: 'Buyer.Legacy@Kage.test',
        phone: '03334455667',
        address: '9 Gulberg',
        city: 'Lahore',
        payment_method: 'cod',
        items: [{ id: flow.storefront && flow.storefront.legacyId, qty: 1, size: 'M' }]
      },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    return { status: r.status, orderNumber: r.json && r.json.order_number, error: r.json && r.json.error };
  });

  await step('signup+verify', async () => {
    // Capture the dev-mode email log to pull the single-use verification link.
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => { lines.push(args.map(String).join(' ')); originalLog.apply(console, args); };
    let signup;
    try {
      const csrf = await getCsrf(port);
      signup = await request(port, 'POST', '/api/customers/signup', {
        body: { email: 'buyer.legacy@kage.test', password: 'legacy-buyer-pass', name: 'Legacy Buyer' },
        headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
      });
    } finally { console.log = originalLog; }
    const cookie = cookieHeader(signup);
    const match = lines.join('\n').match(/https?:\/\/[^\s"]*\/verify-email\?token=[a-f0-9]+/);
    let landing = null;
    let verified = null;
    if (match) {
      // Exactly what a real user does: open the emailed link (the SPA page),
      // then let that page consume the token through the API.
      const link = new URL(match[0]);
      landing = await request(port, 'GET', link.pathname + link.search);
      const csrf = await getCsrf(port);
      verified = await request(port, 'POST', '/api/customers/verify-email', {
        body: { token: link.searchParams.get('token') },
        headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
      });
    }
    return {
      signupStatus: signup.status,
      verifyLinkFound: !!match,
      verifyLandingStatus: landing && landing.status,
      verifyStatus: verified && verified.status,
      verifyBody: verified && verified.json,
      cookie
    };
  });

  await step('history', async () => {
    const cookie = flow['signup+verify'] && flow['signup+verify'].cookie;
    const r = await request(port, 'GET', '/api/customers/orders', { headers: { Cookie: cookie } });
    return {
      status: r.status,
      emailVerified: r.json && r.json.email_verified,
      orderNumbers: ((r.json && r.json.orders) || []).map((o) => o.order_number).sort(),
      error: r.json && r.json.error
    };
  });

  await step('mergedLogin', async () => {
    const csrf = await getCsrf(port);
    const r = await request(port, 'POST', '/api/customers/login', {
      body: { email: 'Dupe@Kage.test', password: 'first-dupe-pass' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    const wrong = await request(port, 'POST', '/api/customers/login', {
      body: { email: 'dupe@kage.test', password: 'second-dupe-pass' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    return {
      survivorLoginStatus: r.status,
      survivorName: r.json && r.json.customer && r.json.customer.name,
      mergedPasswordStillWorks: wrong.status === 200
    };
  });

  return flow;
}

// ---------------------------------------------------------------- main
let phase = 'boot';
(async () => {
  try { await serverModule.getReady(); }
  catch (e) {
    console.log('RESULT: ' + JSON.stringify({ ok: false, command, backend: db.activeBackend, phase: 'boot', error: e.message }));
    process.exit(0);
  }

  phase = 'snapshot';
  const before = await snapshot();

  let flow = null;
  let after = null;
  if (command === 'exercise') {
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
      phase = 'exercise';
      flow = await exercise(server.address().port);
    } finally {
      await new Promise((r) => server.close(r));
    }
    phase = 'snapshot';
    after = await snapshot();
  }
  await db.save();

  const result = { ok: true, command, backend: before.backend, before, flow, after };
  console.log('RESULT: ' + JSON.stringify(result));
  process.exit(0);
})().catch((err) => {
  console.error('FIXTURE ERROR:', err && err.stack ? err.stack : err);
  console.log('RESULT: ' + JSON.stringify({ ok: false, command, backend: db.activeBackend, phase, error: err && err.message }));
  process.exit(0);
});

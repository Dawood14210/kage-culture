// ================================================================
// KAGE Culture — E2E regression tests
// Run: node tests/e2e.test.js
//
// Boots the real Express app on an ephemeral port with the in-memory DB
// fallback (local only, never on Vercel), then drives it over HTTP.
// No framework needed — plain node:assert.
// ================================================================
process.env.ALLOW_ADMIN_SETUP = 'true'; // tests exercise the gated bootstrap
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-regression-tests';

const assert = require('assert');
const http = require('http');

// Fresh module state for every run
delete require.cache[require.resolve('../database.js')];
const dbModule = require('../database.js');

const { app, ensureReady } = require('../server.js');

const BASE = 'http://127.0.0.1:0';

function request(port, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(headers || {}) } },
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

// Pull the Set-Cookie pairs out of a login response
function cookieHeader(res) {
  const sc = res.headers['set-cookie'] || [];
  return sc.map((c) => c.split(';')[0]).join('; ');
}

let server, PORT;
const results = [];
function check(name, fn) {
  return fn()
    .then(() => { results.push([name, true, '']); console.log('  ✅', name); })
    .catch((e) => { results.push([name, false, e.message]); console.log('  ❌', name, '—', e.message); });
}

async function main() {
  // Boot DB + seed + routes, then listen on an ephemeral port
  await ensureReady();
  await new Promise((resolve) => {
    server = app.listen(0, () => { PORT = server.address().port; resolve(); });
  });
  console.log(`\nTest server on :${PORT}\n`);

  // ---------------------------------------------------------------
  // 1. requireAuth — HMAC verification (regression for the fixed bypass)
  // ---------------------------------------------------------------
  console.log('Auth middleware:');
  await check('admin login sets a signed session cookie', async () => {
    const r = await request(PORT, 'POST', '/api/admin/setup', { body: { email: 'root@kage.test', password: 'supersecret1' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const r2 = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'root@kage.test', password: 'supersecret1' } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
    assert.ok(cookieHeader(r2).includes('kage.session='), 'expected kage.session cookie');
  });

  let adminCookie = '';
  {
    const r = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'root@kage.test', password: 'supersecret1' } });
    adminCookie = cookieHeader(r);
  }

  await check('valid admin cookie → 200', async () => {
    const r = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: adminCookie } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json && r.json.admin && r.json.admin.email === 'root@kage.test');
  });

  await check('forged inline adminId payload → 401', async () => {
    const forged = Buffer.from(JSON.stringify({ adminId: 1 })).toString('base64');
    const r = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: `kage.session=${forged}.x` } });
    assert.strictEqual(r.status, 401);
  });

  await check('tampered payload + valid-looking sig → 401', async () => {
    const payload = Buffer.from(JSON.stringify({ adminId: 1 })).toString('base64');
    const badSig = Buffer.from('totally-invalid-signature-bytes!!').toString('base64');
    const r = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: `kage.session=${payload}.${badSig}` } });
    assert.strictEqual(r.status, 401);
  });

  await check('no cookie → 401', async () => {
    const r = await request(PORT, 'GET', '/api/admin/me');
    assert.strictEqual(r.status, 401);
  });

  await check('customer session on admin route → 401', async () => {
    const csrf = await getCsrf();
    await request(PORT, 'POST', '/api/customers/signup', { body: { email: 'cust@kage.test', password: 'custpass1', name: 'Cust' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    const login = await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'custpass1' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    const custCookie = cookieHeader(login);
    const r = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: custCookie } });
    assert.strictEqual(r.status, 401);
  });

  // ---------------------------------------------------------------
  // 2. Admin setup gating (C1)
  // ---------------------------------------------------------------
  console.log('\nAdmin setup gate:');
  await check('setup with wrong secret email reuse → 400 (account exists)', async () => {
    const r = await request(PORT, 'POST', '/api/admin/setup', { body: { email: 'root@kage.test', password: 'whatever1' } });
    assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  });

  // ---------------------------------------------------------------
  // 3. Order PII endpoint (H1)
  // ---------------------------------------------------------------
  console.log('\nOrder endpoints:');
  let orderNumber = '';
  {
    const csrf = await getCsrf();
    const r = await request(PORT, 'POST', '/api/orders', {
      body: {
        name: 'Test Buyer', email: 'buyer@kage.test', phone: '03001234567', address: '1 Test St', city: 'Lahore',
        payment_method: 'cod',
        items: [{ id: 1, qty: 1, size: 'L' }]
      },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    orderNumber = r.json.order_number;
  }

  await check('GET order without phone → 401', async () => {
    const r = await request(PORT, 'GET', `/api/orders/${orderNumber}`);
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check('GET order with wrong phone → 404', async () => {
    const r = await request(PORT, 'GET', `/api/orders/${orderNumber}?phone=03000000000`);
    assert.strictEqual(r.status, 404);
  });

  await check('GET order with matching phone → 200 (sanitized)', async () => {
    const r = await request(PORT, 'GET', `/api/orders/${orderNumber}?phone=03001234567`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json && r.json.order_number === orderNumber);
    assert.ok(!('email' in r.json), 'email must be stripped from public payload');
    assert.ok(!('address' in r.json), 'address must be stripped from public payload');
  });

  await check('/track with matching phone → 200', async () => {
    const r = await request(PORT, 'GET', `/api/orders/track?number=${encodeURIComponent(orderNumber)}&phone=03001234567`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json && r.json.order_number === orderNumber);
  });

  // ---------------------------------------------------------------
  // 4. Order placement decrements stock atomically (M2)
  // ---------------------------------------------------------------
  console.log('\nStock decrement:');
  await check('stock decremented after order', async () => {
    const p = await request(PORT, 'GET', '/api/products/1');
    assert.strictEqual(p.status, 200);
    // Seed product #1 (Shadow Fit) starts at stock 4; one was ordered above.
    assert.strictEqual(Number(p.json.stock_qty), 3, `expected 3, got ${p.json.stock_qty}`);
  });

  await check('order exceeding stock → 400', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'POST', '/api/orders', {
      body: {
        name: 'Test Buyer', email: 'buyer2@kage.test', phone: '03001234568', address: '1 Test St', city: 'Lahore',
        payment_method: 'cod',
        items: [{ id: 1, qty: 99, size: 'L' }]
      },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(r.status, 400);
    assert.ok(/stock/i.test(r.json.error), 'error should mention stock');
  });

  // ---------------------------------------------------------------
  // 5. CSRF on admin mutations (invariant)
  // ---------------------------------------------------------------
  console.log('\nCSRF:');
  await check('admin status update without CSRF → 403', async () => {
    const r = await request(PORT, 'PATCH', '/api/orders/1/status', { body: { status: 'confirmed' }, headers: { Cookie: adminCookie } });
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  });

  // ---------------------------------------------------------------
  // 6. FE-C2 — customer account endpoints (GET/PUT /api/customers/me)
  // ---------------------------------------------------------------
  console.log('\nCustomer account (FE-C2):');
  let custCookie = '';
  {
    const csrf = await getCsrf();
    const login = await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'custpass1' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    assert.strictEqual(login.status, 200, JSON.stringify(login.json));
    custCookie = cookieHeader(login);
  }

  await check('GET /api/customers/me without session → 401', async () => {
    const r = await request(PORT, 'GET', '/api/customers/me');
    assert.strictEqual(r.status, 401);
  });

  await check('GET /api/customers/me with session → customer object, no password_hash', async () => {
    const r = await request(PORT, 'GET', '/api/customers/me', { headers: { Cookie: custCookie } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.customer && r.json.customer.email === 'cust@kage.test');
    assert.ok(!('password_hash' in r.json.customer), 'password_hash must not leak');
  });

  await check('PUT /api/customers/me profile update → persists', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'PUT', '/api/customers/me', {
      body: { name: 'Renamed Cust', phone: '03005559999', address: '2 New St', city: 'Karachi' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: custCookie + '; ' + csrf.cookie }
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.customer.name, 'Renamed Cust');
    const me = await request(PORT, 'GET', '/api/customers/me', { headers: { Cookie: custCookie } });
    assert.strictEqual(me.json.customer.city, 'Karachi', 'update must persist');
  });

  await check('PUT password change with wrong current password → 401', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'PUT', '/api/customers/me', {
      body: { currentPassword: 'wrongpass', newPassword: 'newpass456' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: custCookie + '; ' + csrf.cookie }
    });
    assert.strictEqual(r.status, 401);
    assert.ok(/incorrect/i.test(r.json.error), 'must reject the current-password check, not the session');
  });

  await check('PUT password change → old login fails, new login works', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'PUT', '/api/customers/me', {
      body: { currentPassword: 'custpass1', newPassword: 'newpass456' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: custCookie + '; ' + csrf.cookie }
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const oldLogin = await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'custpass1' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    assert.strictEqual(oldLogin.status, 401, 'old password must stop working');
    const newLogin = await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'newpass456' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    assert.strictEqual(newLogin.status, 200, 'new password must work');
  });

  // ---------------------------------------------------------------
  // 7. FE-C4 — password reset flow + page shell
  // ---------------------------------------------------------------
  console.log('\nPassword reset (FE-C4):');
  await check('POST /api/auth/reset-password with bogus token → 400', async () => {
    const r = await request(PORT, 'POST', '/api/auth/reset-password', { body: { token: 'deadbeef', password: 'whatever1' } });
    assert.strictEqual(r.status, 400);
  });

  await check('GET /reset-password serves the SPA shell with the reset view', async () => {
    const r = await request(PORT, 'GET', '/reset-password?token=abc&type=customer');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('page-reset'), 'shell must contain the reset view');
    assert.ok(r.text.includes('initPasswordReset'), 'shell must contain the reset JS');
  });

  // ---------------------------------------------------------------
  // 8. FE-C3 — self-hosted Chart.js must be served
  // ---------------------------------------------------------------
  console.log('\nVendor assets (FE-C3):');
  await check('GET /vendor/chart.umd.min.js → 200 javascript', async () => {
    const r = await request(PORT, 'GET', '/vendor/chart.umd.min.js');
    assert.strictEqual(r.status, 200);
    assert.ok(/javascript|ecmascript/i.test(r.headers['content-type'] || ''), `unexpected content-type: ${r.headers['content-type']}`);
  });

  await check('admin.html references the self-hosted chart, not the CDN', async () => {
    const r = await request(PORT, 'GET', '/admin');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes('cdn.jsdelivr.net/npm/chart.js'), 'CDN reference must be gone');
    assert.ok(r.text.includes('/vendor/chart.umd.min.js'), 'self-hosted script must be referenced');
  });

  // ---------------------------------------------------------------
  // 9. FE-C1 — product cards route through openProductDetail
  // ---------------------------------------------------------------
  console.log('\nCard wiring (FE-C1):');
  await check('renderHomeProductCard uses openProductDetail, not navigateTo', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes("onclick=\"navigateTo('product', "), 'stale navigateTo(product) wiring must be gone');
    assert.ok(r.text.includes('openProductDetail(${p.id})'), 'cards must call openProductDetail');
  });

  // ---------------------------------------------------------------
  // 10. Header nav search — must stay centred and clear of the nav icons
  // A second `.nav-search` rule (equal specificity, declared later) once
  // overrode `position: absolute` back to `relative`, so the centred
  // `left: 50%` + `translateX(-50%)` pair shifted the field ~370px right
  // and it rendered on top of the right-hand icons.
  // ---------------------------------------------------------------
  console.log('\nNav search layout:');
  await check('single .nav-search positioning rule, centred + width-guarded', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    const positional = (r.text.match(/\.nav-search\s*\{[^}]*\}/g) || [])
      .filter((rule) => /position\s*:/.test(rule));
    assert.strictEqual(positional.length, 1, `expected one .nav-search positioning rule, found ${positional.length}`);
    const rule = positional[0];
    assert.ok(/position:\s*absolute/.test(rule), 'field must be out of flow or it pushes over the icons');
    assert.ok(/left:\s*50%/.test(rule), 'field must be horizontally centred');
    assert.ok(/translate\(\s*-50%/.test(rule), 'centring needs the matching translate(-50%)');
    assert.ok(/min\(320px,\s*calc\(100%\s*-\s*520px\)\)/.test(rule), 'field must shrink so it never reaches the icon cluster');
  });

  // ---------------------------------------------------------------
  // 11. Wishlist hearts — product cards must reuse the navbar's icon
  // The cards rendered text glyphs (♡ / &#9825; / &#9829;) that look different
  // per platform and never matched the navbar, and the homepage card called
  // toggleWishlist() without its element, so the heart kept its old state
  // until the section re-rendered.
  // ---------------------------------------------------------------
  console.log('\nWishlist hearts:');
  await check('card hearts reuse the navbar SVG, fill when saved, pass their element', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const svgAfter = (marker) => {
      const start = r.text.indexOf('<svg', r.text.indexOf(marker));
      return norm(r.text.slice(start, r.text.indexOf('</svg>', start) + 6));
    };
    const constant = r.text.match(/const HEART_SVG = .(<svg[\s\S]*?<\/svg>).;/);
    assert.ok(constant, 'HEART_SVG constant must be defined');
    assert.strictEqual(norm(constant[1]), svgAfter('id="wishlistNav"'), 'card heart must match the navbar icon exactly');
    assert.ok((r.text.match(/\$\{HEART_SVG\}/g) || []).length >= 2, 'both card renderers must use HEART_SVG');
    assert.ok(!r.text.includes('&#9825;') && !r.text.includes('&#9829;'), 'text-glyph hearts must be gone');
    assert.ok(!/toggleWishlist\(\$\{p\.id\}\)"/.test(r.text), 'card buttons must pass their element so the heart updates on click');
    assert.ok(/\.wishlist-icon\.active svg,/.test(r.text) && /\.product-wishlist\.active svg \{ fill: currentColor/.test(r.text), 'saved items must fill the heart');
  });

  // 12. Heart pop animation — saving a product pops the heart once.
  // The keyframe must animate the SVG (not the round button background) and
  // must be gated behind the .pop class so grid re-renders never re-pop.
  // ---------------------------------------------------------------
  console.log('\nHeart pop animation:');
  await check('heart-pop keyframe on svg, .pop-gated, added only when saving', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(/@keyframes heart-pop[\s\S]*?\.wishlist-icon\.pop svg,\s*\.product-wishlist\.pop svg\s*\{\s*animation:\s*heart-pop/.test(r.text),
      'keyframe must animate the svg via .pop, not the button');
    const fn = r.text.match(/function toggleWishlist\([\s\S]*?\n    \}/);
    assert.ok(fn, 'toggleWishlist must be defined');
    assert.ok(/classList\.add\('pop'\)/.test(fn[0]) && /classList\.remove\('pop'\)/.test(fn[0]),
      'toggleWishlist must toggle the .pop class');
    const popIdx = fn[0].indexOf("add('pop')");
    const savedIdx = fn[0].indexOf('if (saved)');
    assert.ok(savedIdx !== -1 && popIdx > savedIdx && popIdx < fn[0].indexOf('} else {'),
      'pop must fire only when saving, not when unsaving');
  });

  // 13. Track-your-order page — the customer-facing bugs fixed here:
  // (a) the submit button was never re-enabled after a failed lookup,
  // (b) cancelled orders rendered an active "Pending" timeline,
  // (c) awaiting_verification (JazzCash/bank) looked identical to pending.
  // ---------------------------------------------------------------
  console.log('\nTrack order page:');
  await check('trackOrder re-enables button + cancelled/awaiting_verification handled', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    const track = r.text.match(/async function trackOrder\([\s\S]*?\n    \}/);
    assert.ok(track, 'trackOrder must be defined');
    assert.ok(/finally\s*\{[\s\S]*?btn\.disabled\s*=\s*false/.test(track[0]),
      'submit button must be re-enabled in finally (no dead button after an error)');
    const render = r.text.match(/function renderTracking\([\s\S]*?\n    \}/);
    assert.ok(render, 'renderTracking must be defined');
    assert.ok(/status === 'cancelled'/.test(render[0]) && /track-status-cancelled/.test(r.text),
      'cancelled orders must render the terminal state, not a live timeline');
    assert.ok(/awaiting_verification.*\? 1 :/.test(render[0]),
      'awaiting_verification must map to the confirmed step, not clamp to pending');
    assert.ok(/TRACK_STATUS_LABELS/.test(r.text) && /formatTrackDate/.test(r.text),
      'statuses must be humanized and the placed date formatted');
  });

  // ---------------------------------------------------------------
  // Responsive layout guards (2026-09-25 session)
  // (a) track timeline overflowed 4-across on phones,
  // (b) admin product/order rows assumed a ~700px column grid,
  // (c) admin disabled pinch-zoom (user-scalable=no).
  // ---------------------------------------------------------------
  console.log('\nResponsive layout guards:');
  await check('storefront ≤540px + ≤360px blocks present, checkout stacks', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(/@media \(max-width: 540px\)[\s\S]*?\.track-timeline \{\s*flex-direction: column/.test(r.text),
      'track timeline must stack vertically on phones (4 labels across overflow)');
    assert.ok(/\.nav-links li \{\s*min-height: 0;/.test(r.text) && /\.nav-links li:has\(\.nav-icon\) \{\s*min-height: 44px;/.test(r.text),
      'nav dropdown rows must not inherit the 44px min-height as full-width rows');
    assert.ok(/@media \(max-width: 360px\)[\s\S]*?\.nav-inner \{\s*flex-wrap: wrap/.test(r.text),
      'header must wrap instead of overflowing on ultra-narrow phones');
    assert.ok(/\.co-row \{\s*grid-template-columns: 1fr;\s*\}/.test(r.text),
      'checkout form rows must collapse to one column on phones');
  });

  await check('admin ≤768px wrap-cards, legend hidden, no zoom lock', async () => {
    const r = await request(PORT, 'GET', '/admin');
    assert.strictEqual(r.status, 200);
    // The media block now includes top-bar/main-wrapper fixes BEFORE product-row
    assert.ok(/@media\(max-width:768px\)[\s\S]*?\.product-row\{display:flex;flex-wrap:wrap/.test(r.text),
      'admin product/order rows must become wrap cards on phones');
    assert.ok(/\.product-row\.header-row\{display:none;\}/.test(r.text),
      'admin column-label legend must hide once rows wrap');
    assert.ok(/\.pnl-summary\{grid-template-columns:1fr;\}/.test(r.text),
      'PnL summary must go single-column on phones');
    assert.ok(!r.text.includes('user-scalable=no'),
      'admin must not disable pinch-zoom (accessibility)');
  });

  // Frontend/API contract: stock and sale editing must agree with checkout.
  console.log('\nCatalog contract:');
  await check('admin can create a product with an image, unit cost and stock', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    delete process.env.VERCEL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.kage_READ_WRITE_TOKEN; // exercise local upload storage deterministically
    let productId = null;
    try {
      const csrf = await getCsrf();
      const form = new FormData();
      form.append('name', 'Regression Product');
      form.append('category', 'goofy-wears');
      form.append('fit', 'Sticker');
      form.append('price', '299');
      form.append('description', 'Create-product regression test');
      form.append('sizes', JSON.stringify(['One Size']));
      form.append('unit_cost', '80');
      form.append('stock_qty', '2');
      form.append('front_image', new Blob([Buffer.from('test-webp-image')], { type: 'image/webp' }), 'regression.webp');
      const response = await fetch(`http://127.0.0.1:${PORT}/api/products`, {
        method: 'POST',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: form
      });
      const product = await response.json();
      assert.strictEqual(response.status, 201, JSON.stringify(product));
      productId = product.id;
      assert.strictEqual(product.name, 'Regression Product');
      assert.strictEqual(product.category, 'goofy-wears');
      assert.strictEqual(Number(product.unit_cost), 80);
      assert.strictEqual(Number(product.stock_qty), 2);
      assert.ok(product.front_image && product.front_image.startsWith('/uploads/'), 'image must be persisted');
    } finally {
      try {
        if (productId != null) {
          const csrf = await getCsrf();
          const removed = await request(PORT, 'DELETE', `/api/products/${productId}`, {
            headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
          });
          assert.strictEqual(removed.status, 200, JSON.stringify(removed.json));
        }
      } finally {
        if (oldVercel === undefined) delete process.env.VERCEL;
        else process.env.VERCEL = oldVercel;
        if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
        else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
        if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
        else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
      }
    }
  });

  await check('batch product delete is authenticated, CSRF-protected and removes selected rows', async () => {
    const insertProduct = () => dbModule.prepare(`
      INSERT INTO products (name, category, fit, price, sizes, stock_qty, extra_images)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('Batch Delete Test', 'anime', 'Regular', 100, JSON.stringify(['L']), 1, '[]');
    const ids = [];
    try {
      ids.push(Number((await insertProduct()).lastInsertRowid));
      ids.push(Number((await insertProduct()).lastInsertRowid));
      const csrf = await getCsrf();
      const noCsrf = await request(PORT, 'DELETE', '/api/products/batch', {
        body: { ids }, headers: { Cookie: adminCookie }
      });
      assert.strictEqual(noCsrf.status, 403);
      const noAuth = await request(PORT, 'DELETE', '/api/products/batch', {
        body: { ids }, headers: { Cookie: csrf.cookie, 'X-CSRF-Token': csrf.token }
      });
      assert.strictEqual(noAuth.status, 401);
      const removed = await request(PORT, 'DELETE', '/api/products/batch', {
        body: { ids: [ids[0], ids[1], ids[0]] },
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
      });
      assert.strictEqual(removed.status, 200, JSON.stringify(removed.json));
      assert.strictEqual(removed.json.deletedCount, 2);
      assert.deepStrictEqual(removed.json.deletedIds.sort((a, b) => a - b), ids.slice().sort((a, b) => a - b));
      for (const id of ids) {
        const product = await request(PORT, 'GET', `/api/products/${id}`);
        assert.strictEqual(product.status, 404);
      }
      const tooMany = await request(PORT, 'DELETE', '/api/products/batch', {
        body: { ids: Array.from({ length: 101 }, (_, i) => i + 1) },
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
      });
      assert.strictEqual(tooMany.status, 400);
    } finally {
      for (const id of ids) await dbModule.prepare('DELETE FROM products WHERE id = ?').run(id);
    }
  });

  await check('product stock quantities reject fractions instead of silently rounding', async () => {
    const csrf = await getCsrf();
    const headers = { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token };
    const created = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Fractional Stock Test', category: 'anime', price: 100, stock_qty: 1.5 }, headers
    });
    assert.strictEqual(created.status, 400);
    assert.match(created.json.error, /whole number/);
    const updated = await request(PORT, 'PUT', '/api/products/1', { body: { stock_qty: 1.5 }, headers });
    assert.strictEqual(updated.status, 400);
    assert.match(updated.json.error, /whole number/);
    const stock = await request(PORT, 'PATCH', '/api/products/1/stock-qty', { body: { stock_qty: 1.5 }, headers });
    assert.strictEqual(stock.status, 400);
    assert.match(stock.json.error, /whole number/);
  });

  await check('Vercel product creation explains missing Blob storage', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    const csrf = await getCsrf();
    process.env.VERCEL = '1';
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.kage_READ_WRITE_TOKEN;
    try {
      const form = new FormData();
      form.append('name', 'No-storage Regression Product');
      form.append('category', 'anime');
      form.append('price', '500');
      form.append('sizes', JSON.stringify(['L']));
      form.append('front_image', new Blob([Buffer.from('test-webp-image')], { type: 'image/webp' }), 'regression.webp');
      const response = await fetch(`http://127.0.0.1:${PORT}/api/products`, {
        method: 'POST',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: form
      });
      const body = await response.json();
      assert.strictEqual(response.status, 503, JSON.stringify(body));
      assert.strictEqual(body.code, 'IMAGE_STORAGE_UNAVAILABLE');
      assert.match(body.error, /BLOB_READ_WRITE_TOKEN/);
    } finally {
      if (oldVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = oldVercel;
      if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
      if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
      else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
    }
  });

  await check('Vercel uses the store-prefixed read-write token from its quickstart', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    const Module = require('module');
    const originalLoad = Module._load;
    const calls = [];
    process.env.VERCEL = '1';
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.kage_READ_WRITE_TOKEN = 'test-prefixed-store-token';
    Module._load = function(request, parent, isMain) {
      if (request === '@vercel/blob') {
        return {
          put: async (pathname, buffer, options) => {
            calls.push(['put', pathname, options]);
            return { url: `https://test.public.blob.vercel-storage.com/${pathname}` };
          },
          del: async (url, options) => { calls.push(['del', url, options]); }
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      const { persistImage, removeImage } = require('../utils/helpers');
      const url = await persistImage(Buffer.from('mock-image'), 'mock.webp');
      await removeImage(url);
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0][2].access, 'public');
      assert.strictEqual(calls[0][2].token, 'test-prefixed-store-token');
      assert.strictEqual(calls[1][2].token, 'test-prefixed-store-token');
    } finally {
      Module._load = originalLoad;
      if (oldVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = oldVercel;
      if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
      if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
      else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
    }
  });
  await check('zero-stock products are unavailable in the catalog', async () => {
    const r = await request(PORT, 'GET', '/api/products');
    assert.strictEqual(r.status, 200);
    for (const name of ['Melting', 'Robo Bro', 'All-Seeing Eye']) {
      const p = r.json.find(x => x.name === name);
      assert.equal(p.stock_qty, 0);
      assert.equal(p.in_stock, false);
    }
  });
  await check('zero-stock product cannot be marked available without restocking', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'PATCH', '/api/products/14/stock', {
      headers: { Cookie: adminCookie + '; ' + csrf.cookie, 'X-CSRF-Token': csrf.token }
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Restock/);
  });
  await check('clearing a sale price removes the discount on the API', async () => {
    const csrf = await getCsrf();
    const headers = { Cookie: adminCookie + '; ' + csrf.cookie, 'X-CSRF-Token': csrf.token };
    const r = await request(PORT, 'PUT', '/api/products/4', { body: { sale_price: '' }, headers });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sale_price, null);
    assert.equal(r.json.on_sale, false);
    const list = await request(PORT, 'GET', '/api/products');
    assert.equal(list.json.find(x => x.id === 4).sale_price, null);
  });

  // ---------------------------------------------------------------
  // Per-size stock: sizes offered, stock per size, order + cancel accounting
  // ---------------------------------------------------------------
  console.log('\nPer-size stock:');
  const adminHeaders = async () => { const csrf = await getCsrf(); return { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }; };
  const placeOrder = async (items, email) => {
    const csrf = await getCsrf();
    return request(PORT, 'POST', '/api/orders', {
      body: { name: 'Size Buyer', email, phone: '03005550000', address: '1 Test St', city: 'Lahore', payment_method: 'cod', items },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
  };
  const getProduct = async (id) => (await request(PORT, 'GET', `/api/products/${id}`)).json;
  const sizeProductId = { id: null };

  await check('admin creates a product with a stock count per size', async () => {
    const r = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Per Size Tee', category: 'anime', price: 1000, sizes: JSON.stringify(['S', 'M', 'L']), size_stock: JSON.stringify({ S: 2, M: 0, L: 5 }) },
      headers: await adminHeaders()
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    sizeProductId.id = r.json.id;
    assert.deepStrictEqual(r.json.sizes, ['S', 'M', 'L']);
    assert.deepStrictEqual(r.json.size_stock, { S: 2, M: 0, L: 5 });
    assert.strictEqual(Number(r.json.stock_qty), 7, 'total is the sum of the sizes');
    const listed = (await request(PORT, 'GET', '/api/products')).json.find((x) => x.id === sizeProductId.id);
    assert.deepStrictEqual(listed.size_stock, { S: 2, M: 0, L: 5 });
  });

  await check('per-size stock must cover every size and no unknown size', async () => {
    const headers = await adminHeaders();
    const missing = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Missing Size Tee', category: 'anime', price: 1000, sizes: JSON.stringify(['S', 'M']), size_stock: JSON.stringify({ S: 1 }) }, headers
    });
    assert.strictEqual(missing.status, 400);
    assert.match(missing.json.error, /size M/);
    const unknown = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Unknown Size Tee', category: 'anime', price: 1000, sizes: JSON.stringify(['S']), size_stock: JSON.stringify({ S: 1, XXL: 2 }) }, headers
    });
    assert.strictEqual(unknown.status, 400);
    assert.match(unknown.json.error, /XXL/);
  });

  await check('a bare stock total cannot be split across several sizes', async () => {
    const headers = await adminHeaders();
    const r = await request(PORT, 'PATCH', `/api/products/${sizeProductId.id}/stock-qty`, { body: { stock_qty: 9 }, headers });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /per size/);
    const put = await request(PORT, 'PUT', `/api/products/${sizeProductId.id}`, { body: { stock_qty: 9 }, headers });
    assert.strictEqual(put.status, 400);
    assert.match(put.json.error, /per size/);
  });

  await check('ordering a sold-out size is rejected', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 1, size: 'M' }], 'size1@kage.test');
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /sold out in size M/);
  });

  await check('ordering a size the product does not offer is rejected', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 1, size: 'XXL' }], 'size2@kage.test');
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /not offered/);
  });

  let sizeOrderNumber = '';
  await check('order decrements only the ordered size', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 2, size: 'L' }], 'size3@kage.test');
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    sizeOrderNumber = r.json.order_number;
    const p = await getProduct(sizeProductId.id);
    assert.deepStrictEqual(p.size_stock, { S: 2, M: 0, L: 3 });
    assert.strictEqual(Number(p.stock_qty), 5);
  });

  await check('ordering more than one size has left is rejected with the size named', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 4, size: 'L' }], 'size4@kage.test');
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Only 3 units .* in size L/);
  });

  await check('a failed multi-size order restores the sizes it already took', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 1, size: 'S' }, { id: sizeProductId.id, qty: 99, size: 'L' }], 'size5@kage.test');
    assert.strictEqual(r.status, 400);
    const p = await getProduct(sizeProductId.id);
    assert.deepStrictEqual(p.size_stock, { S: 2, M: 0, L: 3 }, 'S must be back to 2');
    const orders = await dbModule.prepare('SELECT COUNT(*) AS c FROM orders WHERE email = ?').get('size5@kage.test');
    assert.strictEqual(Number(orders.c), 0, 'no phantom order');
  });

  await check('cancelling and reactivating an order returns and retakes the size units', async () => {
    const row = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(sizeOrderNumber);
    const headers = await adminHeaders();
    const cancel = await request(PORT, 'PATCH', `/api/orders/${row.id}/status`, { body: { status: 'cancelled' }, headers });
    assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.json));
    assert.deepStrictEqual((await getProduct(sizeProductId.id)).size_stock, { S: 2, M: 0, L: 5 });
    const reopen = await request(PORT, 'PATCH', `/api/orders/${row.id}/status`, { body: { status: 'pending' }, headers });
    assert.strictEqual(reopen.status, 200, JSON.stringify(reopen.json));
    assert.deepStrictEqual((await getProduct(sizeProductId.id)).size_stock, { S: 2, M: 0, L: 3 });
  });

  await check('editing sizes keeps counts for kept sizes and drops removed ones', async () => {
    const r = await request(PORT, 'PUT', `/api/products/${sizeProductId.id}`, { body: { sizes: JSON.stringify(['S', 'L', 'XL']) }, headers: await adminHeaders() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual(r.json.size_stock, { S: 2, L: 3, XL: 0 });
    assert.strictEqual(Number(r.json.stock_qty), 5);
  });

  await check('editing with per-size stock replaces each size count', async () => {
    const r = await request(PORT, 'PUT', `/api/products/${sizeProductId.id}`, { body: { size_stock: JSON.stringify({ S: 1, L: 1, XL: 4 }) }, headers: await adminHeaders() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual(r.json.size_stock, { S: 1, L: 1, XL: 4 });
    assert.strictEqual(Number(r.json.stock_qty), 6);
  });

  await check('a single-size product keeps quick stock edits working per size', async () => {
    const headers = await adminHeaders();
    const created = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Single Size Tee', category: 'anime', price: 900, sizes: JSON.stringify(['M']), size_stock: JSON.stringify({ M: 3 }) }, headers
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const r = await request(PORT, 'PATCH', `/api/products/${created.json.id}/stock-qty`, { body: { stock_qty: 6 }, headers });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(Number(r.json.stock_qty), 6);
    assert.deepStrictEqual((await getProduct(created.json.id)).size_stock, { M: 6 });
    await request(PORT, 'DELETE', `/api/products/${created.json.id}`, { headers });
  });

  await check('deleting a per-size product removes its size rows', async () => {
    const headers = await adminHeaders();
    const r = await request(PORT, 'DELETE', `/api/products/${sizeProductId.id}`, { headers });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const left = await dbModule.prepare('SELECT COUNT(*) AS c FROM product_size_stock WHERE product_id = ?').get(sizeProductId.id);
    assert.strictEqual(Number(left.c), 0);
  });

  // ---------------------------------------------------------------
  await new Promise((r) => server.close(r));
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f[0]).join(', ')); process.exit(1); }
  process.exit(0);
}

// Fetch + echo a CSRF token (middleware sets it as a cookie on first GET).
// Returns { cookie, token } — both must accompany the mutating request.
async function getCsrf() {
  const r = await request(PORT, 'GET', '/api/products');
  const sc = (r.headers['set-cookie'] || []).find((c) => c.startsWith('kage.csrf='));
  if (!sc) throw new Error('no CSRF cookie issued');
  const cookie = sc.split(';')[0];
  return { cookie, token: cookie.split('=')[1] };
}

main().catch((e) => { console.error(e); process.exit(1); });

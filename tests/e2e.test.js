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
        items: [{ id: 1, qty: 1, size: 'M' }]
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
        items: [{ id: 1, qty: 99 }]
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

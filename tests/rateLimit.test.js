// ================================================================
// Shared rate-limit integration tests
// Run: node tests/rateLimit.test.js
// ================================================================
process.env.NODE_ENV = 'test';
process.env.ALLOW_ADMIN_SETUP = 'true';
process.env.SESSION_SECRET = 'rate-limit-test-secret-0123456789';
process.env.RATE_LIMIT_STORE = 'db';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const expressRateLimit = require('express-rate-limit');
const { DatabaseRateLimitStore } = require('../middleware/dbRateLimitStore');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kage-rate-limit-'));
process.env.KAGE_DB_FILE = path.join(tempDir, 'main.db');
const db = require('../database');
const { app, ensureReady } = require('../server');
const ipKeyGenerator = expressRateLimit.ipKeyGenerator;
const REPO_ROOT = path.join(__dirname, '..');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Each track request needs its own CSRF double (F16: POST + CSRF). The pair is
// valid for that server instance only (each child has its own secret), but the
// strict limiter counts by client IP, so the per-IP assertions still hold.
async function csrfHeaders(port, forwardedIp) {
  const headers = forwardedIp ? { 'X-Forwarded-For': forwardedIp } : {};
  const res = await request(port, 'GET', '/api/csrf', { headers });
  const setCookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('kage.csrf='));
  if (!setCookie) throw new Error('no CSRF cookie issued');
  const cookie = setCookie.split(';')[0];
  return { Cookie: cookie, 'X-CSRF-Token': cookie.split('=')[1], ...(forwardedIp ? { 'X-Forwarded-For': forwardedIp } : {}) };
}

function trackRequest(port, number, phone, forwardedIp) {
  return csrfHeaders(port, forwardedIp).then(headers =>
    request(port, 'POST', '/api/orders/track', { body: { number, phone }, headers }));
}

function request(port, method, pathname, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(headers || {})
      }
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch (e) { /* e.g. HTML page */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`server on ${port} exited early (${child.exitCode})`);
    try {
      const response = await request(port, 'GET', '/api/products');
      if (response.status === 200) return response;
    } catch (e) { /* wait until listen() */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for server on ${port}`);
}

function startServer(port, dbFile) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SESSION_SECRET: 'rate-limit-test-secret-0123456789',
      ALLOW_ADMIN_SETUP: 'true',
      RATE_LIMIT_STORE: 'db',
      KAGE_DB_FILE: dbFile,
      PORT: String(port),
      TURSO_DATABASE_URL: '',
      VERCEL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  child.output = () => output;
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
  timeout.unref();
  try { await once(child, 'exit'); } finally { clearTimeout(timeout); }
}

function verifyMemoryBackendMigration() {
  const databasePath = path.join(REPO_ROOT, 'database.js');
  const code = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'sql.js') throw new Error('forced pure-memory backend for test');
      return originalLoad.call(this, request, parent, isMain);
    };
    const db = require(${JSON.stringify(databasePath)});
    (async () => {
      await db.init();
      if (db.activeBackend !== 'mem') throw new Error('expected mem backend, got ' + db.activeBackend);
      const first = await db.incrementRateLimit('memory:shared', 60000);
      const second = await db.incrementRateLimit('memory:shared', 60000);
      if (first.count !== 1 || second.count !== 2) throw new Error(JSON.stringify({ first, second }));
      await db.resetRateLimit('memory:shared');
      if (await db.getRateLimit('memory:shared')) throw new Error('reset did not remove the memory counter');
      console.log('memory rate_limits schema and atomic counter ok');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TURSO_DATABASE_URL: '',
      VERCEL: '',
      KAGE_DB_FILE: ''
    }
  });
  assert.equal(result.status, 0, `in-memory backend failed: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /memory rate_limits schema and atomic counter ok/);
  console.log('✅ Pure in-memory backend creates and uses rate_limits');
}

async function run() {
  verifyMemoryBackendMigration();
  let localServer;
  const childServers = [];
  await ensureReady();
  localServer = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const localPort = localServer.address().port;

  try {
    const unitA = new DatabaseRateLimitStore({ namespace: 'test-window' });
    const unitB = new DatabaseRateLimitStore({ namespace: 'test-window' });
    unitA.init({ windowMs: 60 });
    unitB.init({ windowMs: 60 });
    const first = await unitA.increment('shared-client');
    const second = await unitB.increment('shared-client');
    assert.equal(first.totalHits, 1);
    assert.equal(second.totalHits, 2, 'independent store instances must see the same DB counter');
    await sleep(85);
    const afterExpiry = await unitB.increment('shared-client');
    assert.equal(afterExpiry.totalHits, 1, 'expired windows start over at one');
    await unitA.resetKey('shared-client');
    console.log('✅ Shared DB store increments atomically and resets after expiry');

    // Express trusts one Vercel proxy hop. The active rate-limit keys below
    // prove req.ip follows X-Forwarded-For, and ipKeyGenerator normalizes IPv6
    // to the same /56 bucket used by express-rate-limit's default keyGenerator.
    const forwardedIp = '198.51.100.42';
    let last;
    for (let i = 0; i < 10; i++) {
      last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '03000000000', forwardedIp);
      assert.equal(last.status, 404, `track request ${i + 1} should reach the not-found response`);
    }
    last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '03000000000', forwardedIp);
    assert.equal(last.status, 429, 'the tracking endpoint must enforce strictLimiter');
    const ipKey = ipKeyGenerator(forwardedIp);
    const forwardedCounter = await db.getRateLimit(`tracking-id:${ipKey}|3000000000|`);
    assert.equal(forwardedCounter.count, 11, 'the (IP, phone) identity bucket should be the forwarded client address + normalised phone');

    const pathIp = '203.0.113.42';
    for (let i = 0; i < 10; i++) {
      last = await request(localPort, 'GET', `/api/orders/guess-${i}?phone=03000000000`, { headers: { 'X-Forwarded-For': pathIp } });
      assert.equal(last.status, 404);
    }
    last = await request(localPort, 'GET', '/api/orders/guess-last?phone=03000000000', { headers: { 'X-Forwarded-For': pathIp } });
    assert.equal(last.status, 429, 'the order-number lookup endpoint must enforce strictLimiter');

    const ipv6a = '2001:db8:1234:5600::1';
    const ipv6b = '2001:db8:1234:56ff::2';
    const ipv6Key = ipKeyGenerator(ipv6a);
    assert.equal(ipKeyGenerator(ipv6b), ipv6Key, 'express-rate-limit must bucket this IPv6 /56 together');
    for (const forwarded of [ipv6a, ipv6b]) {
      last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '03000000000', forwarded);
      assert.equal(last.status, 404);
    }
    const ipv6Counter = await db.getRateLimit(`tracking-id:${ipv6Key}|3000000000|`);
    assert.equal(ipv6Counter.count, 2, 'different IPv6 addresses in one subnet share the limit key');
    console.log('✅ Tracking/order lookups are limited; X-Forwarded-For and IPv6 keys are correct');

    // F29: order/tracking limits key on IP + normalised identity, so carrier
    // NAT neighbours do not share one budget. Distinct phones from one IP get
    // independent budgets; the per-IP floor still stops rotating-identity floods.
    const neighbourIp = '198.51.100.71';
    for (let i = 0; i < 10; i++) {
      last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '03001110001', neighbourIp);
      assert.equal(last.status, 404, `identity budget for phone A, request ${i + 1}`);
    }
    last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '03001110001', neighbourIp);
    assert.equal(last.status, 429, 'the identity budget for phone A is exhausted');
    last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '03001110002', neighbourIp);
    assert.equal(last.status, 404, 'a different phone from the same IP keeps its own budget');

    // Phone normalisation: '03001110003', '+92 300 1110003' and '0300-1110003'
    // are the same last-10-digit identity.
    const normIp = '198.51.100.72';
    const formats = ['03001110003', '+92 300 1110003', '0300-1110003'];
    for (let i = 0; i < 10; i++) {
      last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', formats[i % formats.length], normIp);
      assert.equal(last.status, 404, `normalised formats share one budget, request ${i + 1}`);
    }
    last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '03001110003', normIp);
    assert.equal(last.status, 429, 'normalised phone formats share the identity bucket');

    // The per-IP floor: 50 distinct phones from one IP, the 51st request is
    // refused even though every identity is fresh.
    const floorIp = '198.51.100.73';
    for (let i = 0; i < 50; i++) {
      last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '0300222' + String(1000 + i).slice(-4), floorIp);
      assert.equal(last.status, 404, `floor budget request ${i + 1}`);
    }
    last = await trackRequest(localPort, 'KAGE-DOESNOTEXIST', '03002229999', floorIp);
    assert.equal(last.status, 429, 'the per-IP floor stops rotating-phone floods');

    // Orders: the identity bucket is (IP, phone, email) with email normalised.
    const orderIp = '198.51.100.74';
    const orderAttempt = (phone, email) => request(localPort, 'POST', '/api/orders', {
      body: { name: 'Limit Probe', email, phone, address: '1 Test Street', city: 'Karachi', items: [{ id: 1, qty: 1, size: 'M' }] },
      headers: { 'X-Forwarded-For': orderIp }
    });
    for (let i = 0; i < 8; i++) {
      last = await orderAttempt('03003330001', i % 2 ? 'buyer@example.test' : 'Buyer@Example.TEST ');
      assert.equal(last.status, 403, `mixed-case email is one identity, attempt ${i + 1} (403 = CSRF refusal after passing the limiter)`);
    }
    last = await orderAttempt('03003330001', 'BUYER@example.test');
    assert.equal(last.status, 429, 'email is trimmed and lower-cased before keying');
    last = await orderAttempt('03003330001', 'someone-else@example.test');
    assert.equal(last.status, 403, 'a different email gets an independent budget');
    last = await orderAttempt('+92 300 3330001', 'buyer@example.test');
    assert.equal(last.status, 429, 'the phone part is normalised to its last 10 digits');

    // Orders: the per-IP floor (5× the identity limit) stops rotating identities.
    const orderFloorIp = '198.51.100.75';
    for (let i = 0; i < 40; i++) {
      last = await request(localPort, 'POST', '/api/orders', {
        // Unique identity per attempt so only the per-IP floor can trip.
        body: { phone: '0300444' + String(1000 + i).slice(-4), email: `floor-probe-${i}@example.test` },
        headers: { 'X-Forwarded-For': orderFloorIp }
      });
      assert.equal(last.status, 403, `order floor budget request ${i + 1}`);
    }
    last = await request(localPort, 'POST', '/api/orders', {
      body: { phone: '03004449999', email: 'floor-probe-final@example.test' },
      headers: { 'X-Forwarded-For': orderFloorIp }
    });
    assert.equal(last.status, 429, 'the per-IP floor stops rotating-identity order floods');
    console.log('✅ Order/tracking limits key on IP + normalised phone/email with a per-IP floor');

    // A failed shared-store increment must be logged and let ordinary traffic
    // through (not turn a DB blip into a 500). Admin login is the exception and
    // returns a closed 429 with Retry-After.
    const realIncrement = db.incrementRateLimit;
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    db.incrementRateLimit = async () => { throw new Error('simulated rate-limit database outage'); };
    try {
      const open = await request(localPort, 'GET', '/api/products', { headers: { 'X-Forwarded-For': '192.0.2.90' } });
      assert.equal(open.status, 200, 'a non-admin request should pass when its shared limiter errors');
      assert.ok(warnings.some(line => /rate-limit store error.*allowing request/i.test(line)), warnings.join('\n'));

      const closed = await request(localPort, 'POST', '/api/admin/login', {
        body: { email: 'some-admin@example.test', password: 'not-a-password' },
        headers: { 'X-Forwarded-For': '192.0.2.91' }
      });
      assert.equal(closed.status, 429, `admin must fail closed, not 500/open: ${closed.status} ${closed.text}`);
      assert.ok(Number(closed.headers['retry-after']) > 0, 'fail-closed admin response should carry Retry-After');
      assert.match(closed.json.error, /too many attempts/i);
      assert.ok(warnings.some(line => /admin login rate-limit store failed closed/i), warnings.join('\n'));
    } finally {
      db.incrementRateLimit = realIncrement;
      console.warn = realWarn;
    }
    console.log('✅ Store errors fail open for public routes, but closed for admin login');

    // Two independent Node/Express server processes, two ports, one sql.js
    // database file. Use a distinct email per attempt so the per-account lockout
    // cannot mask the shared per-IP 10/minute login limit.
    const sharedDb = path.join(tempDir, 'two-processes.db');
    const ports = [await freePort(), await freePort()];
    for (const port of ports) {
      const child = startServer(port, sharedDb);
      childServers.push({ child, port });
      await waitForServer(port, child);
    }

    const statuses = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await request(ports[attempt % 2], 'POST', '/api/admin/login', {
        body: { email: `shared-probe-${attempt}@example.test`, password: 'wrong-password' }
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429, `the 11th login across two instances must be blocked: ${statuses.join(',')}`);
    console.log(`✅ Two server processes on ports ${ports.join(' and ')} share the login counter: ${statuses.join(', ')}`);

    const accountStatuses = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request(ports[attempt % 2], 'POST', '/api/admin/login', {
        body: { email: 'Shared.Lockout@Example.Test', password: 'wrong-password' },
        headers: { 'X-Forwarded-For': '198.51.100.88' }
      });
      accountStatuses.push(response.status);
    }
    assert.deepEqual(accountStatuses.slice(0, 4), Array(4).fill(401));
    assert.equal(accountStatuses[4], 429, `the fifth account failure across instances must lock that email: ${accountStatuses.join(',')}`);
    console.log(`✅ Per-email login failures also share the same DB across processes: ${accountStatuses.join(', ')}`);

    const trackStatuses = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await trackRequest(ports[attempt % 2], 'KAGE-UNKNOWN', '03000000000');
      trackStatuses.push(response.status);
    }
    assert.deepEqual(trackStatuses.slice(0, 10), Array(10).fill(404));
    assert.equal(trackStatuses[10], 429, `tracking should be limited across both processes: ${trackStatuses.join(',')}`);
    const directLookup = await request(ports[0], 'GET', '/api/orders/KAGE-UNKNOWN?phone=03000000000');
    assert.equal(directLookup.status, 429, 'the order-number endpoint shares the strict DB limiter too');
    console.log(`✅ Track endpoint shared across processes: ${trackStatuses.join(', ')}`);
  } finally {
    if (localServer) await new Promise(resolve => localServer.close(resolve));
    await Promise.all(childServers.map(({ child }) => stopChild(child)));
    // The database module registers an exit flush for local KAGE_DB_FILE data;
    // remove that hook before deleting these isolated test files.
    for (const listener of process.listeners('exit')) {
      if (listener.name === 'flushSqlJs') process.removeListener('exit', listener);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('All shared rate-limit integration checks passed.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

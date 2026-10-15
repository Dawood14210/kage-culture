// ================================================================
// Spawned by tests/e2e.test.js — a database that never comes up.
// ================================================================
// Runs the real Vercel entrypoint (server.js) with VERCEL=1 and a Turso URL
// pointing at a closed port, then hammers it. Asserts, from inside the child:
//   - every request is a 503 (JSON + Retry-After), never a crash,
//   - the process is still alive at the end,
//   - no unhandled rejection was emitted.
// The parent additionally counts "Turso init failed" lines in our output to
// prove that a failed boot is NOT cached: one attempt for the burst inside the
// backoff window, plus one more after the backoff expires.
process.env.NODE_ENV = 'production';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'fixture-secret-0123456789abcdefghijklmnop';
process.env.VERCEL = '1';
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'http://127.0.0.1:1/unreachable';
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || 'fixture-token';
process.env.EMAIL_API_KEY = '';

const http = require('http');

const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(String((err && err.message) || err)));
process.on('uncaughtException', (err) => {
  console.log('UNCAUGHT:' + err.message);
  process.exit(3);
});

const config = require('../../config');
config.READY_RETRY_BACKOFF_MS = 150; // keep the fixture quick; the rule is the same

// The entrypoint is written for Express-style req/res (Vercel and tests mount
// it in Express), so mount it here too.
const express = require('express');
const handler = require('../../server.js'); // the serverless entrypoint itself
const mount = express();
mount.use(handler);
const server = http.createServer(mount);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hit(port, pathname = '/api/products') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'], body }));
    });
    req.setTimeout(8000, () => req.destroy(new Error('client timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}

server.listen(0, async () => {
  const port = server.address().port;
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push(await hit(port)); // burst inside the backoff window
  await sleep(250);                                             // let the backoff expire
  results.push(await hit(port));                                // → one more real attempt
  await sleep(50);

  const sitemap = await hit(port, '/sitemap.xml');
  const robots = await hit(port, '/robots.txt');
  const origin = `http://127.0.0.1:${port}`;
  const crawlerFallback = sitemap.status === 200 &&
    sitemap.body.includes(`<loc>${origin}/</loc>`) &&
    sitemap.body.includes(`<loc>${origin}/about</loc>`) &&
    !sitemap.body.includes('/product/') &&
    robots.status === 200 && robots.body.includes(`Sitemap: ${origin}/sitemap.xml`);
  const all503 = results.every((r) => r.status === 503 && r.retryAfter === '1' && /temporarily unavailable/.test(r.body));
  const bodyLeaks = results.some((r) => /libsql|turso|unreachable|at Object|\.js:\d/i.test(r.body || ''));
  console.log(JSON.stringify({
    all503,
    bodyLeaks,
    crawlerFallback,
    crawlerStatuses: [sitemap.status, robots.status],
    statuses: results.map((r) => r.status),
    retryAfter: results.map((r) => r.retryAfter),
    unhandled: unhandled.length,
    alive: true
  }));
  server.close(() => process.exit(all503 && !bodyLeaks && crawlerFallback && unhandled.length === 0 ? 0 : 4));
});

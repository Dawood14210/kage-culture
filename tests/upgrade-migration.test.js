// ================================================================
// Upgrade regression test — an EXISTING pre-customer_id database must boot.
// Run: node tests/upgrade-migration.test.js
// ----------------------------------------------------------------
// Production incident this covers: createSchema() created
//   CREATE INDEX idx_orders_customer_id ON orders(customer_id)
// BEFORE the migration added orders.customer_id to an old table. Fresh
// databases were fine; every database created before the customer_id feature
// failed at startup with "no such column: customer_id" (on Vercel: a 503 for
// every request, reported as "could not be reached").
//
// The fixtures build the OLD schema (see tests/fixtures/legacy-schema.js) with
// realistic rows — including duplicate mixed-case emails — and boot the current
// server against it in a separate process, once per backend:
//
//   * sql.js file backend        (KAGE_DB_FILE)
//   * libsql/Turso local file    (TURSO_DATABASE_URL=file:/abs/path)
//
// and then asserts that:
//   - boot succeeds on the backend the environment asked for,
//   - the upgraded schema is identical to a freshly created one
//     (columns, tables, indexes),
//   - every old row survives, duplicates merge (oldest row wins, its password
//     still works, references survive),
//   - orders can be placed, a customer can sign up + verify, and the verified
//     account sees its legacy guest order through orders.customer_id,
//   - a SECOND boot against the same file changes nothing (migrations are
//     idempotent).
//
// Negative control (proves the test catches the original bug):
//   git show <pre-fix-commit>:database.js > /tmp/old-database.js
//   KAGE_UPGRADE_DB_MODULE=/tmp/old-database.js node tests/upgrade-migration.test.js
// The test then fails with the schema/row assertions on both backends.
// ================================================================
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeLegacyDatabaseFile } = require('./fixtures/legacy-schema');

const REPO_ROOT = path.join(__dirname, '..');
const CHILD = path.join(__dirname, 'fixtures', 'upgrade-child.js');
const SESSION_SECRET = 'upgrade-suite-secret-0123456789abcdef';
const SITE_URL = 'https://shop.kage.test';

// Indexes the current schema owns — every one of them must exist after upgrade
// (idx_orders_customer_id is the one that used to abort startup).
const EXPECTED_INDEXES = [
  'idx_customer_verification_tokens_hash',
  'idx_customers_email',
  'idx_orders_customer_id',
  'idx_orders_email',
  'idx_orders_order_number',
  'idx_orders_status',
  'idx_password_reset_tokens_hash',
  'idx_products_category',
  'idx_rate_limits_reset_at',
  'idx_reviews_product_id',
  'idx_reviews_status'
];

// Columns the migrations must add to a legacy database.
const EXPECTED_COLUMNS = {
  products: ['unit_cost', 'drop'],
  orders: ['payment_ref', 'payment_verified', 'cod_confirmed', 'shipping_pending', 'customer_id'],
  customers: ['email_verified'],
  reviews: ['viewer_token']
};

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`❌ ${name}: ${error.message}`);
  }
}

// Environment for a child: start from the real environment, drop any database
// settings the outer shell may have, then apply this case's overrides.
function childEnv(overrides) {
  const env = { ...process.env };
  delete env.KAGE_DB_FILE;
  delete env.TURSO_DATABASE_URL;
  delete env.TURSO_AUTH_TOKEN;
  delete env.VERCEL;
  delete env.ALLOW_ADMIN_SETUP;
  return {
    ...env,
    NODE_ENV: 'test',
    SESSION_SECRET,
    SITE_URL,
    EMAIL_API_KEY: '',
    // Only needed for the negative control: a database.js copy kept OUTSIDE the
    // repo (e.g. in /tmp) resolves @libsql/client and sql.js through this.
    NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
    ...overrides
  };
}

function runChild(command, env) {
  const child = spawnSync(process.execPath, [CHILD, command], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env
  });
  const output = `${child.stdout || ''}\n${child.stderr || ''}`;
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith('RESULT: '));
  if (!line) throw new Error(`child (${command}) produced no RESULT line\n${output}`);
  const result = JSON.parse(line.slice('RESULT: '.length));
  result.output = output;
  return result;
}

function assertBooted(result, expectedBackend, label) {
  assert.ok(result.ok, `${label}: boot reported a failure — ${result.error}`);
  assert.equal(result.backend, expectedBackend, `${label}: expected the ${expectedBackend} backend (fallback means the real backend failed)\n${result.output}`);
  assert.ok(result.before, `${label}: no database snapshot was reported`);
}

const CASES = [
  {
    name: 'sql.js file backend',
    backend: 'sqljs',
    env: (file) => ({ KAGE_DB_FILE: file })
  },
  {
    name: 'libsql/Turso file: URL backend',
    backend: 'turso',
    env: (file) => ({ TURSO_DATABASE_URL: `file:${file}` })
  }
];

(async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kage-upgrade-'));
  console.log(`Upgrade migration tests (fixtures in ${workdir})\n`);

  for (const testCase of CASES) {
    const legacyFile = path.join(workdir, `${testCase.backend}-legacy.db`);
    const freshFile = path.join(workdir, `${testCase.backend}-fresh.db`);
    const state = { first: null, second: null, fresh: null, error: null };

    try {
      await writeLegacyDatabaseFile(legacyFile);
      state.first = runChild('exercise', childEnv(testCase.env(legacyFile)));
      state.second = runChild('snapshot', childEnv(testCase.env(legacyFile)));
      state.fresh = runChild('snapshot', childEnv(testCase.env(freshFile)));
    } catch (err) {
      state.error = err;
    }

    const bootFailure = () => { if (state.error) throw state.error; };

    await check(`${testCase.name}: the legacy database boots on the expected backend`, () => {
      bootFailure();
      assertBooted(state.first, testCase.backend, testCase.name);
      assertBooted(state.second, testCase.backend, testCase.name);
    });

    await check(`${testCase.name}: upgraded schema matches a fresh database (columns, tables, indexes)`, () => {
      bootFailure();
      assertBooted(state.fresh, testCase.backend, `${testCase.name} (fresh)`);
      const upgraded = state.first.before;
      const fresh = state.fresh.before;
      assert.deepEqual([...upgraded.tables].sort(), [...fresh.tables].sort(), 'table set differs from a fresh database');
      assert.deepEqual([...upgraded.indexes].sort(), [...fresh.indexes].sort(), 'index set differs from a fresh database');
      assert.deepEqual(upgraded.columns, fresh.columns, 'column set differs from a fresh database');
      // …and the specific things the incident was about really exist.
      for (const index of EXPECTED_INDEXES) {
        assert.ok(upgraded.indexes.includes(index), `missing index ${index}`);
      }
      for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        for (const column of columns) {
          assert.ok((upgraded.columns[table] || []).includes(column), `missing column ${table}.${column}`);
        }
      }
      assert.ok(upgraded.tables.includes('app_settings'), 'app_settings must be created on upgrade');
      assert.ok(upgraded.tables.includes('rate_limits'), 'rate_limits must be created on upgrade');
      assert.ok(upgraded.tables.includes('customer_verification_tokens'), 'customer_verification_tokens must be created on upgrade');
    });

    await check(`${testCase.name}: legacy rows survive and duplicate emails merge (oldest row wins)`, () => {
      bootFailure();
      const before = state.first.before;

      const orders = Object.fromEntries(before.orders.map((o) => [o.order_number, o]));
      assert.deepEqual(Object.keys(orders).sort(), ['KAGE-OLD001', 'KAGE-OLD002', 'KAGE-OLD003'], 'legacy orders must all be present');
      assert.deepEqual(orders['KAGE-OLD001'], {
        id: 1, order_number: 'KAGE-OLD001', customer_name: 'Ayesha Khan', email: 'ayesha@kage.test',
        phone: '03001234567', address: '12 Garden Town', city: 'Lahore', notes: 'leave at the gate',
        payment_method: 'cod', subtotal: 2500, shipping: 0, total: 2500, status: 'delivered',
        items_json: '[{"id":1,"name":"Legacy Graphic Tee","size":"M","qty":1,"unit":2500,"total":2500}]',
        created_at: '2026-08-01 10:00:00', customer_id: null
      }, 'the delivered order (or its new columns) changed during the upgrade');
      assert.equal(orders['KAGE-OLD002'].email, 'bilal@kage.test', 'order emails must be normalised to lower case');
      assert.equal(orders['KAGE-OLD002'].status, 'shipped');
      assert.equal(orders['KAGE-OLD003'].email, 'buyer.legacy@kage.test');
      assert.equal(orders['KAGE-OLD003'].total, 3200);

      // customers: the two mixed-case Dupe rows are one account, the oldest wins.
      assert.deepEqual(before.customers, [
        { id: 1, email: 'dupe@kage.test', name: 'First Dupe', phone: '03111111111', address: '1 Dupe St', city: 'Lahore', created_at: '2026-07-01 08:00:00', email_verified: 0 },
        { id: 3, email: 'solo@kage.test', name: 'Solo Customer', phone: '03333333333', address: '3 Solo St', city: 'Islamabad', created_at: '2026-07-15 08:00:00', email_verified: 0 }
      ], 'duplicate customers must merge into the oldest row, lowercased');

      assert.deepEqual(before.newsletter, [
        { id: 1, email: 'fan@kage.test' },
        { id: 3, email: 'solo-sub@kage.test' }
      ], 'duplicate newsletter rows must merge into the oldest row');

      assert.deepEqual(before.passwordResetTokens, [
        { id: 1, user_type: 'customer', user_id: 3, token_hash: 'fixture-reset-token-hash', used: 0 }
      ], 'password reset tokens must survive untouched');

      assert.equal(before.reviews.length, 2, 'reviews must survive');
      assert.ok(before.reviews.every((r) => r.viewer_token === ''), 'existing reviews get the viewer_token default');

      // unit_cost is the one column a one-time bootstrap backfill is allowed to fill.
      assert.deepEqual(before.products.map((p) => ({ id: p.id, name: p.name, price: p.price, sale_price: p.sale_price, stock_qty: p.stock_qty, in_stock: p.in_stock })),
        [
          { id: 1, name: 'Legacy Graphic Tee', price: 2500, sale_price: null, stock_qty: 5, in_stock: 1 },
          { id: 2, name: 'Legacy Anime Shirt', price: 3200, sale_price: 2900, stock_qty: 2, in_stock: 1 }
        ], 'product rows changed during the upgrade');
      assert.deepEqual(before.products.map((p) => p.unit_cost), [1375, 1760], 'unit_cost must be backfilled once');
    });

    await check(`${testCase.name}: orders can be placed and the stock/customer writes still work`, () => {
      bootFailure();
      const flow = state.first.flow;
      assert.ok(flow, 'the exercise run produced no flow results');
      assert.deepEqual(flow.storefront, { ok: true, status: 200, legacyVisible: true, legacyId: 1, legacyStock: 5 });
      assert.equal(flow.order.ok, true, flow.order.error);
      assert.equal(flow.order.status, 201, `placing an order on the upgraded database failed: ${flow.order.error}`);
      assert.match(String(flow.order.orderNumber), /^KAGE-[A-Z0-9]{8}$/);
      // stock decremented through the legacy shared pool
      const product = state.first.after.products.find((p) => p.id === 1);
      assert.equal(product.stock_qty, 4, 'the placed order must decrement products.stock_qty');
      assert.equal(state.first.after.orders.length, 4, 'the new order must be stored');
    });

    await check(`${testCase.name}: a customer can sign up, verify, and see legacy orders via customer_id`, () => {
      bootFailure();
      const flow = state.first.flow;
      const signup = flow['signup+verify'];
      assert.equal(signup.ok, true, signup.error);
      assert.equal(signup.signupStatus, 200, 'signup must succeed on an upgraded database');
      assert.equal(signup.verifyLinkFound, true, 'the verification email must contain a link');
      assert.equal(signup.verifyLandingStatus, 200, 'the emailed link must open the verification page');
      assert.equal(signup.verifyStatus, 200, `verification must succeed: ${JSON.stringify(signup.verifyBody)}`);
      assert.equal(signup.verifyBody && signup.verifyBody.success, true, `verification must succeed: ${JSON.stringify(signup.verifyBody)}`);

      const history = flow.history;
      assert.equal(history.ok, true, history.error);
      assert.equal(history.status, 200);
      assert.equal(history.emailVerified, true, 'the account must be verified');
      assert.deepEqual(history.orderNumbers, [flow.order.orderNumber, 'KAGE-OLD003'].sort(),
        'the verified account must see its legacy guest order AND the new order');

      // Both of those rows must be linked by customer_id, not just by email.
      const customer = state.first.after.customers.find((c) => c.email === 'buyer.legacy@kage.test');
      assert.ok(customer, 'the new customer row must exist');
      assert.equal(customer.email_verified, 1);
      const linked = state.first.after.orders.filter((o) => o.customer_id === customer.id).map((o) => o.order_number).sort();
      assert.deepEqual(linked, [flow.order.orderNumber, 'KAGE-OLD003'].sort(), 'verification must link guest orders through orders.customer_id');
    });

    await check(`${testCase.name}: the merged duplicate account still logs in with its original password`, () => {
      bootFailure();
      const login = state.first.flow.mergedLogin;
      assert.equal(login.ok, true, login.error);
      assert.equal(login.survivorLoginStatus, 200, 'login as the merged account must succeed');
      assert.equal(login.survivorName, 'First Dupe', 'the oldest row (and its password) must win the merge');
      assert.equal(login.mergedPasswordStillWorks, false, 'the deleted duplicate password must not work any more');
    });

    await check(`${testCase.name}: a second boot is a no-op`, () => {
      bootFailure();
      assertBooted(state.second, testCase.backend, `${testCase.name} (second boot)`);
      assert.deepEqual(state.second.before, state.first.after, 'rebooting against the upgraded database changed data');
      assert.equal(state.second.command, 'snapshot');
      assert.equal(state.second.flow, null);
      assert.deepEqual(state.second.before.settings.map((s) => s.key).sort(),
        ['backfill_unit_costs_v1', 'normalize_demo_categories_v1', 'normalize_emails_v1', 'seed_products_v1', 'sync_seed_sale_prices_v1'],
        'the one-time bootstrap markers must be recorded exactly once');
    });
  }

  // ---------------------------------------------------------------
  // A failure that is NOT a connection failure must surface its real
  // error (the old code answered "could not be reached" for a SQL error).
  // ---------------------------------------------------------------
  await check('a non-connection boot failure reports the real error, not "could not be reached"', () => {
    const brokenFile = path.join(workdir, 'not-a-database.db');
    fs.writeFileSync(brokenFile, 'this is definitely not an SQLite database');
    const result = runChild('snapshot', childEnv({
      VERCEL: '1',
      TURSO_DATABASE_URL: `file:${brokenFile}`
    }));
    assert.equal(result.ok, false, 'booting against a corrupt file must fail loudly');
    assert.equal(result.phase, 'boot');
    assert.match(String(result.error), /not a database|SQLITE_NOTADB/i,
      `the thrown message must carry the real error: ${result.error}`);
    const fatal = (result.output || '').split('\n').filter((l) => l.includes('FATAL'));
    assert.ok(fatal.length > 0, 'the boot failure must be logged');
    assert.ok(fatal.some((l) => /not a database|SQLITE_NOTADB/i.test(l)),
      `the logged FATAL message must carry the real error:\n${fatal.join('\n')}`);
  });

  console.log(`\n${failures.length === 0 ? 'All upgrade migration checks passed' : `${failures.length} upgrade migration check(s) failed`}`);
  if (failures.length) {
    for (const f of failures) console.error(` - ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('upgrade migration suite crashed:', err);
  process.exit(1);
});

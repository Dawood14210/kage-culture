// ================================================================
// Spawned by tests/e2e.test.js — one-shot bootstrap checks.
// ================================================================
// Every run is a separate process against the sql.js file in KAGE_DB_FILE, so
// "restart the server" is real: the in-memory module state (and the process's
// own bootstrap flag) is thrown away and only the database survives.
//
// Usage: node bootstrap-child.js <command> [args...]
// Prints one `RESULT: {json}` line the parent parses.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'bootstrap-fixture-secret-0123456789abcdef';
process.env.EMAIL_API_KEY = '';

const db = require('../../database');
const server = require('../../server.js');

const [command, arg] = process.argv.slice(2);

// Everything the shop owns that the bootstrap must never touch.
const fingerprint = async () => {
  const rows = await db.prepare('SELECT name, price, sale_price, on_sale, stock_qty FROM products ORDER BY id').all();
  return rows.map((r) => `${r.name}|${r.price}|${r.sale_price === null ? 'NULL' : r.sale_price}|${r.on_sale}|${r.stock_qty}`);
};
// Costs are reported separately: NULL may be backfilled once, 0 and real
// numbers never change.
const costs = async () => {
  const rows = await db.prepare('SELECT name, unit_cost FROM products ORDER BY id').all();
  return Object.fromEntries(rows.map((r) => [r.name, r.unit_cost]));
};
const keys = async () => {
  const rows = await db.prepare('SELECT key, value FROM app_settings ORDER BY key').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};
const count = async () => Number((await db.prepare('SELECT COUNT(*) as c FROM products').get()).c);
const emit = (payload) => console.log('RESULT: ' + JSON.stringify(payload));

(async () => {
  switch (command) {
    // 1. brand-new database → demo catalogue + all three keys
    case 'seed-fresh': {
      await server.getReady();
      emit({ products: await count(), keys: await keys() });
      return;
    }

    // 2. delete every product (admin-style), then stop
    case 'delete-all': {
      await server.getReady();
      await db.prepare('DELETE FROM product_size_stock').run();
      await db.prepare('DELETE FROM products').run();
      await db.save();
      emit({ products: await count(), keys: await keys() });
      return;
    }

    // 2b. a fresh process against the SAME file must not resurrect them
    case 'expect-empty': {
      await server.getReady();
      emit({ products: await count(), keys: await keys() });
      return;
    }

    // 3. admin removes the sale from a demo product
    case 'remove-sale': {
      await server.getReady();
      await db.prepare('UPDATE products SET sale_price = NULL, on_sale = 0 WHERE name = ?').run(arg);
      await db.save();
      emit({ product: await db.prepare('SELECT name, price, sale_price, on_sale FROM products WHERE name = ?').get(arg) });
      return;
    }

    case 'expect-no-sale': {
      await server.getReady();
      const row = await db.prepare('SELECT name, price, sale_price, on_sale FROM products WHERE name = ?').get(arg);
      emit({ products: await count(), sale_price: row && row.sale_price, on_sale: row && row.on_sale, keys: await keys() });
      return;
    }

    // 4. admin sets a deliberate unit_cost of 0
    case 'set-cost-zero': {
      await server.getReady();
      await db.prepare('UPDATE products SET unit_cost = 0 WHERE name = ?').run(arg);
      await db.save();
      emit({ product: await db.prepare('SELECT name, unit_cost FROM products WHERE name = ?').get(arg) });
      return;
    }

    case 'expect-cost-zero': {
      await server.getReady();
      const row = await db.prepare('SELECT name, unit_cost FROM products WHERE name = ?').get(arg);
      emit({ products: await count(), unit_cost: row && row.unit_cost, keys: await keys() });
      return;
    }

    // 5. simulate a production database that predates app_settings:
    //    catalogue in place, no keys, sale already removed, a deliberate 0 cost
    case 'legacy-prep': {
      await server.getReady();
      await db.prepare('DELETE FROM app_settings').run();
      await db.prepare("UPDATE products SET sale_price = NULL, on_sale = 0 WHERE name = 'Rising Vermillion'").run();
      await db.prepare("UPDATE products SET unit_cost = 0 WHERE name = 'Blade Wolf'").run();
      await db.prepare("INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, unit_cost, stock_qty, in_stock) VALUES ('Admin Custom Tee','anime','Regular',1111,NULL,0,'hand made','[\"L\"]',NULL,5,1)").run();
      await db.save();
      emit({ products: await count(), keys: await keys(), fingerprint: await fingerprint(), costs: await costs() });
      return;
    }

    // Fingerprint WITHOUT running the bootstrap (init only: schema + migrations)
    case 'fingerprint': {
      await db.init();
      emit({ products: await count(), keys: await keys(), fingerprint: await fingerprint(), costs: await costs() });
      return;
    }

    // 5b. run the bootstrap against that existing database
    case 'legacy-check': {
      await server.getReady();
      const rv = await db.prepare("SELECT sale_price, on_sale FROM products WHERE name = 'Rising Vermillion'").get();
      const bw = await db.prepare("SELECT unit_cost FROM products WHERE name = 'Blade Wolf'").get();
      const custom = await db.prepare("SELECT unit_cost FROM products WHERE name = 'Admin Custom Tee'").get();
      emit({
        products: await count(),
        keys: await keys(),
        fingerprint: await fingerprint(),
        costs: await costs(),
        risingVermillion: { sale_price: rv && rv.sale_price, on_sale: rv && rv.on_sale },
        bladeWolfCost: bw && bw.unit_cost,
        customCost: custom && custom.unit_cost
      });
      return;
    }

    // 6. a failing database must not record any of its keys …
    // Every products query throws while the bootstrap runs — the same shape a
    // real outage has on Turso (the sql.js backend swallows SQL errors, so the
    // failure is injected at the prepare() boundary).
    case 'break-seed': {
      await db.init();
      const realPrepare = db.prepare;
      let failing = true;
      db.prepare = (sql) => {
        if (failing && /products/i.test(sql)) throw new Error('simulated products-table outage');
        return realPrepare(sql);
      };
      try { await server.getReady(); } catch (e) { /* surfaced as a missing marker */ }
      const afterFailure = await keys();
      failing = false;
      db.prepare = realPrepare;
      emit({ keysAfterFailure: afterFailure, products: await count() });
      return;
    }

    // 6b. … and the next run must seed for real
    case 'expect-seeded': {
      await server.getReady();
      emit({ products: await count(), keys: await keys() });
      return;
    }

    default:
      throw new Error('unknown command: ' + command);
  }
})().then(() => process.exit(0)).catch((err) => {
  console.error('FIXTURE ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});

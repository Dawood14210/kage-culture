#!/usr/bin/env node
// ================================================================
// KAGE Culture — load the demo catalogue (local / self-hosted)
// ================================================================
// The launch products are seeded once per database. Use this when you deleted
// them and want them back:
//
//   KAGE_DB_FILE=./kage.db npm run seed
//
// Without KAGE_DB_FILE the local sql.js backend is in-memory, so the seed would
// vanish with the process — set it (or a Turso URL) to keep the result. On a
// deployed shop, run it via the admin API instead:
//   curl -X POST https://<your-site>/api/admin/seed-demo  (with the admin session cookie + CSRF token)
const db = require('../database');
const { seedDemoProducts } = require('../utils/demoProducts');

(async () => {
  await db.init();
  const { added, skipped } = await seedDemoProducts(db);
  const total = await db.prepare('SELECT COUNT(*) as c FROM products').get();
  await db.save();
  console.log(`Seeded ${added} demo product(s); ${skipped} already present. Catalogue now has ${total ? Number(total.c) : 0} product(s).`);
  if (!process.env.KAGE_DB_FILE && !process.env.TURSO_DATABASE_URL) {
    console.log('NOTE: no KAGE_DB_FILE / TURSO_DATABASE_URL set — this local in-memory database disappears with the process. Use `npm run dev` with KAGE_DB_FILE=./kage.db instead.');
  }
})().catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });

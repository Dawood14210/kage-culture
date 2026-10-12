// ================================================================
// KAGE Culture — demo catalogue
// ================================================================
// The launch catalogue. It is inserted ONCE per database (tracked by
// `seed_products_v1` in app_settings) — never on every cold start, so a shop
// that deleted the demo products stays deleted. The same list backs
// `POST /api/admin/seed-demo` and `npm run seed`, which is how you bring the
// demo products back on purpose.
const DEMO_PRODUCTS = [
  { name: 'Shadow Fit', price: 1499, cost: 820, stock: 4, category: 'anime', fit: 'Compression', size: 'L', desc: '4-way stretch muscle-fit compression shirt.' },
  { name: 'Oni Muscle Tee', price: 1599, cost: 875, stock: 8, category: 'anime', fit: 'Compression', size: 'XL', desc: 'Sleeveless compression with bold contrast panels.' },
  { name: 'Kage Core Compression', price: 1399, cost: 760, stock: 12, category: 'anime', fit: 'Compression', size: 'M', desc: 'Core compression layer — seamless, breathable.' },
  { name: 'Rising Vermillion', price: 999, sale: 799, cost: 545, stock: 3, category: 'graphic-tees', fit: 'Regular', size: 'XL', desc: 'Heavyweight 220GSM cotton tee.' },
  { name: 'Blade Wolf', price: 1149, cost: 620, stock: 10, category: 'graphic-tees', fit: 'Regular', size: 'L', desc: 'Silver ink on black — a lone wolf under a crescent moon.' },
  { name: 'Neon Fangs', price: 1049, cost: 570, stock: 6, category: 'graphic-tees', fit: 'Regular', size: 'M', desc: 'Electric strike — neon clash across heavyweight cotton.' },
  { name: 'Shinobi Mark', price: 999, cost: 540, stock: 15, category: 'graphic-tees', fit: 'Regular', size: 'S', desc: 'Minimalist shinobi crest.' },
  { name: 'Drift Oversized', price: 1199, cost: 650, stock: 5, category: 'graphic-tees', fit: 'Oversized', size: 'XL', desc: 'Drop-shoulder, relaxed fit.' },
  { name: 'Wrath Silhouette', price: 1249, sale: 1099, cost: 680, stock: 7, category: 'graphic-tees', fit: 'Oversized', size: 'L', desc: 'Boxy, cropped oversized fit.' },
  { name: 'Hollow Gaze', price: 1149, cost: 625, stock: 0, category: 'graphic-tees', fit: 'Oversized', size: 'XXL', desc: 'Extended drop-shoulder with raw hem. Restock coming soon.' }
];

// Previous seed versions grouped these four regular graphic tees under anime.
// Update only rows still carrying that old default during the one-time upgrade;
// any different category explicitly chosen by an admin is left alone.
const LEGACY_CATEGORY_FIXES = [
  { name: 'Rising Vermillion', from: 'anime', to: 'graphic-tees' },
  { name: 'Blade Wolf', from: 'anime', to: 'graphic-tees' },
  { name: 'Neon Fangs', from: 'anime', to: 'graphic-tees' },
  { name: 'Shinobi Mark', from: 'anime', to: 'graphic-tees' }
];

// Same sale prices the seeded products ship with, applied only to rows the
// shop has not touched (sale_price IS NULL and the original price still there).
const SEED_SALE_SYNCS = [
  { name: 'Rising Vermillion', price: 999, sale: 799 },
  { name: 'Wrath Silhouette', price: 1249, sale: 1099 }
];

// Insert every demo product that is not already present (matched by name, so
// re-running after a partial insert never duplicates rows). Returns counts.
async function seedDemoProducts(db) {
  const insert = await db.prepare('INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, unit_cost, stock_qty, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  let skipped = 0;
  for (const p of DEMO_PRODUCTS) {
    const exists = await db.prepare('SELECT id FROM products WHERE name = ?').get(p.name);
    if (exists) { skipped += 1; continue; }
    await insert.run([p.name, p.category, p.fit, p.price, p.sale || null, p.sale ? 1 : 0, p.desc, JSON.stringify([p.size || 'L']), p.cost, p.stock, p.stock > 0 ? 1 : 0]);
    added += 1;
  }
  await db.save();
  return { added, skipped };
}

module.exports = { DEMO_PRODUCTS, LEGACY_CATEGORY_FIXES, SEED_SALE_SYNCS, seedDemoProducts };

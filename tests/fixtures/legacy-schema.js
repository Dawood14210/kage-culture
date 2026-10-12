// ================================================================
// Legacy database fixture — the "before" database an upgrade must survive.
// ----------------------------------------------------------------
// This file builds a database with the schema and rows of a shop that was
// provisioned by a build from before this series of changes, i.e. before
//
//   ab7abe1  customers.email_verified, orders.customer_id,
//            customer_verification_tokens, app_settings
//   90f05bc  reviews.viewer_token
//   4461472  rate_limits
//
// Every column/table the current migrations add is deliberately absent here,
// so booting the current code against this file exercises every ALTER and every
// index that depends on one:
//
//   products   — no unit_cost, no [drop]         (added by ALTER)
//   orders     — no payment_ref / payment_verified / cod_confirmed /
//                shipping_pending / customer_id (added by ALTER)
//   customers  — no email_verified               (added by ALTER)
//   reviews    — no viewer_token                 (added by ALTER)
//   absent tables: app_settings, rate_limits, customer_verification_tokens
//
// The DDL is the historical text from the first build of each table:
//   products/orders                     git 192c9dc (first commit)
//   customers/reviews/coming_soon       git 69aa6e5
//   newsletter_subscribers              git 55c5ccd
//   password_reset_tokens + indexes     git 602ad48
//   product_size_stock                  git 63f882d
// Everything the later migrations add was removed from those definitions, and
// the pre-90f05bc index set is created (an old database really has these).
//
// Used by tests/upgrade-migration.test.js. Run standalone to materialise a
// file:  node tests/fixtures/legacy-schema.js /tmp/legacy.db
// ================================================================

const DDL = [
  `CREATE TABLE admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // 192c9dc products, minus unit_cost and [drop] (both added later by ALTER)
  `CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    fit TEXT,
    price REAL NOT NULL,
    sale_price REAL,
    on_sale INTEGER DEFAULT 0,
    description TEXT,
    sizes TEXT DEFAULT '["S","M","L","XL","XXL"]',
    front_image TEXT,
    back_image TEXT,
    extra_images TEXT DEFAULT '[]',
    in_stock INTEGER DEFAULT 1,
    -- Legacy themed-collections column: real 192c9dc databases have it, so the
    -- fixture keeps it to prove upgrades of such databases stay safe. Current
    -- code never reads or writes it (and never drops it).
    collections TEXT DEFAULT '[]',
    stock_qty INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // 192c9dc orders, minus the five columns added later by ALTER
  `CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    notes TEXT,
    payment_method TEXT NOT NULL,
    subtotal REAL NOT NULL,
    shipping REAL NOT NULL,
    total REAL NOT NULL,
    items_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // 69aa6e5 customers, minus email_verified (added later by ALTER)
  `CREATE TABLE customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // 69aa6e5 reviews, minus viewer_token (added later by ALTER)
  `CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    order_number TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE newsletter_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE coming_soon_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_type TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE product_size_stock (
    product_id INTEGER NOT NULL,
    size TEXT NOT NULL,
    stock_qty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, size)
  )`,
  // The index set an old database already has (from 602ad48 onwards). The
  // customer_id / verification-token / rate-limit indexes do NOT exist yet —
  // that is exactly what used to make startup fail before the ALTERs ran.
  'CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email)',
  'CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number)',
  'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id)',
  'CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)',
  'CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)',
  'CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)',
  'CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash)'
];

// Passwords the fixture accounts really have — the upgrade must preserve
// password_hash through the duplicate-email merge, and the test logs in with
// the surviving account to prove it.
const DUPLICATE_EMAIL_PASSWORDS = {
  survivor: 'first-dupe-pass',   // customers id 1 — "Dupe@Kage.test" (oldest)
  merged: 'second-dupe-pass'     // customers id 2 — "dupe@kage.test" (dupe)
};
// Fallback for rows that are never logged into (kept cheap).
const PLACEHOLDER_PASSWORD_HASH = '$2a$04$0123456789012345678901uGZ8y1YQ7Am5LQXb0kM9Tg5S4SGm2';

const ORDERS = [
  {
    order_number: 'KAGE-OLD001',
    customer_name: 'Ayesha Khan',
    email: 'Ayesha@Kage.test', // mixed case on purpose — normalisation runs at boot
    phone: '03001234567',
    address: '12 Garden Town',
    city: 'Lahore',
    notes: 'leave at the gate',
    payment_method: 'cod',
    subtotal: 2500,
    shipping: 0,
    total: 2500,
    status: 'delivered',
    created_at: '2026-08-01 10:00:00',
    items: [{ id: 1, name: 'Legacy Graphic Tee', size: 'M', qty: 1, unit: 2500, total: 2500 }]
  },
  {
    order_number: 'KAGE-OLD002',
    customer_name: 'Bilal Ahmed',
    email: 'bilal@kage.test',
    phone: '03217654321',
    address: '44 Model Town',
    city: 'Karachi',
    notes: null,
    payment_method: 'jazzcash',
    subtotal: 2900,
    shipping: 0,
    total: 2900,
    status: 'shipped',
    created_at: '2026-08-05 12:30:00',
    items: [{ id: 2, name: 'Legacy Anime Shirt', size: 'L', qty: 1, unit: 2900, total: 2900 }]
  },
  {
    // Guest order placed with an address that is about to sign up: after the
    // upgrade the verification flow must link it through orders.customer_id.
    order_number: 'KAGE-OLD003',
    customer_name: 'Legacy Buyer',
    email: 'Buyer.Legacy@Kage.test', // mixed case on purpose
    phone: '03334455667',
    address: '9 Gulberg',
    city: 'Lahore',
    notes: null,
    payment_method: 'cod',
    subtotal: 3200,
    shipping: 0,
    total: 3200,
    status: 'pending',
    created_at: '2026-08-09 09:15:00',
    items: [{ id: 2, name: 'Legacy Anime Shirt', size: 'M', qty: 1, unit: 3200, total: 3200 }]
  }
];

const PRODUCTS = [
  {
    name: 'Legacy Graphic Tee',
    category: 'graphic-tees',
    fit: 'Regular',
    price: 2500,
    sale_price: null,
    on_sale: 0,
    description: 'Original art tee',
    sizes: '["S","M","L"]',
    stock_qty: 5,
    in_stock: 1
  },
  {
    name: 'Legacy Anime Shirt',
    category: 'anime',
    fit: 'Oversized',
    price: 3200,
    sale_price: 2900,
    on_sale: 1,
    description: 'Anime art shirt',
    sizes: '["M","L","XL"]',
    stock_qty: 2, // the sum of its product_size_stock rows below
    in_stock: 1
  }
];

// ----------------------------------------------------------------
// Builders
// ----------------------------------------------------------------
// `db` is a plain sql.js Database (or any object with run/prepare in that
// shape). The module is deliberately free of database.js imports so it can also
// build a fixture while an older database.js is being tested.
async function buildLegacyDatabase(db, { bcrypt } = {}) {
  const bcryptjs = bcrypt || require('bcryptjs');
  for (const sql of DDL) db.run(sql);

  const insert = (sql, params) => {
    const stmt = db.prepare(sql);
    try { stmt.run(params); } finally { stmt.free(); }
  };

  for (const p of PRODUCTS) {
    insert(
      `INSERT INTO products (name, category, fit, price, sale_price, on_sale, description, sizes, extra_images, in_stock, stock_qty, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, '2026-07-01 09:00:00', '2026-07-01 09:00:00')`,
      [p.name, p.category, p.fit, p.price, p.sale_price, p.on_sale, p.description, p.sizes, p.in_stock, p.stock_qty]
    );
  }

  // Per-size stock for product 2 (kept in sync with products.stock_qty above).
  insert('INSERT INTO product_size_stock (product_id, size, stock_qty) VALUES (2, ?, ?)', ['M', 1]);
  insert('INSERT INTO product_size_stock (product_id, size, stock_qty) VALUES (2, ?, ?)', ['L', 1]);

  for (const o of ORDERS) {
    insert(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, notes, payment_method, subtotal, shipping, total, items_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [o.order_number, o.customer_name, o.email, o.phone, o.address, o.city, o.notes, o.payment_method,
        o.subtotal, o.shipping, o.total, JSON.stringify(o.items), o.status, o.created_at]
    );
  }

  // Duplicate mixed-case customers: the boot migration must merge them, keeping
  // the OLDEST row (and its password), lowercasing the address, re-pointing
  // references and dropping the newer duplicate. Login as the survivor with the
  // FIRST password is asserted by the upgrade test.
  const customers = [
    ['Dupe@Kage.test', bcryptjs.hashSync(DUPLICATE_EMAIL_PASSWORDS.survivor, 4), 'First Dupe', '03111111111', '1 Dupe St', 'Lahore', '2026-07-01 08:00:00'],
    ['dupe@kage.test', bcryptjs.hashSync(DUPLICATE_EMAIL_PASSWORDS.merged, 4), 'Second Dupe', '03222222222', '2 Dupe St', 'Karachi', '2026-07-10 08:00:00'],
    ['Solo@Kage.test', PLACEHOLDER_PASSWORD_HASH, 'Solo Customer', '03333333333', '3 Solo St', 'Islamabad', '2026-07-15 08:00:00']
  ];
  for (const c of customers) {
    insert('INSERT INTO customers (email, password_hash, name, phone, address, city, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', c);
  }

  // A live password reset for the solo customer — the merge must not damage
  // tokens that point at a customer which survived unchanged.
  insert(
    `INSERT INTO password_reset_tokens (user_type, user_id, token_hash, expires_at, used, created_at)
     VALUES ('customer', 3, ?, '2026-09-01 00:00:00', 0, '2026-08-30 00:00:00')`,
    ['fixture-reset-token-hash']
  );

  insert(
    `INSERT INTO reviews (product_id, order_number, customer_name, rating, comment, status, created_at)
     VALUES (1, 'KAGE-OLD001', 'Ayesha Khan', 5, 'Great shirt', 'approved', '2026-08-02 09:00:00')`
  );
  insert(
    `INSERT INTO reviews (product_id, order_number, customer_name, rating, comment, status, created_at)
     VALUES (1, 'KAGE-OLD002', 'Bilal Ahmed', 3, 'Decent', 'pending', '2026-08-06 09:00:00')`
  );

  // Duplicate mixed-case newsletter rows (same merge rules as customers).
  insert('INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, ?)', ['Fan@Kage.test', '2026-07-02 08:00:00']);
  insert('INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, ?)', ['fan@kage.test', '2026-07-12 08:00:00']);
  insert('INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, ?)', ['solo-sub@kage.test', '2026-07-20 08:00:00']);

  insert('INSERT INTO coming_soon_signups (email, category, created_at) VALUES (?, ?, ?)', ['ComingSoon@Kage.test', 'stickers', '2026-07-25 08:00:00']);

  return db;
}

// Materialise a legacy database file on disk (sql.js writes ordinary SQLite).
async function writeLegacyDatabaseFile(filePath, { fs = require('fs') } = {}) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  await buildLegacyDatabase(db);
  fs.writeFileSync(filePath, Buffer.from(db.export()));
  db.close();
  return filePath;
}

module.exports = {
  DDL,
  PRODUCTS,
  ORDERS,
  DUPLICATE_EMAIL_PASSWORDS,
  buildLegacyDatabase,
  writeLegacyDatabaseFile
};

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node tests/fixtures/legacy-schema.js <path-to-create.db>');
    process.exit(1);
  }
  writeLegacyDatabaseFile(require('path').resolve(target))
    .then((file) => console.log('legacy fixture written:', file))
    .catch((err) => { console.error('failed to write legacy fixture:', err); process.exit(1); });
}

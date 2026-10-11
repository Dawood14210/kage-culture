# KAGE CULTURE — Deploy to Vercel

The app is **serverless-ready** when configured with persistent production storage:
- **Database:** Turso (edge SQLite), configured with `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`.
- **Images:** a **Public** Vercel Blob store, configured with `BLOB_READ_WRITE_TOKEN` (**required to add or edit products with images on Vercel**). Product images are served directly to storefront visitors.
- **Sessions:** signed cookies (`cookie-session`), configured with `SESSION_SECRET`.

> ⚠️ Vercel's function filesystem is ephemeral/read-only. Do not rely on local
> `./uploads` for deployed product images. If Blob storage is missing, product
> image uploads will fail. Set all four variables below before using the admin panel.

---

## Step 1 — Push the code to GitHub

1. Create a repo at https://github.com/new (name it e.g. `kage-culture`, **Public** or **Private** both work).
2. In your project folder, run:

```bash
git init
git add .
git commit -m "KAGE Culture — storefront + admin with checkout, P&L, Turso-ready"
git branch -M main
git remote add origin https://github.com/<YOUR-USERNAME>/kage-culture.git
git push -u origin main
```

(`.gitignore` already excludes `node_modules/`, `kage.db`, `uploads/`, `.env`.)

## Step 2 — Create the Turso database (free)

1. Sign up at https://turso.tech (GitHub login works).
2. Create a new database — name it `kage`.
3. In the database page, copy the **Database URL** (looks like `libsql://kage-xxxx.turso.io`).
4. Click **Generate Token** (read-write) and copy the token.
5. Keep both — you'll paste them into Vercel in Step 4.

> The app runs its own schema + seed on first boot, so an empty Turso database is fine.

## Step 3 — Import the project into Vercel

1. Go to https://vercel.com/new
2. **Import Git Repository** → select `kage-culture`.
3. Vercel auto-detects the project (the `vercel.json` in the repo tells it to run `server.js` as the serverless handler).
4. Click **Deploy**. First deploy may succeed but data won't persist yet — that's expected until Step 4.

## Step 4 — Add environment variables

In the Vercel project: **Settings → Environment Variables**, add for **Production** (and Preview/Development if you want them):

| Name | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://kage-xxxx.turso.io` (from Step 2) |
| `TURSO_AUTH_TOKEN` | the token from Step 2 |
| `BLOB_READ_WRITE_TOKEN` | **Required for product image uploads:** create/connect a **Public** Vercel Blob store, then use its read-write token |
| `SESSION_SECRET` | **required, >= 32 characters.** Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

Vercel's Storage quickstart may show a store-prefixed variable such as `kage_READ_WRITE_TOKEN`; this app accepts that variable as well as `BLOB_READ_WRITE_TOKEN`.

> **`SESSION_SECRET` is mandatory outside local development.** The only place a
> built-in fallback is allowed is `NODE_ENV=development` or `NODE_ENV=test`. With
> `NODE_ENV` unset (or set to anything else, e.g. `staging`) the server exits at
> boot with `FATAL: SESSION_SECRET is required.` — because the fallback string is
> public in this repo and would let anyone forge an admin session cookie. This
> applies to every host, not just Vercel: set `NODE_ENV=production` **and** a
> >= 32-character `SESSION_SECRET` on a VPS, Render, Railway, Docker, etc.
> A secret shorter than 32 characters is also rejected.

Then **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect.

## Demo products

The launch catalogue (20 products) is inserted **once per database**. After
that, the admin panel is the only thing that changes the catalogue — deleting
every product leaves the shop empty, removing a sale keeps it removed, and a
deliberate `unit_cost` of 0 stays 0. Every cold start and redeploy skips this
step (it is recorded in the `app_settings` table).

To bring the demo products back on purpose:

- **On a deployed shop:** `POST /api/admin/seed-demo` with an admin session
  (the admin panel already sends the CSRF token with every write — use the same
  cookie + `X-CSRF-Token` header pair as any other admin write). Products that
  already exist are skipped by name, never duplicated.
- **Locally / self-hosted:** `KAGE_DB_FILE=./kage.db npm run seed`.
  `KAGE_DB_FILE` also makes the local sql.js database persist across restarts,
  which is what makes the "delete everything, restart, still empty" behaviour
  observable locally.

## Step 5 — Create the first admin + first product

Admin setup is deliberately gated and has **no public setup form**. On a fresh database only:

1. Temporarily set `ALLOW_ADMIN_SETUP=true` in the Vercel project's environment variables and redeploy.
2. Send one `POST` request to `/api/admin/setup` with JSON body `{"email":"your-admin-email","password":"your-strong-password"}` (for example, using an API client). Do not share the password in chat or commit it.
3. Immediately remove `ALLOW_ADMIN_SETUP` (or set it to `false`) and redeploy. The setup endpoint must return 403 afterward.
4. Open `/admin` and sign in with the account you just created.
5. Add a product — its image is stored in Vercel Blob and its product record in Turso.

## Step 6 — Keep it updated

Every `git push` to `main` triggers an automatic redeploy. No manual steps.

---

## Local development

```bash
npm install
npm run dev   # http://localhost:3000 — sets NODE_ENV=development, loads .env if present
```

`npm run dev` is the only entry point that sets `NODE_ENV=development` and reads
`.env` (a ~10-line loader in `scripts/dev.js`; the project deliberately has no
dotenv dependency). By default it uses the in-memory sql.js DB (resets on exit)
+ `./uploads`; set `KAGE_DB_FILE=./kage.db` to persist the local database to a
file (that file is gitignored).

Plain `npm start` / `node server.js` does **not** read `.env` and does **not** set
`NODE_ENV`, so it needs real environment variables:

```bash
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
export NODE_ENV=development      # or export a SESSION_SECRET and run as production
node server.js
```

To preview the cloud behavior locally, export the Turso/Blob variables too.

## Troubleshooting

- **"Admin account already exists"** — you're on a DB that already has one. That's correct behavior; just log in.
- **Adding a product says image storage is not configured / uploads fail** — make sure a **Public** Vercel Blob store is connected, its `BLOB_READ_WRITE_TOKEN` is set for Production, and the deployment was redeployed afterward. This storefront displays product images from public URLs. Never substitute local `./uploads` on Vercel; files there are not durable.
- **`FATAL: SESSION_SECRET is required.`** — you ran `node server.js`/`npm start` without `SESSION_SECRET` and without `NODE_ENV=development` (or `test`). Use `npm run dev` for local work, or export a generated secret as shown above.
- **`503 Service temporarily unavailable` on a cold start** — the database could
  not be reached (Turso briefly down, env var added but not redeployed, network
  blip). The instance keeps the failure for `READY_RETRY_BACKOFF_MS` (1 s), then
  retries on the next request — no restart needed — and answers with
  `Retry-After: 1` meanwhile. Check the deployment logs for the real reason.
- **Demo products came back / a sale came back / a unit cost was overwritten** —
  this must not happen; each one-time step (`seed_products_v1`,
  `sync_seed_sale_prices_v1`, `backfill_unit_costs_v1`) is recorded in
  `app_settings` and skipped forever after. If you *want* the demo products
  again, use `POST /api/admin/seed-demo` (or `npm run seed` locally).
- **Data resets** — `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are missing or a redeploy hasn't happened since adding them.

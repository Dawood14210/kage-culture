# KAGE CULTURE — Deploy to Vercel

The app is **serverless-ready** when configured with persistent production storage:
- **Database:** Turso (edge SQLite), configured with `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`.
- **Shared rate limits:** Turso is also the cross-instance store for IP rate-limit windows and per-account login lockouts. The `rate_limits` table is created/migrated automatically with the rest of the schema; no separate service is needed. With Turso configured, the shared store is enabled automatically. For a non-Turso deployment, set `RATE_LIMIT_STORE=db` when the app uses a database shared by its instances (for local multi-process sql.js, also point all instances at the same `KAGE_DB_FILE`).
- **Images:** a **Public** Vercel Blob store, configured with `BLOB_READ_WRITE_TOKEN` (**required to add or edit products with images on Vercel**). Product images are served directly to storefront visitors.
- **Sessions:** signed cookies (`cookie-session`), configured with `SESSION_SECRET`.
- **Runtime:** Node.js 20 or newer (required by the current patched Nodemailer release).

> ⚠️ Vercel's function filesystem is ephemeral/read-only. Do not rely on local
> `./uploads` for deployed product images. If Blob storage is missing, product
> image uploads will fail. Set the required production variables below before
> using the admin panel or sending account-verification emails.

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
| `SESSION_SECRET` | **Required, >= 32 characters.** Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SITE_URL` | The canonical public HTTPS origin for this shop. Set it to your assigned production URL or your configured custom domain; do not copy another shop's domain. |
| `SMTP_HOST` | Optional: set to `smtp.gmail.com` to send via Gmail SMTP. SMTP takes precedence over Resend when set. |
| `SMTP_PORT` | Optional: defaults to `465` (implicit TLS). Gmail port `587` uses STARTTLS. |
| `SMTP_USER` | Gmail SMTP account's full email address; also the default `EMAIL_FROM` when SMTP is used. |
| `SMTP_PASS` | Gmail **App Password** (not the Google account password). Store it as a Vercel secret/environment variable. |
| `EMAIL_FROM` | Optional sender address/name. Defaults to `SMTP_USER` for SMTP, or the existing KAGE Culture sender for Resend. |
| `EMAIL_API_KEY` | Optional Resend API key; used only when `SMTP_HOST` is unset. With neither provider configured, emails are logged in dev mode and not delivered. |
| `RATE_LIMIT_STORE` | Optional: set to `db` for a non-Turso deployment using a database shared by its instances. Turso enables the DB store automatically. |

`SITE_URL` is the single source for page canonical/Open Graph URLs, structured data,
`/sitemap.xml`, `/robots.txt`, and password-reset/verification email links. If it is
unset in production, page metadata and crawler files fall back to the current request
origin and a warning is logged; password-reset and verification emails are suppressed
rather than sent with a guessed domain.

### Gmail SMTP setup (optional)

1. Sign in to the Google account that will send shop mail, enable **2-Step Verification**, then create an **App Password** in the Google Account security settings (at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)). Google may hide this option for managed Workspace accounts or accounts using certain security policies; an administrator may need to allow it.
2. In Vercel's **Settings → Environment Variables**, add `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER` as the full Gmail address, and `SMTP_PASS` as the generated App Password (remove any display spaces). Do **not** use the account's regular password or commit the App Password to the repository.
3. `EMAIL_FROM` is optional; if omitted, messages use `SMTP_USER` as the sender. Set `EMAIL_FROM` only to an address/name Gmail is authorized to send as. Port `465` uses implicit TLS (the default); set `SMTP_PORT=587` to use STARTTLS instead.
4. Redeploy after saving the variables. When `SMTP_HOST` is set it takes precedence over `EMAIL_API_KEY`; remove `SMTP_HOST` to switch back to Resend. SMTP and Resend sends are bounded by an 8-second timeout, and a delivery failure is logged as a warning without rejecting an order.

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
file (that file is gitignored). Local rate limits stay in process memory unless
`RATE_LIMIT_STORE=db` is set. With Turso, the DB store is automatic; with a
persistent local sql.js file, `RATE_LIMIT_STORE=db` uses the same `rate_limits`
table across server processes sharing that file.

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

## 2026-10-12 — Category consolidation (Pants / Graphic Tees / removed Streetwear + Goofy Wears)

**What changes for shoppers.** The homepage now has four category tiles
(Graphic Tees, Anime Shirts, Pants, Custom Stickers). Pants shows as
"Coming soon" and links to nothing until you list at least one in-stock
Pants product; at that moment it automatically becomes a live link and
also appears in the header nav, mobile menu and the new Shop footer
column. Graphic Tees always opens the shop grid — when nothing is in stock
shoppers see an empty-state message instead of the Coming Soon page.

**One-time data migration.** The first request that hits the server after
deploy runs `remove_old_categories_v1`: any product whose `category` is
not one of `graphic-tees`, `anime`, `pants` — including any legacy
`streetwear`, `goofy-wears` or typos — is moved into `graphic-tees` so it
stays visible in the catalog. The migration is idempotent (re-running
finds zero rows and records its key with `migrated:0`) and logs how many
rows it moved (e.g. `👖 Migrated 3 product(s) from removed categories into
Graphic Tees`). Products already in an allowed category are left
untouched, including any admin edits.

**Before deploying, back up your database.** If you use Turso:

```bash
turso db list                 # find your DB name
turso db shell <DB> ".dump" > kage-backup-$(date +%Y%m%d-%H%M).sql
```

For local file databases copy the `.db` file out of `.data/` (or wherever
it is mounted). The migration is a single `UPDATE … WHERE category NOT IN
(...)` statement, but a backup is cheap insurance.

**Admin panel.** Product category dropdowns now list exactly three
options: Graphic Tees, Anime Shirts, Pants. Creating or saving a product
with any other category (including old Streetwear/Goofy Wears values that
may come through stale browser tabs or direct API calls) is rejected with
HTTP 400. Custom Stickers is still a standalone page, **not** a product
category — upload sticker designs as products in another category or keep
using the Custom Stickers form that already exists.

**Rolling back.** If you need to roll the deploy back, note that:
- The `remove_old_categories_v1` row in `app_settings` keeps the migration
  from re-running; a rolled-back server will simply ignore it.
- Products migrated from `streetwear`/`goofy-wears`/unknown into
  `graphic-tees` will stay there; re-categorize them manually in the
  admin panel if needed.
- Newly created `pants` products will appear under Graphic Tees in older
  code paths (older builds only recognized `anime`/`graphic-tees`/
  `streetwear`/`goofy-wears`), so prefer a forward roll to listing pants.

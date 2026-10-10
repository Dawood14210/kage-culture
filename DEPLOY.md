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
| `SESSION_SECRET` | any long random string (e.g. from `openssl rand -hex 32`) |

Vercel's Storage quickstart may show a store-prefixed variable such as `kage_READ_WRITE_TOKEN`; this app accepts that variable as well as `BLOB_READ_WRITE_TOKEN`.

Then **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect.

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

## Local development (unchanged)

```bash
npm install
npm start   # http://localhost:3000 — uses an in-memory sql.js DB (resets on exit) + ./uploads
```

To preview the cloud behavior locally, export the Turso/Blob variables before `npm start`.

## Troubleshooting

- **"Admin account already exists"** — you're on a DB that already has one. That's correct behavior; just log in.
- **Adding a product says image storage is not configured / uploads fail** — make sure a **Public** Vercel Blob store is connected, its `BLOB_READ_WRITE_TOKEN` is set for Production, and the deployment was redeployed afterward. This storefront displays product images from public URLs. Never substitute local `./uploads` on Vercel; files there are not durable.
- **Data resets** — `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are missing or a redeploy hasn't happened since adding them.

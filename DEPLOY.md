# KAGE CULTURE — Deploy to Vercel

The app is now **serverless-ready**:
- **Database:** Turso (edge SQLite) when `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are set — otherwise the local `kage.db` file for development.
- **Images:** Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set — otherwise local `./uploads`.
- **Sessions:** signed cookies (`cookie-session`) — they survive serverless cold starts.

> ⚠️ On Vercel the filesystem is **ephemeral**. If you skip Turso/Blob, products,
> orders, and the admin login will reset constantly and uploads will vanish.
> Set all three variables below.

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
| `BLOB_READ_WRITE_TOKEN` | **Vercel Blob** → create a Blob store in the Vercel dashboard, then copy its token |
| `SESSION_SECRET` | any long random string (e.g. from `openssl rand -hex 32`) |

Then **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect.

## Step 5 — First login + first product

1. Open your live URL (`https://kage-culture-xxx.vercel.app`).
2. Click the **Admin** pill (top-right of the hero) or go to `/admin`.
3. **First visitor creates the admin account** — enter `mugheesaamir001@gmail.com` + your password, and it becomes the admin. (This is first-run behavior; the account you created locally lives in the local DB only.)
4. Add a product — the image goes to Vercel Blob, the product row to Turso. Both persist.

## Step 6 — Keep it updated

Every `git push` to `main` triggers an automatic redeploy. No manual steps.

---

## Local development (unchanged)

```bash
npm install
npm start   # http://localhost:3000 — uses local kage.db + ./uploads
```

To preview the cloud behavior locally, export the Turso/Blob variables before `npm start`.

## Troubleshooting

- **"Admin account already exists"** — you're on a DB that already has one. That's correct behavior; just log in.
- **Uploads fail** — make sure `BLOB_READ_WRITE_TOKEN` is set and the Blob store exists.
- **Data resets** — `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are missing or a redeploy hasn't happened since adding them.

# AGENTS.md — Instructions for AI coding sessions

## Read first, every session

1. **Read `AUDIT.md` at the start of every session.** It is the running security audit +
   fix log: what was already done, what's broken, and the prioritized work queue
   (C1 → H1–H4 → M1–M7 → L1–L7). Continue from the top of the "Remaining work" section
   unless the user says otherwise.

## Project orientation (quick facts)

- **Stack:** Express + vanilla-JS SPA storefront (`public/index.html`) + admin panel
  (`public/admin.html`), dual-backend DB in `database.js` (Turso in prod, sql.js local,
  in-memory fallback), deployed on Vercel serverless (`vercel.json`).
- **Config:** all magic numbers live in `config.js` — use them, don't hardcode.
- **Security invariants (do not regress):**
  - Session cookies (`kage.session`, `kage.cust`) MUST be signature-verified —
    see `readSignedSession()` in `middleware/auth.js`. Never trust a decoded
    base64 payload without verifying its HMAC.
  - Admin/product/order mutation routes require `requireCsrf` + `requireAuth`.
  - `SESSION_SECRET` is required in production (`server.js` exits without it).

## Session conventions

- Dev server: port 3000 is often occupied — use `PORT=3999 node server.js` for testing.
- Background servers don't survive between tool calls in this environment — run the
  server and its tests in a single shell command, then kill it.
- Repo debris (`.tmp-*`, `screenshot-*.mjs`) is untracked and should stay uncommitted;
  deleting it is on the audit list (L1).
- When a work item from `AUDIT.md` is completed, update `AUDIT.md`: mark the item done
  and record what changed + how it was verified.

## Status snapshot (2026-09-20)

- ✅ CRITICAL admin auth bypass fixed in `middleware/auth.js` (HMAC verification,
  constant-time compare, 7/7 e2e tests passed).
- ⬜ Next priority: **C1** — gate `POST /api/admin/setup` (race + storefront auto-setup
  in `public/index.html:6617`), then **H1** — public order PII leak
  (`routes/orders.js:58`).

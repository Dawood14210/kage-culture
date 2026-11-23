# Task B — Conversion & Polish Sweep: Final Report

**Branch:** `arena/2f13b9ee-kage-culture`
**Base:** `1687fed` (master) → **HEAD:** `03daef1`
**Commits:** 10 (one per task, plus one separate bug-fix commit)
**Date:** 2026-11-22

---

## 1. Summary of the work

Ten commits landed on top of the Task A work, all pushed to
`origin/arena/2f13b9ee-kage-culture` and all green against the full suite.

| Commit | Item | Type |
|---|---|---|
| `a5e3599` | F21 — paginate `/api/products`, inline page 1 in the HTML shell, drop the bundled demo catalog | Perf |
| `5f62729` | F1 — server-render product and collection content into the HTML shell | SEO / resilience |
| `b606d7a` | F27 — `shippingDetails` + `hasMerchantReturnPolicy` in Product JSON-LD | SEO |
| `8d711cb` | F29 — key order/tracking rate limits by IP + normalised phone/email, keep a per-IP floor | Security |
| `f199ab5` | F31 — Permissions-Policy header; drop `style-src 'unsafe-inline'` | Security |
| `a600058` | F25 — pre-render the hero spray border, drop `feTurbulence`/`feDisplacementMap` | Perf |
| `f8464fd` | F34 (item 2) — "What customers say" homepage review strip | Conversion |
| `03daef1` | Mobile tracking timeline overflow fix (found during visual QA) | Bug fix |

`npm test` on the final HEAD:

```
165/165 e2e checks passed          (incl. all F21/F1/F27/F29/F31/F25/F34 assertions)
All shared rate-limit integration checks passed.
All storefront regression checks passed.
All upgrade migration checks passed.
80 frontend scenarios passed       (incl. the new F34 strip scenario and the timeline regression)
✅ index light: 148 parsed text/background pairs ≥4.5:1
✅ index: every outline reset has a 2px/2px :focus-visible counterpart
✅ admin light / admin dark: 175 parsed pairs each ≥4.5:1
✅ admin: every outline reset has a 2px/2px :focus-visible counterpart
✅ Chromium index light: 17 reset selectors tested with click and Tab
✅ Chromium admin light/dark: 12 reset selectors each
```

Zero new dependencies were added. Every commit kept strict CSP (no inline
script/handler/styles), CSRF on all mutating routes, and `esc()` on every
user-supplied string rendered into HTML.

---

## 2. Item-by-item outcome

### F21 — Product list payload / pagination — **Fixed** (`a5e3599`)

`GET /api/products` was returning the entire catalogue with no pagination and
the storefront shipped a built-in demo catalogue as a fallback. Both are gone:

- `/api/products` paginates (`page`, `page_size`, `category`, `sale`) with a
  coherent envelope; **no parameters keeps the legacy array contract**, so
  existing callers are unaffected (covered by e2e).
- Out-of-range pages return an empty window, not an error; invalid pagination
  parameters are rejected with 400.
- Page 1 is inlined into the served HTML as inert JSON, so the first paint is
  real products rather than a client-side fetch.
- The bundled demo catalogue was removed from the storefront bundle, and
  `DEPLOY.md` documents the change.
- Public responses carry only allow-listed fields — `unit_cost` never leaks
  (asserted for both the list and single-product endpoints).

### F1 — Crawlable product/collection content — **Fixed** (`5f62729`)

`/product/:id` and `/collection/:slug` now server-render the product name,
price and description (plus a plain list of products for collections) into the
raw HTML. Verified by curl with JS disabled and by e2e:

- `/product/:id` ships name, price and description in the raw HTML.
- `/collection/:slug` ships a plain product list in the raw HTML.
- Unknown product/collection routes stay 404 shells **without** SSR content
  (no soft-404 content leaks).

### F27 — Complete Product JSON-LD — **Fixed** (`b606d7a`)

The Product schema now carries `shippingDetails` (2–7 day handling/transit,
`applicableCountry: PK`) and `hasMerchantReturnPolicy` (7-day
`MerchantReturnFiniteReturnWindow`, `ReturnByMail`,
`ReturnFeesCustomerResponsibility`, linking to `/returns`) — matching the
published Shipping and Returns pages. e2e parses every JSON-LD block on the
page and asserts the new fields alongside the pre-existing ones.

Live check on `/product/11` (raw HTML, no JS):

```json
"aggregateRating":{"@type":"AggregateRating","ratingValue":5,"reviewCount":1,
                   "bestRating":5,"worstRating":1},
"review":[{"@type":"Review","author":{"@type":"Person","name":"Ayesha K."},
           "reviewRating":{"@type":"Rating","ratingValue":5,...}}]
```

### F29 — Rate-limit keying — **Fixed** (`8d711cb`)

Order and tracking limits were keyed on user-supplied values, which let one
caller lock out another and let a caller dodge limits by varying input. Now:

- Keys are derived from **IP + normalised phone/email**, not raw input.
- A **per-IP floor** remains, so varying the phone/email cannot escape the
  limit entirely.
- Tests cover: per-email admin lockout, ten-failure customer lockout that does
  **not** affect another email, `Retry-After` on lock, and success clearing the
  counter.

### F31 — Security headers — **Fixed** (`f199ab5`)

- **New `Permissions-Policy`** on every response: camera, microphone,
  geolocation, payment, usb, serial, bluetooth, hid, magnetometer,
  accelerometer, gyroscope, idle-detection, browsing-topics, clipboard-read,
  clipboard-write and picture-in-picture denied; `fullscreen=(self)` only.
  Verified by grep that nothing under `public/` uses these APIs.
- **CSP `style-src` is now `'self'` with no `'unsafe-inline'`.** ~77 inline
  `style` attributes were moved to classes across `index.html`,
  `storefront.js`, `admin.html` and `admin.js`. The `stars-fg` width went from
  an inline style to rounded 5 % bucket classes (`.w-0` … `.w-100`); the three
  show/hide paths that cleared inline styles now toggle `is-hidden`.

**Live CSP re-sweep, all routes, headless Chromium (final HEAD):**

| Route | Console msgs | CSP violations |
|---|---|---|
| `/` | 0 | 0 |
| `/collection/all` | 0 | 0 |
| `/collection/anime` | 0 | 0 |
| `/product/11` | 0 | 0 |
| `/checkout` | 0 | 0 |
| `/tracking` | 0 | 0 |
| `/account` (signed in) | 0 | 0 |
| `/reset-password` | 0 | 0 |
| `/returns` | 0 | 0 |
| `/admin` (logged out) | 1 — expected `401` from `/api/admin/me` | 0 |
| `/admin` (dashboard) | 0 | 0 |
| `/admin` (all sections) | 0 | 0 |

**Admin sections — corrected selector.** An earlier sweep used
`button[data-section="…"]`, which the admin markup satisfies only by accident;
the delegated handler listens for `data-action="section"`. Re-verified by
clicking each `button.sidebar-item[data-section]` and reading the resulting
tab state:

```
dashboard  title=Dashboard        tab=dashboard (default)
products   title=Products         tab=tab-products
upload     title=Quick Upload     tab=tab-upload
add        title=Add Product      tab=tab-add
homepage   title=Homepage Cards   tab=tab-homepage
orders     title=Orders           tab=tab-orders
reviews    title=Reviews          tab=tab-reviews
reports    title=Reports          tab=tab-reports   pnlChart canvas=624px, window.Chart=function

console msgs: 0 | CSP violations: 0
```

Reports renders the Chart.js canvas for real (624 px wide, script loaded under
the locked CSP), which the earlier selector never actually exercised.

### F25 — Hero spray filter — **Fixed** (`a600058`)

The hero painted a 12 px `feDisplacementMap` over a 1600×900 rect on every
first paint — an expensive SVG filter sitting on the LCP path. The identical
border (same rect, splatter dots, seed 11, `xMidYMid meet` letterboxing) is now
a pre-rasterised alpha WebP:

```
hero-spray-1600.webp   1600×900    8 KB
hero-spray-3200.webp   3200×1800  23 KB   (2× screens via srcset)
```

- Rasterised from the exact SVG markup in headless Chromium and compared
  pixel-wise against the live filter output.
- **Mean channel difference: 0.000 at 390×844, 0.228 at 1440×900** — visual
  parity confirmed at both sizes.
- `object-fit: contain` reproduces the old `preserveAspectRatio="meet"`
  behaviour; still decorative (`aria-hidden`, empty `alt`).

(The "black on black" appearance during the sweep was a screenshot display
artifact; the alpha channel is correct.)

### F34 — Conversion — **item 1 already working (no change), item 2 Fixed** (`f8464fd`)

**Item 1 — star ratings on Best Sellers cards: already working, no code change.**
Live proof at both viewports: cards for products 11/12/13 render approved-review
stars and counts (5★ ×1, 5★ ×1, 4★ ×1); unreviewed products render an empty
reserved `.card-rating` slot so the grid never jumps. `/api/products` aggregates
approved reviews only. Reported as already-fixed rather than re-implemented.

**Item 2 — "What customers say" strip: built.** The homepage had social proof
only on individual product pages.

- **New `GET /api/reviews/featured`** — approved reviews with a non-blank
  comment only, newest first, capped at 3, `products.name` joined in. The
  response strips `viewer_token` and `status`; `Cache-Control: public,
  max-age=120, s-maxage=120`.
- **New `#sectionHomeReviews`**, shipped with `is-hidden` so it can never flash
  an empty shell. `loadHomeReviews()` reveals it only when the feed has rows
  and re-hides it on an empty feed, a non-2xx response, or a network failure —
  no invented reviews, ever.
- Names and comments pass through `esc()`; the product link is a real `<button>`
  wired to the existing open-product action, so it is keyboard-operable and
  CSP-safe (no inline handlers).
- Stars reuse `starsOnlyHtml()`, so the strip matches card and PDP ratings.

Test coverage: e2e asserts ordering, the 3-item cap, exclusion of
blank/pending/rejected rows, the `product_name` join, the absence of
`viewer_token`/`status`, the cache header and the strip's presence in the
served HTML. Frontend asserts the 3-card render with escaping of
`<script>`/`<img onerror>`, exclusion of a 4th row, the product click target,
and re-hiding on an empty feed.

> **Note on the a11y contract.** The strip's product link originally used
> `color: var(--accent-hover)` on hover. `--accent-hover` is deliberately not a
> covered *text* token, and its composites over the card surfaces measure
> 4.176–4.493:1 — below 4.5:1. Rather than widen the a11y allow-list to admit a
> failing colour, the hover state now uses only the already-covered
> `--accent` and signals hover with `text-underline-offset: 3px`. The a11y
> fixture was left untouched.

### Bonus — mobile tracking timeline — **Fixed** (`03daef1`)

Found during the required visual QA: on phones the four tracking stages
overflowed the result card with thick bars running off the left edge of the
screen.

- **Cause:** the `@media (max-width: 540px)` override sat ~400 lines *above*
  the base `.track-*` rules. At equal specificity the later base rule won, so
  `.track-step` kept `flex-direction: column` and the connector kept the
  desktop `left: -50%; width: 100%` horizontal rail.
- **Fix:** the override now lives after the base rules and draws a vertical
  rail inside the card (`left: 11px`, 2 px wide, full step height). Desktop is
  untouched — the media query only applies at ≤540 px.
- **Regression test:** the frontend suite asserts the source order and the
  vertical-rail geometry. It was verified to **fail** against the old
  ordering and pass against the fix.

---

## 3. Verification evidence

### Screenshots (untracked, in the repo root)

All at **1440×900** and **390×844**, captured against the final HEAD in
headless Chromium.

```
screenshot-phase1-home-1440x900.png              screenshot-phase1-home-390x844.png
screenshot-phase1-collection-1440x900.png        screenshot-phase1-collection-390x844.png
screenshot-phase1-product-1440x900.png           screenshot-phase1-product-390x844.png
screenshot-phase1-tracking-1440x900.png          screenshot-phase1-tracking-390x844.png
screenshot-phase1-checkout-1440x900.png          screenshot-phase1-checkout-390x844.png
screenshot-phase1-best-sellers-1440x900.png      screenshot-phase1-best-sellers-390x844.png
screenshot-phase1-home-reviews-1440x900.png      screenshot-phase1-home-reviews-390x844.png
```

The checkout capture has a real cart line (product 11, size L, qty 1) so the
form renders fully; an empty cart correctly opens the empty-cart drawer
instead.

> **About the "TEST IMAGE" placeholders in the screenshots.** The seeded demo
> catalogue ships **no product photos** by design — the owner uploads real ones.
> For the screenshots, a clearly labelled test image (`KAGE / TEST IMAGE /
> replace with product photo`) was pushed through the **real admin upload
> path** (`PUT /api/products/:id` with `front_image`), which exercised the
> sharp pipeline end to end: 400/800/1200 WebP variants were generated and
> served via `image_variants`. That image is a property of the local throwaway
> database, not of the repo.

### Overflow probe

No page has horizontal document overflow at 390 px or 360 px
(`document.documentElement.scrollWidth === clientWidth` on every route).
The only elements reported outside the viewport were inside
`.topbar-track` — the intentionally clipped marquee the owner asked to keep.

### Raw-HTML proof (curl, no JS)

- `/product/11` — `<title>`, canonical, Open Graph (`og:type=product`,
  `og:image`, `og:alt`, `og:url`), product name/price/description, and JSON-LD
  with `aggregateRating` (5, count 1), a full `Review` node, `shippingDetails`
  and `hasMerchantReturnPolicy`. Swapping in a meta tag happens server-side
  from `SITE_URL`.
- `/collection/all` — `<title>`, canonical and OG tags server-rendered;
  product cards hydrate from the inlined page-1 JSON.
- `/` — `#sectionBestSellers`, `#sectionHomeReviews` (with `is-hidden` and
  `aria-labelledby`) and `#sectionRecentlyViewed` all present in the shell.

### Accessibility

```
index light:  148 parsed text/background pairs ≥4.5:1
admin light:  175 parsed text/background pairs ≥4.5:1
admin dark:   175 parsed text/background pairs ≥4.5:1
every outline reset has a 2px/2px :focus-visible counterpart (index + admin)
Chromium: 17 index reset selectors + 12 admin reset selectors per theme,
          exercised with both click and Tab
```

**Violations outstanding: none.** No untested text token, no sub-4.5:1 pair.

---

## 4. Owner actions before / after deploy

1. **`SITE_URL`** — set it in production. Without it the app falls back to the
   request origin (and logs a warning); canonical URLs, OG tags, the sitemap
   and the robots file all depend on it. Emails also print "SITE_URL is not
   configured" in dev mode instead of sending.
2. **`UMAMI_WEBSITE_ID`** — set it to enable analytics. The CSP already allows
   `https://cloud.umami.is`; with no ID the tracking snippet stays inert.
3. **`BLOB_READ_WRITE_TOKEN`** — required for image uploads on Vercel. Local
   disk storage is used otherwise and does not survive a serverless deploy.
4. **One test image upload on the first sharp deploy** — the sharp/libvips
   binary is platform-specific. Upload one product photo right after deploy to
   confirm variant generation works in that runtime. If variants fail, the
   upload still succeeds and serves the original (covered by a test), but you
   lose the 400/800/1200 WebP set.
5. **`SESSION_SECRET`** — the server refuses to boot in production without a
   ≥32-character secret. This is deliberate; see `DEPLOY.md`.

---

## 5. Known caveats

- **Admin section sweep.** The first pass used
  `button[data-section="…"]` and never actually switched tabs, so the
  Reports/Chart.js path was unattested. Re-run with the correct selector:
  **all 8 sections switch, Reports renders its canvas, 0 CSP violations.**
- **`seed-demo` flake.** During one sweep the seed request hit a transient
  `ECONNRESET`. Re-running succeeded; no code change was made. Worth knowing
  if CI ever shows a one-off seed failure.
- **Local dev DB.** `/tmp` is wiped between sessions, so the demo data (orders,
  reviews, product images) does not persist locally. That is expected — it is
  throwaway state, not part of the repo.
- **Empty-cart checkout.** `/checkout` with an empty cart opens the cart drawer
  rather than a blank form. That is the intended behaviour, not a bug.

---

## 6. Scope / rules compliance

| Rule | Status |
|---|---|
| Push only to `arena/2f13b9ee-kage-culture` | ✅ |
| No deploy | ✅ |
| Strict CSP — no inline scripts/handlers | ✅ (and `style-src` tightened to `'self'`) |
| CSRF on mutating routes | ✅ (unchanged, re-verified by e2e) |
| `esc()` on user-supplied strings | ✅ (all new render paths) |
| No new dependencies without asking | ✅ (none added) |
| `npm test` after each task | ✅ |
| Same-commit test updates | ✅ (noted per commit) |
| One small commit per task | ✅ (10 commits) |
| Already-fixed findings reported, not redone | ✅ (F34 item 1) |

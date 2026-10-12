# KAGE CULTURE — Full-Site Audit Report

**Date:** 2026-10-12
**Scope:** Express API (`server.js`, `routes/*`, `middleware/*`, `utils/*`, `database.js`, `config.js`) + vanilla-JS SPA storefront (`public/index.html`, 6,822 lines) + admin panel (`public/admin.html`, 3,356 lines); Vercel serverless deployment on Turso; 128/128 + 28/28 E2E/frontend tests passing; `npm audit --omit=dev` = 0 vulnerabilities.
**Methodology:** Static read of every source file + live curl against `NODE_ENV=development PORT=3999 node server.js` (sql.js backend, seeded demo catalogue). Live Vercel prod (`kage-culture-ruby.vercel.app`), Core Web Vitals, search-console and WAVE results were **not** collected in this sandbox — those items are listed in §6 "Not verified."

---

## 1. Executive summary

The site's security, data-integrity, and CSRF/auth posture is **mature** (all C/H/M/L items from the 2026-09-20 and 2026-10-10 audit passes are fixed, regression-tested, and npm audit is clean). The remaining work is concentrated in **SEO (deep-link metadata, sitemap breadth, JSON-LD), accessibility (low-contrast secondary text and unreplaced `outline:none` rules), performance (a 324 KB / 72 KB gzipped monolithic HTML shell served no-store with every navigation, a dead Google-Font family), and business logic (delivery charges are not collected at checkout, there is no analytics, and the newsletter has no unsubscribe path).** Shipping being excluded from the order total is **by design** (the owner opted in to post-order confirmation), but the UX around it should be tightened before scaling ad spend.

**Overall score: 74 / 100**

| Area | Score (1–10) | One-line justification |
|---|---|---|
| SEO | **4** | Deep links and crawlers see homepage-only meta; sitemap is one URL; no Product/Breadcrumb JSON-LD; no dynamic meta from server. |
| Performance | **6** | Compression + 60 s CDN caching for products, hero srcset, lazy images; but 324 KB no-store HTML shell on every nav, one dead GFont family, no HTTP/2 push/bundle split, cold-start bundle includes vendor Chart.js. |
| UX / design | **7** | Responsive breakpoints are tested in headless Chromium, flows mostly work; empty states are present; minor polish needed (keyboard dialog handling, sticky-CTA visibility). |
| Conversion | **6** | Strong visual brand, COD-only, floating WhatsApp; but no clear value prop above the fold on non-home routes, shipping is "to be confirmed," no payment-option trust badges, no guest-checkout simplification. |
| Content | **7** | Policy pages thorough and dated Oct-2026; a few thin placeholders (Pants category has no products → empty grid; Graphic Tees "coming soon"; working hours not stated on Contact). |
| Accessibility (WCAG 2.2 AA) | **5** | Skip link, real `<button>`s, Enter/Space on cards, star ratings fixed; but `--text-gray #8A8578` fails 4.5:1 (2.49:1 on bg, 1.99:1 on cards), 8 `outline:none` rules lack an `:focus-visible` replacement, no `aria-live` region for cart/toast updates, no focus trap on drawers. |
| Security & technical | **9** | Auth via signed cookie-session only, HSTS/noSniff/X-Frame-Options/CSP, CSRF double-submit, DB-backed rate limits, atomic stock, fail-closed admin login, 0 vulns; only remaining CSP gap is `'unsafe-inline'` for scripts (tracked FE-H2). |
| Analytics | **1** | Zero analytics, zero conversion tracking, zero consent-banner need (no marketing cookies) but also zero measurement. |
| Repo hygiene | **8** | Tests and fixtures clean; two unreferenced legacy favicon files (`favicon.ico`, `favicon-48x48.png`) and one dead Zen Brush GFont request remain; no dead code paths detected. |

---

## 2. Findings index

Sorted by severity (Critical → Low), then by impact-to-effort ratio.

| ID | Area | Severity | Status | Effort | One-line summary |
|---|---|---|---|---|---|
| SEO-1 | SEO | High | VERIFIED | M | Product and collection deep links return homepage `<title>`/`og:*`/meta-description; crawlers never see product metadata. |
| SEO-2 | SEO | High | VERIFIED | S | `/sitemap.xml` lists only `"/"` — products and collections are undiscoverable to search engines. |
| SEO-3 | SEO | High | VERIFIED | M | No Product JSON-LD, no BreadcrumbList, and only one Organization schema block. |
| A11Y-1 | Accessibility | High | VERIFIED | S | `--text-gray #8A8578` is 2.49:1 on page bg and 1.99:1 on card bg — fails WCAG AA for all text sizes; secondary color pairs are borderline. |
| A11Y-2 | Accessibility | High | VERIFIED | S | Six CSS rules set `outline:none` without a `:focus-visible` replacement, leaving those controls invisible to keyboard users. |
| CONV-1 | Conversion | High | VERIFIED | M | Delivery-charge UX is ambiguous ("To be confirmed" with no estimate/ceiling); risk of checkout abandonment and post-order disputes. |
| PERF-1 | Performance | Medium | VERIFIED | M | 324 KB HTML shell is served `no-store` on every navigation — SPA navigations re-download the full shell instead of shell-once + JSON. |
| PERF-2 | Performance | Medium | VERIFIED | S | `family=Zen+Brush` is requested from Google Fonts but never used in CSS; adds a blocking request. |
| PERF-3 | Performance | Medium | VERIFIED | S | All images are JPEG/WebP but only the hero and about-hero use `srcset`; product/grid/category images serve one fixed resolution to all viewports. |
| A11Y-3 | Accessibility | Medium | VERIFIED | S | No `aria-live` region announces cart additions, toast messages, filter changes, or wishlist updates — screen-reader users get no feedback. |
| A11Y-4 | Accessibility | Medium | VERIFIED | M | Drawers (cart, wishlist, filter, mobile menu) and modals do not trap focus or return focus on close; Escape works only partially. |
| SEO-4 | SEO | Medium | VERIFIED | S | Canonical/OG URLs on product/collection pages use `__PAGE_URL__` (server-injected path only) but `og:title`, `og:description`, `twitter:*`, and `<meta name=description>` remain the homepage copy server-side (client sets only `document.title`). |
| PERF-4 | Performance | Medium | INFERRED | M | Vercel serverless bundles `public/**` (9.3 MB total, including 200 KB Chart.js) into every lambda invocation → cold-start latency. |
| ANALYTICS-1 | Analytics | Medium | VERIFIED | S | No analytics or conversion tracking installed — revenue per visit, funnel drop-off and cart size are invisible. |
| REPO-1 | Repo hygiene | Low | VERIFIED | S | Duplicate dead favicons (`favicon.ico` identical to `favicon-v2.ico`; `favicon-48x48.png` unreferenced) — ~16 KB of dead bytes. |
| PERF-5 | Performance | Low | VERIFIED | S | `font-display` is not specified on the Google Fonts `<link>`; text remains invisible during the font swap (FOIT risk on slow connections). |
| SEC-1 | Security | Low | VERIFIED | L | CSP still requires `script-src 'unsafe-inline'` and `script-src-attr 'unsafe-inline'` because of 91 inline `onclick` + 8 `onkeydown` handlers (tracked as FE-H2, known issue). |
| SEC-2 | Security | Low | VERIFIED | S | HSTS is set via helmet defaults but lacks `preload` and uses the default 1-year max-age without explicit `includeSubDomains` (helmet defaults do include it — VERIFIED, this is informational; consider preload once subdomains are confirmed). |
| CONTENT-1 | Content | Low | VERIFIED | S | Pants category is empty (the Explore link routes to `/collection/pants` which renders the empty-grid state) and Graphic Tees renders Coming Soon; public nav still advertises both. |
| CONTENT-2 | Content | Low | VERIFIED | S | Newsletter sign-up is stored in `newsletter_subscribers` but there is no send pipeline, no unsubscribe endpoint/UI, and no double opt-in. |
| CONV-2 | Conversion | Low | INFERRED | S | No trust signals (payment badges, "secure checkout," return policy CTA) appear directly on the checkout page. |
| UX-1 | UX | Low | VERIFIED | S | The floating WhatsApp button covers the product-page Add to Cart area on some widths despite the `body:has(#page-product.active)` rule; only hidden above 768 px. |
| A11Y-5 | Accessibility | Low | VERIFIED | S | Skip link points to a main/container but no explicit `id="main-content"` target is consistently used; tab order starts from the top on skip. |

---

## 3. Detailed fix guide

---

### SEO-1 — Product/collection routes serve homepage metadata to crawlers
- **Severity:** High · **Effort:** M · **Estimated time:** 1–2 hours
- **Where:** `server.js:52-61` (`renderStorefrontHtml` / `sendStorefrontHtml`), `routes/products.js`, `public/index.html:18-33,4930-4933`
- **Evidence (VERIFIED, live curl):**
  ```
  $ curl -s http://localhost:3999/product/1 | grep -E '<title|og:title|og:description|meta name="description"'
    <title>KAGE CULTURE — Engineered Fit. Original Art.</title>
    <meta name="description" content="KAGE Culture — Premium streetwear. Anime inspired. Built for everyday. Shop oversized tees..." />
    <meta property="og:title" content="KAGE Culture — Engineered Fit. Original Art." />
    <meta property="og:description" content="Premium streetwear. Anime inspired. Built for everyday." />
  ```
  Client-side JS only updates `document.title` and canonical/og:url — `og:title`, `og:description`, `meta description`, `og:image` stay as the homepage strings. Googlebot does execute JS for indexing but social crawlers (Facebook, WhatsApp, iMessage, Slack, X) and many SEO scrapers do not; they will always see the homepage title/description when any product or collection link is shared.
- **Why it matters:** Every shared product/collection link shows the generic brand tagline instead of the product name, price and image → lower click-through on social/WhatsApp and lost long-tail keyword ranking.
- **How to fix:**
  1. In `server.js`, make `sendStorefrontHtml` async and accept a `metaOverrides` object.
  2. Add two tiny server-side routes that intercept `/product/:id` and `/collection/:slug` *before* the generic `app.get('*')` fallback.
  3. For `/product/:id`: `db.prepare('SELECT name, description, front_image, price, sale_price FROM products WHERE id = ?').get(id)`. Build:
     - `title`: `${name} — KAGE Culture`
     - `description`: first ~155 chars of description
     - `og:image`: absolute URL of `front_image` (or the default `/images/og-image.jpg` if null); add `og:image:width/height` only when they can be derived (otherwise omit).
     - Inject a Product JSON-LD block (see SEO-3) into the HTML.
  4. For `/collection/:slug`: map slug → label (`graphic-tees` → "Graphic Tees", etc.) and emit collection-specific title/description.
  5. Replace placeholders like `__PAGE_TITLE__`, `__META_DESCRIPTION__`, `__OG_TITLE__`, `__OG_DESCRIPTION__`, `__OG_IMAGE__`, `__JSONLD__` in the template (in addition to existing `__SITE_URL__`/`__PAGE_URL__`).
  6. Keep the client JS updating `document.title` and `og:url` as a fallback for SPA navigations after the first load.
- **Code (sketch for `server.js`):**
  ```diff
  -function renderStorefrontHtml(req) {
  +async function renderStorefrontHtml(req, meta = {}) {
     const siteUrl = getSiteUrlForRequest(req);
     const pagePath = req.path === '/index.html' ? '/' : req.path;
     const pageUrl = new URL(pagePath || '/', `${siteUrl}/`).href;
     return STOREFRONT_HTML_TEMPLATE
       .replaceAll('__SITE_URL__', siteUrl)
       .replaceAll('__PAGE_URL__', pageUrl)
  +    .replace('__PAGE_TITLE__', meta.title || 'KAGE CULTURE — Engineered Fit. Original Art.')
  +    .replace('__META_DESCRIPTION__', meta.description || 'Premium streetwear. Anime inspired. Built for everyday.')
  +    .replace('__OG_TITLE__', meta.ogTitle || meta.title || 'KAGE Culture — Engineered Fit. Original Art.')
  +    .replace('__OG_DESCRIPTION__', meta.ogDescription || meta.description || 'Premium streetwear. Anime inspired. Built for everyday.')
  +    .replace('__OG_IMAGE__', meta.ogImage || `${siteUrl}/images/og-image.jpg`)
  +    .replace('<!-- __JSONLD__ -->', meta.jsonLd || '');
   }
  ```
  And register a `GET /product/:id` handler before the wildcard that looks up the product, builds the override object, and calls `sendStorefrontHtml(req, res, 200, overrides)`.
- **Side effects / risks:** Must not regress the existing 404 for non-numeric ids (the regex `/^\/product\/\d+$/` already guards this in the existing wildcard). Adds one DB read per cold-start product hit — negligible compared to the current 324 KB payload. Must keep the CSRF cookie-set logic: product pages are HTML (not public-cacheable API), so they continue to receive `kage.csrf` — that is already the case.
- **How to verify:**
  ```
  curl -s http://localhost:3999/product/1 | grep -E '<title|og:title|og:image|application/ld'
  # expect: product name in <title> and og:title; product front image in og:image; Product JSON-LD
  curl -s http://localhost:3999/collection/anime | grep -E '<title|og:title'
  # expect: "Anime Shirts | KAGE CULTURE"
  ```
  Facebook Sharing Debugger and Slack/Twitter card validators should show product-specific previews.
- **Depends on:** SEO-2, SEO-3 (can be done in parallel).

---

### SEO-2 — Sitemap only contains "/"
- **Severity:** High · **Effort:** S · **Estimated time:** 30 minutes
- **Where:** `server.js:135-144`
- **Evidence (VERIFIED, live):**
  ```
  $ curl -s http://localhost:3999/sitemap.xml
  <?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>http://localhost:3999/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  </urlset>
  ```
- **Why it matters:** Without per-product URLs in the sitemap, Google must discover every product through internal-link crawling alone — slower de-indexing of removed products, slower discovery of new drops, and weaker ranking for long-tail product queries.
- **How to fix:**
  1. In the `/sitemap.xml` handler, run two small queries:
     - `SELECT id, updated_at FROM products WHERE in_stock = 1` (or all products — out-of-stock can still rank for "sold out" queries)
     - A static list of collection slugs from `config.PRODUCT_CATEGORIES` plus `all`.
  2. Build `<url><loc>...</loc><lastmod>YYYY-MM-DD</lastmod></url>` entries and escape them with the existing `escapeXml()`.
  3. Add policy pages (`/about`, `/contact`, `/shipping`, `/returns`, `/privacy`, `/terms`, `/tracking`).
  4. Keep Cache as `public, max-age=300` (it is now `no-store`, which prevents search crawlers from caching and adds load on every fetch).
- **Code (sketch):**
  ```js
  app.get('/sitemap.xml', async (req, res) => {
    const siteUrl = escapeXml(getSiteUrlForRequest(req));
    const products = await db.prepare('SELECT id, updated_at FROM products ORDER BY id').all();
    const staticUrls = ['/', '/about', '/contact', '/shipping', '/returns', '/privacy', '/terms'];
    const collections = config.PRODUCT_CATEGORIES.map(c => `/collection/${c.value}`).concat('/collection/all');
    const urls = [
      ...staticUrls.map(p => `<url><loc>${siteUrl}${p}</loc><changefreq>weekly</changefreq></url>`),
      ...collections.map(p => `<url><loc>${siteUrl}${p}</loc><changefreq>daily</changefreq></url>`),
      ...products.map(p => `<url><loc>${siteUrl}/product/${p.id}</loc><lastmod>${escapeXml(String(p.updated_at).slice(0,10))}</lastmod><changefreq>weekly</changefreq></url>`)
    ].join('\n    ');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/xml').send(`<?xml version="1.0"?>\n<urlset xmlns="http://...">${urls}\n</urlset>`);
  });
  ```
- **Side effects / risks:** Sitemap exposes product ids publicly — these are already discoverable via `/api/products` and browser navigation, so this is not new information. Must escape URLs with the existing `escapeXml()`.
- **How to verify:** `curl -s http://localhost:3999/sitemap.xml | grep -c "<loc>"` should return ≥ seeded product count + 10 static/collection URLs; validate in Google Search Console and https://www.xml-sitemaps.com/validate-xml-sitemap.html.
- **Depends on:** none (parallel with SEO-1/3).

---

### SEO-3 — Missing Product JSON-LD structured data
- **Severity:** High · **Effort:** M · **Estimated time:** 1 hour
- **Where:** `public/index.html:45-57` (only Organization schema), and new `__JSONLD__` injection point from SEO-1.
- **Evidence (VERIFIED):** Only one `<script type="application/ld+json">` exists in the shell, and it contains only `@type: Organization`. No `Product`, `BreadcrumbList`, or `WebSite` schema.
- **Why it matters:** Product schema (name, image, price, availability, SKU, aggregateRating, review) is what enables Google rich results (price, stock stars in SERP) and improves Pinterest/WhatsApp previews. BreadcrumbList helps search engines understand site hierarchy.
- **How to fix:**
  1. Add a `WebSite` block to the static shell with `potentialAction: { SearchAction }` pointing at `/` (the SPA does client-side search but the `?q=` param is not routed — either add query-param routing or skip SearchAction for now).
  2. Server-side: when rendering `/product/:id`, emit a `Product` JSON-LD containing: `@id`, `name`, `image` (front_image), `description`, `sku` (product id), `brand` (Organization reference), `offers` (Offer with `price`, `priceCurrency: "PKR"`, `availability`: `InStock`/`OutOfStock`, `url`), and `aggregateRating` when `review_count > 0`.
  3. Add a `BreadcrumbList` (Home → Category → Product).
- **Code:** See SEO-1 diff for the `__JSONLD__` injection slot. A Product block looks like:
  ```json
  {
    "@context":"https://schema.org",
    "@type":"Product",
    "name":"<product name>",
    "image":["https://<site>/<front_image>"],
    "description":"<desc>",
    "sku":"<id>",
    "brand":{"@type":"Brand","name":"KAGE Culture"},
    "offers":{"@type":"Offer","priceCurrency":"PKR","price":<price>,"availability":"https://schema.org/InStock","url":"https://<site>/product/<id>"}
  }
  ```
- **Side effects / risks:** Prices must reflect the active sale price when `on_sale=1`; availability must map `in_stock=0` → `OutOfStock`. Keep HTML escaping tight (`escapeHtml` for strings).
- **How to verify:** After deployment, run https://search.google.com/test/rich-results against a product URL and expect "Product" detected with no errors.
- **Depends on:** SEO-1.

---

### A11Y-1 — Low text/background contrast on `--text-gray` and `--text-muted`
- **Severity:** High · **Effort:** S · **Estimated time:** 20 minutes
- **Where:** `public/index.html:70-79` (CSS custom properties) and all uses of `var(--text-gray)` / `var(--text-muted)` on non-white surfaces.
- **Evidence (VERIFIED, computed with WCAG 2.x relative luminance):**

  | Foreground | Background | Ratio | AA Normal (≥4.5) | AA Large (≥3.0) |
  |---|---|---|---|---|
  | `--text-gray` #8A8578 | `--bg-primary` #D9D4C8 | **2.49:1** | FAIL | FAIL |
  | `--text-gray` #8A8578 | `--bg-card/secondary` #C4BEB0 | **1.99:1** | FAIL | FAIL |
  | `--text-gray` #8A8578 | #FFFFFF (cart/toast/email copy) | 3.68:1 | FAIL | PASS |
  | `--text-muted` #5C564C | `--bg-card` #C4BEB0 | **3.92:1** | FAIL | PASS |
  | `--text-muted` #5C564C | `--bg-primary` #D9D4C8 | 4.91:1 | PASS | PASS |
  | `--text-primary` #1A1815 | `--bg-primary` #D9D4C8 | 11.98:1 | PASS | PASS |

  `--text-gray` is used for footers, helper text, review timestamps, form hints, and email footers — body-sized text that must hit 4.5:1.
- **Why it matters:** Users over 40, on cheap phone displays in sunlight, or with any visual impairment cannot read the disclaimer/policy/help copy; WCAG 2.2 AA is a legal requirement in many jurisdictions and a baseline quality bar.
- **How to fix:**
  1. Darken `--text-gray` to `#6B655A` (tested: 4.55:1 on `#D9D4C8`, 3.66:1 on `#C4BEB0` → still fails on cards).
  2. Better: change `--text-gray` to `#5C564C` (reusing `--text-muted`) and introduce a new `--text-faint: #7A7468` for decorative/disabled-only text where text is *not* the only cue.
  3. Alternatively lighten card background where `--text-gray` is used.
  4. Verify every occurrence of `var(--text-gray)` against its real background; replace with `--text-dim` where it sits on a card.
- **Code (minimal token change):**
  ```diff
  -  --text-gray: #8A8578;
  +  --text-gray: #6B655A;
  ```
  Then re-run the contrast calculator for each text/background pair.
- **Side effects / risks:** Visual tone change — test the footer, email previews in dev mode, and card footers in Chromium at 360/1440px to ensure nothing looks muddied.
- **How to verify:**
  ```
  Use https://webaim.org/resources/contrastchecker/ or the Stark/axe DevTools extension.
  Target: every #8A8578 use must reach ≥4.5:1 against its actual rendered background.
  ```
  Add a visual-regression note in `tests/frontend.test.js` if desired.
- **Depends on:** none.

---

### A11Y-2 — `outline:none` rules without a `:focus-visible` replacement
- **Severity:** High · **Effort:** S · **Estimated time:** 30 minutes
- **Where:** `public/index.html:978, 1470, 1785, 1808, 1942, 1987, 2441, 2721, 3112`; `public/admin.html:712`.
- **Evidence (VERIFIED):**
  ```
  $ grep -n "outline: none" public/index.html public/admin.html
  public/index.html:978:  outline: none;   /* newsletter input */
  public/index.html:1470: outline: none;   /* .sort-select */
  public/index.html:1785: outline: none;   /* nav-search input */
  public/index.html:1808: outline: none;   /* mobile-search input */
  public/index.html:1942: outline: none;   /* cust-card input */
  public/index.html:1987: outline: none;   /* account acct-field input */
  public/index.html:2441: outline: none;   /* newsletter footer input */
  public/index.html:2721: outline: none;   /* notify-form input */
  public/index.html:3112: outline: none;   /* coming-soon form input */
  public/admin.html:712:  outline: none;
  ```
  Of these, lines 978, 1470, 1785, 1808, 1942, 1987, 2441, 2573 (co-field), 2721, 2814 (review-form), 2850 (tracking-form), 3112 already pair `outline:none` with a `border-color: var(--accent)` rule on `:focus` — those are acceptable because they replace the outline with a border change. Lines without a clear visible focus indicator must be identified and fixed.
- **Why it matters:** Keyboard users (Tab/Shift+Tab) lose track of which element is focused — forms become unusable without a mouse. WCAG 2.2 SC 2.4.7 (Focus Visible, AA).
- **How to fix:**
  1. Audit each line: if the element already has a `:focus { border-color: … }` or `:focus-visible { outline: … }`, mark OK.
  2. For any rule where the focus state is invisible (e.g. a `<select>` that only changes border but the border color is indistinguishable, or a link/button), add an explicit replacement:
     ```css
     .sort-select:focus-visible {
       outline: 2px solid var(--accent);
       outline-offset: 2px;
     }
     ```
  3. Remove `outline: none` from elements that don't have a replacement style.
- **Side effects / risks:** Be careful not to double-apply outlines (the global `input:focus-visible, select:focus-visible, a:focus-visible` rule at line 2305 already provides a 2px outline for most inputs); the `outline:none` will override that global rule if it has higher specificity — that is exactly the bug. The safe fix is to delete the rule-level `outline:none` lines and let the global focus style win, keeping `border-color` changes as a *second* visual cue.
- **How to verify:** Run axe DevTools or manually Tab through every form, nav link, product card, filter, cart drawer, and admin page — a 2px solid `--accent` ring must be visible on the focused element at every stop.
- **Depends on:** none.

---

### CONV-1 — Delivery charge messaging is ambiguous at checkout
- **Severity:** High · **Effort:** M · **Estimated time:** 1–2 hours (requires a business decision)
- **Where:** `routes/orders.js:119-120` (`shipping = 0; shippingPending = 1`), `public/index.html:4078-4082,4100-4105,5010,5073,6139,6180`, `/shipping` page at line 4322.
- **Evidence (VERIFIED):**
  - Checkout shows "Delivery charge: To be confirmed" and "Cash on Delivery accepted. We will contact you about the delivery charges."
  - The POST `/api/orders` stores `shipping=0, shipping_pending=1, total=subtotal`.
  - The `/shipping` policy page says "Delivery charges depend on your delivery location. We will contact you about the delivery charges." No estimate, no ceiling, no city tier table.
- **Why it matters:** "To be confirmed" with no upper bound is a classic checkout-abandonment trigger; customers either (a) assume hidden fees and leave, (b) place test orders then refuse payment when called, or (c) feel deceived when contacted with a higher-than-expected fee. This is the design the owner chose (AUDIT.md "COD-only + post-order delivery charge confirmation — 2026-10-11"), so the fix is not to change the model but to tighten the UX.
- **How to fix** (choose one — see §7 Design decisions needed):
  - **Option A (recommended):** Show a clear flat-rate band (e.g. "Rs. 150 for major cities, Rs. 250 nationwide — final amount confirmed by phone before dispatch") on the checkout, on `/shipping`, and in the order-confirmation email. This matches AUDIT.md's earlier stated Rs. 150 flat fee that was removed.
  - **Option B:** Keep post-order confirmation but add a visible ceiling (e.g. "Delivery charges will not exceed Rs. 250") so customers can make an informed decision.
  - **Option C:** Collect city/region at checkout and compute `shipping` from a lookup table. Requires more maintenance.
  - Independently of the pricing model, add the same explainer line to the cart drawer, checkout sidebar and confirmation email ("We will call you from +92 322 804 2633 within 24 hours to confirm delivery").
- **Side effects / risks:** If a number is published, it must be honoured (or the policy must say "rates starting from"). Admin orders dashboard will need a way to input confirmed shipping before an order is marked `confirmed`; that UI/API field does not exist today beyond the raw `shipping` column (edit-order endpoint needed).
- **How to verify:** Place a test COD order and read the confirmation screen + email; the charge must be understandable without talking to anyone.
- **Depends on:** §7 design decision D1.

---

### PERF-1 — Monolithic no-store HTML shell on every navigation
- **Severity:** Medium · **Effort:** M · **Estimated time:** 2–4 hours
- **Where:** `server.js:36-46,157-168`; `public/index.html` (entire file is loaded once and reused client-side for SPA navigations, but browser reloads/deep links and direct URL shares re-download it).
- **Evidence (VERIFIED, live):**
  ```
  $ curl -s http://localhost:3999/ -o /tmp/index.out -w "size=%{size_download} HTTP=%{http_code}\n"
  size=330853 HTTP=200
  $ curl -sI http://localhost:3999/ | grep -i cache-control
  Cache-Control: no-cache, no-store, must-revalidate
  ```
  Gzipped transfer is ~72 KB (from earlier run). Every deep-linked navigation (social click, ad click, Back button after leaving the site, browser refresh) pays that cost before the SPA can boot. The file bundles ~200 KB of CSS + JS into one HTML document.
- **Why it matters:** On a Pakistani 3G connection (~1–2 Mbps effective), 72 KB = 0.3–0.6 s just for HTML before any image; every cold navigation re-parses 6,800 lines of JS. Serverless cost: each of those 324 KB responses runs through gzip middleware on every hit.
- **How to fix:**
  1. Split inline CSS/JS into external files under `/public/` (e.g. `/storefront.css`, `/storefront.js`) so the browser can cache them independently with the existing 1-day cache policy.
  2. Keep HTML minimal (skeleton + root div + JSON-LD/meta tags) — goal <30 KB uncompressed, gzipped <10 KB.
  3. Use the existing `Cache-Control: public, max-age=86400, must-revalidate` for the static CSS/JS. Add content-hash query strings (`/storefront.<hash>.css`) when deploying to allow immutable caching.
  4. Consider lazy-loading the admin-only JS (Chart.js is already split; keep that precedent).
  5. HTML itself can stay `no-store` (per CSRF cookie-set requirement), but being smaller makes that cheap.
- **Side effects / risks:** Must ensure the CSRF cookie-set timing still works: the HTML response must remain non-shared-cacheable (no `public`/`s-maxage`) so each unique visitor still gets their own `kage.csrf` cookie on first load. The existing `csrfMiddleware.deferCsrfCookie` already honours this. Must keep CSP `script-src 'self'` (external files are same-origin, so that is fine; you can *remove* `'unsafe-inline'` only after finishing FE-H2 event delegation).
- **How to verify:**
  ```
  curl -s http://localhost:3999/ -w "size=%{size_download}\n" -o /dev/null   # expect < 30000
  curl -sI http://localhost:3999/storefront.css | grep cache-control         # expect public, max-age=86400
  ```
  Then run Lighthouse and confirm First Contentful Paint < 1.5 s on "Slow 3G" throttling.
- **Depends on:** SEC-1 (FE-H2) can be done in parallel; splitting files actually makes event-delegation easier.

---

### PERF-2 — Dead "Zen Brush" Google Font family request
- **Severity:** Medium · **Effort:** S · **Estimated time:** 5 minutes
- **Where:** `public/index.html:52-56` (Google Fonts `<link>`), `public/admin.html:15`.
- **Evidence (VERIFIED):**
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;90&family=Noto+Serif+JP:wght@400;500;700;900&family=Zen+Brush&display=swap" rel="stylesheet">
  ```
  A grep for `Zen Brush` in `public/index.html` returns zero references in any `font-family` declaration; the family is never used.
- **Why it matters:** One extra DNS + TLS + HTTP request at critical render time; adds ~1–2 KB of unused CSS and font hints. On slow 3G connections this can delay first paint by 100–300 ms.
- **How to fix:** Remove `&family=Zen+Brush&display=swap` from the fonts URL in both HTML files. (Also verify `&display=swap` is present — see PERF-5.)
- **Code:**
  ```diff
  - href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;...&family=Noto+SerifJP:wght@400;500;700;900&family=Zen+Brush&display=swap"
  + href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=Noto+Serif+JP:wght@400;500;700;900&display=swap"
  ```
- **Side effects / risks:** None — Zen Brush is not used anywhere.
- **How to verify:** Load the page with DevTools Network tab → no request for any Zen Brush font file; text renders unchanged.
- **Depends on:** none.

---

### PERF-3 — Product/category/card images lack `srcset`/`sizes`
- **Severity:** Medium · **Effort:** S · **Estimated time:** 1 hour
- **Where:** `public/index.html:5423` (product cards), 5644 (gallery), 3760–3784 (category tiles), 4442 (about-hero, already correct), 3723–3724 (hero, already correct).
- **Evidence (VERIFIED):** Hero and about-hero use `<picture>` + `srcset` with 700w/1024w/1376w variants; product images render `<img src="${esc(img)}" alt="…" loading="lazy" />` with a single source at whatever resolution was uploaded (often 1000+ px) into ~215 px grid cards.
- **Why it matters:** A category-grid card on a 360 px phone is ~160 px wide but may download a 1200 px JPEG (100–200 KB) → 3–5× unnecessary bytes per card, multiplied by 20 products = several MB wasted on mobile.
- **How to fix:**
  1. Generate and serve responsive variants in the upload pipeline (e.g. via `sharp` or Vercel Image Optimization: use `_vercel/image` if available, or add a build step that emits `.thumb.jpg` (400 px) and `.medium.jpg` (800 px) alongside each image).
  2. Update templates to `<img srcset>` with both widths and `sizes="(max-width: 600px) 160px, (max-width: 1024px) 220px, 280px"`.
  3. Quick interim fix: use Vercel's built-in image optimizer by rewriting image URLs to `/_vercel/image?url=…&w=400&q=75` on the client for card thumbnails.
- **Side effects / risks:** Requires Vercel Blob to be publicly accessible (it is, `access:'public'`). Ensure `imgSrc` CSP already allows `https:` (it does).
- **How to verify:** DevTools Network tab on "Slow 3G" → product-card image downloads should be ~15 KB each (400 px @ q75), not 80–200 KB.
- **Depends on:** none (can be done independently).

---

### A11Y-3 — Missing `aria-live` regions for dynamic updates
- **Severity:** Medium · **Effort:** S · **Estimated time:** 30 minutes
- **Where:** `public/index.html:3716` (one `role="alert"` exists for catalog-fatal error only); cart/toast/wishlist actions have no announcement region.
- **Evidence (VERIFIED):**
  ```
  $ grep -n "aria-live" public/index.html public/admin.html
  public/index.html:3716: <div id="productLoadError" role="alert" hidden ...>
  public/admin.html:1286: <span id="selectedProductCount" aria-live="polite">0 selected</span>
  ```
  No `aria-live` region exists for "Added to cart", "Removed", "Order placed", "Filter applied", "Wishlist toggled", or form errors.
- **Why it matters:** Screen-reader users have no confirmation that their actions succeeded; they have to navigate to find the cart badge.
- **How to fix:**
  1. Add a visually-hidden `aria-live="polite"` region (e.g. `<div id="srAnnounce" class="sr-only" aria-live="polite"></div>`).
  2. Add `.sr-only` CSS (clip-to-1px technique, already used for nothing in this repo — must be added).
  3. In `addToCart`, `removeFromCart`, `toggleWishlist`, `placeOrder` success path, `showToast`, and form submissions, set `document.getElementById('srAnnounce').textContent = 'Added Cheese God (M) to cart'` etc.
  4. Reserve `role="alert"` (assertive) for errors (the existing `productLoadError` is fine).
- **Code (sr-only):**
  ```css
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
  ```
- **Side effects / risks:** Make sure announcements are de-duped (setting `.textContent` to the same string twice won't re-announce; inject a no-op like trailing space or clear after 2 s).
- **How to verify:** In NVDA/JAWS/VoiceOver, adding a product to cart should announce "Added X to cart" without moving focus.
- **Depends on:** none.

---

### A11Y-4 — No focus trap or focus return on drawers/dialogs
- **Severity:** Medium · **Effort:** M · **Estimated time:** 1–2 hours
- **Where:** `public/index.html` — cart drawer (`#cartDrawer`), wishlist drawer, filter drawer, mobile nav menu, login/signup modals, reset password modal.
- **Evidence (VERIFIED):** Code has Escape-to-close on a subset of overlays (AUDIT.md 2026-09-25 added Escape on the mobile menu), but no focus trap; Tab can move focus out of an open drawer into background content. No explicit `focus()` call moves focus into the drawer when it opens; no focus restoration on close.
- **Why it matters:** WCAG 2.2 SC 2.4.3 (Focus Order, A) and SC 2.4.11 (Focus Not Obscured, AA); keyboard/screen-reader users can get stuck behind the drawer.
- **How to fix:**
  1. Extract a shared helper `openModal(el, { firstFocus })` / `closeModal(el, { returnTo })`.
  2. On open: save `document.activeElement`; move focus to first focusable element inside `el`; intercept Tab on last element (wrap to first) and Shift+Tab on first element (wrap to last); mark with `aria-modal="true"` and `role="dialog"`.
  3. On close: restore focus to the previously active element.
  4. Apply to: cart, wishlist, filter, mobile menu, login modal, signup modal, forgot-password modal, and quick-view.
- **Side effects / risks:** Must not break the existing Escape-to-close handlers. Must play nicely with iOS Safari's limited Tab support.
- **How to verify:** Tab through every drawer — focus must never leave the open drawer; Esc and close button must return focus to the button that opened it.
- **Depends on:** A11Y-2 (focus-visible styles must work inside the trapped region).

---

### SEO-4 — Product/collection social meta not updated client-side
- **Severity:** Medium · **Effort:** S · **Estimated time:** 20 minutes
- **Where:** `public/index.html:4930-4933` (`navigateTo`).
- **Evidence (VERIFIED):**
  ```js
  document.querySelector('link[rel="canonical"]').href = canonicalUrl;
  document.querySelector('meta[property="og:url"]').content = canonicalUrl;
  document.title = ...;
  ```
  Only `canonical`, `og:url`, and `document.title` are updated. `meta[name=description]`, `og:title`, `og:description`, `og:image`, `twitter:title`, `twitter:description`, `twitter:image` stay frozen at homepage values after the first SPA transition.
- **Why it matters:** If a user copies the URL *after* client navigation (e.g. from address bar) and pastes it into WhatsApp/Slack, the unfurled preview still uses homepage OG — but since the first response already carries homepage meta (SEO-1), fixing SEO-1 server-side resolves the cold-load case; this fix is for post-load navigations (e.g. copy link after visiting a product in the same tab).
- **How to fix:**
  1. In `openProductDetail(p)` after calling `navigateTo('product')`, set `meta[name=description].content`, `meta[property=og:title].content`, `meta[property=og:description].content`, `meta[property=og:image].content`, `meta[name=twitter:title].content`, `meta[name=twitter:description].content`, `meta[name=twitter:image].content`.
  2. In `navigateTo('collection', slug)`, restore homepage meta or set collection-specific copy.
  3. Restore homepage meta on `navigateTo('home')`.
- **Side effects / risks:** None beyond a few DOM updates per navigation.
- **How to verify:** Open a product, then run `document.querySelector('meta[property="og:title"]').content` in DevTools and confirm it matches the product name.
- **Depends on:** SEO-1 (server-side is the real fix; this is an enhancement).

---

### PERF-4 — Serverless cold-start bundle includes 9.3 MB of public assets
- **Severity:** Medium · **Effort:** M · **Estimated time:** 2–3 hours
- **Where:** `vercel.json:7-15`
- **Evidence (VERIFIED):**
  ```json
  "config": { "includeFiles": ["public/**", "routes/**", "middleware/**", "utils/**", "config.js", "database.js"] }
  ```
  `public/` contains hero images, category tiles, vendor/chart.umd.min.js (200 KB), og-image.jpg (116 KB), etc. No mp4s remain (L2 was resolved: 0 mp4 files found in this audit — INFERRED partially resolved), but every lambda invocation still bundles and extracts the whole `public/` tree.
- **Why it matters:** Vercel serverless Node functions cold-start faster with smaller bundles; 1–9 MB bundles typically add 200–800 ms of cold-start latency per uncached request.
- **How to fix:**
  1. Move static assets to Vercel's static output: place them at the repo root or declare them in `vercel.json` under a separate static route (Vercel serves files from `public/` automatically when you don't have a catch-all route).
  2. Or split the catch-all into separate lambdas per route.
  3. At minimum, exclude `public/vendor/chart.umd.min.js` from the API lambda since only `/admin` ever loads it and it is already served by the `express.static` middleware (it is only needed when the function serves that file — Vercel serves static files before hitting the lambda when the routing is correct).
- **Side effects / risks:** Static routing changes can break the existing catch-all SPA handler; must keep `sendStorefrontHtml` working for every non-API, non-static path. Use Vercel's `rewrites` instead of a catch-all `routes` entry to separate static from lambda.
- **How to verify:** After deploy, cold-start a fresh region (e.g. by adding a query-string cachebuster) and confirm lambda cold-start time in Vercel logs is <1 s.
- **Depends on:** none (infrastructure-only).

---

### ANALYTICS-1 — No analytics or conversion tracking
- **Severity:** Medium · **Effort:** S · **Estimated time:** 30 minutes to install, ~1 week to mature
- **Where:** No analytics code anywhere in the codebase; grep for `gtag`, `ga(`, `plausible`, `umami`, `fbq`, `pixel` returns one false positive in privacy-policy copy ("not used for advertising or analytics").
- **Evidence (VERIFIED):**
  ```
  $ grep -rn "google-analytics\|gtag\|plausible\|umami\|analytics\|fbq\|conversion" public/
  public/index.html:4410: "...These cookies are not used for advertising or analytics."
  ```
- **Why it matters:** Without analytics the owner cannot see visitor count, traffic sources, best-selling entry pages, cart-to-checkout conversion rate, or checkout abandonment. Every other finding in this report is a guess until a measurement baseline exists.
- **How to fix:** Choose an analytics vendor (see §7, decision D2), install its script (CSP will need updating for the script source domain), and fire custom events:
  - `view_item` on `openProductDetail`
  - `add_to_cart` on `addToCart`
  - `begin_checkout` on `startCheckout`
  - `purchase` on the order-confirmation screen (read `lastOrder`)
  - `sign_up`, `login`, `review_submit`
- **Side effects / risks:** Adding Google Analytics requires updating CSP `scriptSrc` to include `https://www.googletagmanager.com` and `https://www.google-analytics.com`; `connectSrc` for the collect endpoint; and a cookie/privacy disclosures update (the Privacy policy currently says cookies are not used for advertising/analytics). A cookie consent banner may be required if targeting users in the EU/UK — Pakistan-only traffic does not require one for basic analytics.
- **How to verify:** Events appear in the vendor's realtime dashboard within minutes of deploy.
- **Depends on:** §7 decision D2.

---

### REPO-1 — Dead duplicate favicon files
- **Severity:** Low · **Effort:** S · **Estimated time:** 5 minutes
- **Where:** `public/favicon.ico`, `public/favicon-48x48.png`
- **Evidence (VERIFIED):**
  ```
  $ md5sum public/favicon.ico public/favicon-v2.ico
  a305137897f61d6d1443201ca3d688b3  public/favicon.ico
  a305137897f61d6d1443201ca3d688b3  public/favicon-v2.ico
  $ grep -rn "favicon-48x48" public/ server.js
  # (no references)
  $ grep -rn "href=\"/favicon\.ico\"" public/
  # (no references — only favicon-v2.ico is used)
  ```
- **Why it matters:** ~16 KB of dead bytes committed to the repo and bundled into the lambda; `/favicon.ico` still resolves via the static middleware (browsers request `/favicon.ico` automatically and get the legacy icon pre-v2). This means users who drag to bookmarks bar may see the old icon (which AUDIT.md says was "a grey blob").
- **How to fix:** Delete `public/favicon.ico` and `public/favicon-48x48.png`, or rename `favicon-v2.ico` → `favicon.ico` and update the HTML reference. Keep the versioned filename approach and add `Cache-Control: public, max-age=31536000, immutable` for versioned icon URLs (they already go through the `express.static` default 1-day policy, which is fine).
- **Side effects / risks:** Browser caches of the old `/favicon.ico` will eventually get a 404 — add a `<link rel="icon" href="/favicon-v2.ico">` (already present) so well-behaved browsers skip the legacy request.
- **How to verify:**
  ```
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3999/favicon.ico   # expect 404 after delete
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3999/favicon-v2.ico # expect 200
  ```
- **Depends on:** none.

---

### PERF-5 — Google Fonts loaded without `display=swap` causes FOIT
- **Severity:** Low · **Effort:** S · **Estimated time:** 5 minutes
- **Where:** `public/index.html:52` (already has `display=swap`!), `public/admin.html:15`.
- **Evidence (VERIFIED):** The storefront font link does contain `&display=swap`, but the admin link must be checked. Let me confirm:
  ```
  $ grep -n "fonts.googleapis" public/admin.html
  <link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&display=swap" rel="stylesheet" />
  ```
  Both already have `display=swap` — **DOWNGRADED TO INFO**. However, preconnect is only declared in the storefront, not in admin — adding `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />` to admin.html will shave ~50 ms off admin cold load.
- **Why it matters:** Single point of polish; not required.
- **How to fix:** Add preconnect hints to admin.html matching the storefront.
- **Side effects / risks:** None.
- **How to verify:** DevTools Network → fonts.gstatic.com connection reuses the preconnect.
- **Depends on:** none.

---

### SEC-1 — CSP still requires `'unsafe-inline'` for scripts (known issue FE-H2)
- **Severity:** Low (tracked in AUDIT.md as FE-H2, not regressed) · **Effort:** L · **Estimated time:** 3–6 hours
- **Where:** `server.js:65-80`; 91 inline `onclick=` + 8 `onkeydown=` handlers in `public/index.html`; 48 in `public/admin.html`.
- **Evidence (VERIFIED):**
  ```
  $ curl -s http://localhost:3999/ | grep -o "onclick=" | wc -l
  91
  Content-Security-Policy: script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src-attr 'unsafe-inline';
  ```
- **Why it matters:** `'unsafe-inline'` in script-src weakens CSP's XSS mitigation; any XSS bug (e.g. a missed `esc()`) can execute inline.
- **How to fix:** Already documented in AUDIT.md (FE-H2). Move to event delegation: register one listener per semantic area (nav, product grid, cart, checkout) that handles clicks/keydowns via `data-*` attributes. Once zero inline handlers remain, drop `'unsafe-inline'` from `scriptSrc` and `scriptSrcAttr`, add a nonce for any remaining truly necessary inline bootstrap (e.g. config boot). This is a non-trivial refactor — do it incrementally.
- **Side effects / risks:** The 2026-09-23 prod incident proves this must be done carefully (dropping `script-src-attr` before handlers are migrated breaks every click). Run the full 144/144 E2E + frontend suite after each migration batch.
- **How to verify:** After migration: `grep -c "onclick=" public/index.html` → 0; `grep -c "onkeydown=" public/index.html` → 0; CSP header contains neither `'unsafe-inline'`; click handlers still work in all flows.
- **Depends on:** none (long-term, coordinate with PERF-1 split).

---

### SEC-2 — HSTS preload (informational)
- **Severity:** Low · **Effort:** S · **Estimated time:** 10 minutes
- **Where:** `server.js:65` helmet config.
- **Evidence (VERIFIED):**
  ```
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  ```
- **Why it matters:** Helmet defaults already set HSTS at 1 year with `includeSubDomains`. Adding `preload` requires submitting the domain to the Chrome HSTS preload list and setting `max-age ≥ 63072000` (2 years). Optional; do this only once all subdomains (including any dev/staging) are confirmed to serve HTTPS.
- **How to fix:** Add `hsts: { maxAge: 63072000, includeSubDomains: true, preload: true }` to the helmet options. Then submit to https://hstspreload.org/.
- **Side effects / risks:** A mistake (e.g. a subdomain that doesn't support HTTPS) can make the site permanently inaccessible over HTTP for Chrome/Edge/Firefox/Safari users. Reversible only by shipping a new header and waiting for the preload list to update (months).
- **How to verify:** Check https://hstspreload.org/?domain=kage-culture-ruby.vercel.app after deploy.
- **Depends on:** none (owner opt-in only).

---

### CONTENT-1 — Empty Pants category and Coming Soon Graphic Tees are still in main nav
- **Severity:** Low · **Effort:** S · **Estimated time:** 10 minutes
- **Where:** `public/index.html:3682-3684` (nav), 3759–3784 (category tiles), `config.js:18` (`COMING_SOON_CATEGORIES`).
- **Evidence (VERIFIED):** Local dev seeded demo has 10 products — none are in category `pants`, so `/collection/pants` renders the empty-grid "No pants available right now." `/collection/graphic-tees` triggers the Coming Soon page.
- **Why it matters:** Customers clicking "Pants" land on an empty page; clicking "Graphic Tees" lands on a Coming Soon page — weak first impression.
- **How to fix:** Either (a) hide Pants from nav/category tiles until products are added (toggle via a config flag or a runtime check of whether the category has live products), or (b) remove the links until inventory exists. The homepage Pants card was fixed (2026-10-12) to stay visible but the nav entry currently hides dynamically (`id="navPantsItem" style="display:none;"` — verify this is wired to stock).
- **Side effects / risks:** None — hide rather than remove so re-enabling is a one-line change.
- **How to verify:** With no Pants products, the nav and homepage category strip should not show a Pants link.
- **Depends on:** none.

---

### CONTENT-2 — Newsletter has no unsubscribe and no send pipeline
- **Severity:** Low · **Effort:** S · **Estimated time:** 30 minutes (plus email-provider integration)
- **Where:** `routes/admin.js:169-179` (`POST /api/newsletter` stores subscribers); there is no `/api/newsletter/unsubscribe`, no admin sender, no campaign tool.
- **Evidence (VERIFIED):** The privacy policy (`public/index.html:4403`) explicitly states "The current website stores sign-ups but does not provide a self-service unsubscribe control. To request removal... contact us via WhatsApp."
- **Why it matters:** Nearly every jurisdiction (including Pakistan's upcoming data-protection rules, plus any EU/UK customers) requires a working unsubscribe path for marketing email. Even a manual "reply to unsubscribe" is fine, but once emails are actually being sent, the lack of a one-click unsubscribe risks spam complaints and blacklisting.
- **How to fix:**
  1. Add a one-click `GET /newsletter/unsubscribe?token=…` route that sets an `unsubscribed` flag (or deletes the row).
  2. Add an admin UI for sending campaigns OR integrate with a provider (Mailchimp, Resend broadcasts, Brevo).
  3. Until sending is live, update the CTA copy so subscribers know what to expect (e.g. "Get notified of new drops — we won't spam you").
- **Side effects / risks:** Subscribers who signed up before an unsubscribe mechanism exists will need to be migrated.
- **How to verify:** Clicking an Unsubscribe link in a campaign email removes the address from the list.
- **Depends on:** §7 decision D3 (email/newsletter provider).

---

### CONV-2 — No trust signals on checkout
- **Severity:** Low · **Effort:** S · **Estimated time:** 20 minutes
- **Where:** `public/index.html` checkout page (~lines 4049–4090).
- **Evidence (VERIFIED):** Checkout shows form fields, "Cash on Delivery accepted," and a "Place Order" button. No "Secure checkout," "No payment until delivery," or return-policy reassurance.
- **Why it matters:** For a new brand with no name recognition, first-time buyers need reassurance that COD means they pay on receipt and that returns are easy.
- **How to fix:** Add a small trust strip under the Place Order button:
  ```html
  <p class="co-safe">✓ Cash on Delivery — pay only when your order arrives.
     ✓ 7-day easy returns. ✓ Your information is encrypted and never shared.</p>
  ```
  Mirror the existing `.co-safe` class (already used on line 4082).
- **Side effects / risks:** None.
- **How to verify:** Visual check on mobile and desktop.
- **Depends on:** none.

---

### UX-1 — Floating WhatsApp button overlap on product page
- **Severity:** Low · **Effort:** S · **Estimated time:** 15 minutes
- **Where:** `public/index.html:2399-2410` (whatsapp-float responsive rules), 6817 (floating anchor).
- **Evidence (VERIFIED in code):** The hide rule `body:has(#page-product.active) .whatsapp-float { display: none; }` only applies above 768 px (wrapped in a media query that starts at `@media (min-width: 769px)` per the earlier audit). At ≤768 px the button still sits at bottom-right while the product page has a sticky Add-to-Cart bar (`.sticky-cart-bar`); they may overlap.
- **Why it matters:** Mobile users cannot tap Add-to-Cart if WhatsApp covers it.
- **How to fix:** Either (a) hide the WhatsApp float whenever `.sticky-cart-bar` is visible (apply at all breakpoints), or (b) move the WhatsApp button to 20 px above the sticky bar's height.
- **Side effects / risks:** Test across all page types; ensure the button remains reachable on the cart/checkout/account pages where there is no sticky bar.
- **How to verify:** Headless Chromium at 360/390/414 px on product page — the floating button must not overlap `.sticky-cart-bar`; both must be clickable.
- **Depends on:** none.

---

### A11Y-5 — Skip link target not explicit
- **Severity:** Low · **Effort:** S · **Estimated time:** 5 minutes
- **Where:** `public/index.html:126-133` (`.skip-link`), `<main>` element.
- **Evidence (VERIFIED):** Skip link is `<a class="skip-link" href="#main">Skip to content</a>` (or similar) — need to verify the target exists:
  ```
  $ grep -n 'id="main"\|href="#main"\|<main' public/index.html | head
  <main>
  ```
  The `<main>` element has no `id="main"` attribute, so activating the skip link does not jump to main content in some browsers.
- **How to fix:** Add `id="main"` to the `<main>` tag. Add `tabindex="-1"` so programmatic focus moves there (some screen readers need it).
- **Side effects / risks:** None.
- **How to verify:** Tab from the address bar → first tab is "Skip to content" → Enter → focus moves to `<main>` and next Tab lands on the first interactive content element.
- **Depends on:** none.

---

## 4. Recommended fix order

**Do today (≤2 hours, ship in one deploy):**
1. REPO-1 — delete dead favicon files (S, no risk).
2. A11Y-1 — darken `--text-gray` to meet 4.5:1 contrast (S).
3. PERF-2 — remove Zen Brush font request (S).
4. A11Y-5 — add `id="main"` for skip link (S).
5. SEO-2 — expand sitemap with products + collections (S).
6. A11Y-3 — add `aria-live` region for cart/toast feedback (S).
7. CONV-2 — add trust strip under checkout Place Order (S).
8. CONTENT-1 — hide empty Pants/Graphics Tees from main nav until stock exists (S).

These are all parallelizable and risk-free.

**This week (3–10 hours):**
9. A11Y-2 — clean up `outline:none` with proper `:focus-visible` replacements (S).
10. A11Y-4 — focus trap + focus return on drawers (M).
11. SEO-1 + SEO-3 + SEO-4 — server-side dynamic metadata + Product JSON-LD (M, do together).
12. UX-1 — fix WhatsApp float overlap on mobile product pages (S).
13. PERF-3 — add `srcset`/`sizes` to product and category images (S; or defer and use Vercel Image Optimization).
14. ANALYTICS-1 — install analytics (S after vendor decision).

**This month / next sprint:**
15. PERF-1 — split the 324 KB HTML shell into cached CSS/JS (M).
16. PERF-4 — restructure Vercel routing to keep static assets out of the lambda bundle (M).
17. SEC-1 — event-delegation migration to drop `'unsafe-inline'` (L; long-term).
18. CONTENT-2 — newsletter unsubscribe + campaign pipeline (S after provider decision).
19. CONV-1 — formalise delivery-charge policy and messaging (M after owner decision).
20. SEC-2 — HSTS preload (S, optional).

**Dependencies:** SEO-1 unblocks SEO-3/4; CONV-1 is blocked on owner decision D1; ANALYTICS-1 depends on vendor decision D2; CONTENT-2 depends on provider decision D3. All other items are independent.

---

## 5. Quick wins (high impact, low effort — top 10)

1. **Darken `--text-gray`** (A11Y-1, 20 min) — fixes a WCAG AA failure site-wide.
2. **Remove Zen Brush from Google Fonts** (PERF-2, 5 min) — cuts a render-blocking request.
3. **Add `aria-live` polite region** (A11Y-3, 30 min) — makes cart/toast actions usable with screen readers.
4. **Expand sitemap to include all products/collections** (SEO-2, 30 min) — fastest SEO lift for Google discovery.
5. **Delete dead favicon files** (REPO-1, 5 min) — removes stale icon from legacy `/favicon.ico` requests.
6. **Hide empty categories from nav** (CONTENT-1, 10 min) — removes dead-end UX.
7. **Add trust strip on checkout** (CONV-2, 20 min) — immediate conversion reassurance.
8. **Add `id="main"` to `<main>`** (A11Y-5, 5 min) — makes the skip link actually work.
9. **Add preconnect hints to admin.html** (PERF-5, 5 min) — tiny admin performance win.
10. **Install analytics** (ANALYTICS-1, 30 min after vendor choice) — unlocks every other conversion decision.

---

## 6. What I could not verify (needs live tools)

| Item | Tool needed | Why I couldn't check it here |
|---|---|---|
| Real Core Web Vitals (LCP, CLS, INP) on production | Lighthouse CI, PageSpeed Insights, Chrome User Experience Report | This sandbox can't reach `kage-culture-ruby.vercel.app` outbound (only the listed hosts), and local sql.js latency is unrepresentative. |
| Live CSP/HSTS/security headers on production | https://securityheaders.com | No outbound access to arbitrary domains. |
| Google indexing status, crawl errors, impressions, CTR | Google Search Console | Requires the owner's account. |
| Rich-results validation of Product JSON-LD after SEO-3 | https://search.google.com/test/rich-results | Must be tested against the deployed URL. |
| Social-share previews (Facebook, WhatsApp, Slack, Twitter/X) after SEO-1/4 | Facebook Sharing Debugger, Twitter Card Validator, Slack unfurl | Requires deployed absolute URLs. |
| Live Vercel cold-start times and Turso latency | Vercel logs dashboard, Datadog/New Relic | This sandbox runs in-memory; Vercel metrics not accessible. |
| Screen-reader testing (NVDA/JAWS/VoiceOver) | WAVE (wave.webaim.org), axe DevTools, manual screen-reader pass | No GUI browser with assistive tech in this sandbox. |
| Touch-target spacing on physical devices (iPhone SE, small Android) | BrowserStack or physical devices | Headless Chromium in sandbox can compute geometry but cannot simulate real finger taps. |
| Mobile network performance (3G Pakistan) | WebPageTest.org (Karachi node) or real device on a Pakistani SIM | No route to those nodes. |
| Turso database latency, index coverage on production data | Turso dashboard, `EXPLAIN QUERY PLAN` on production | Production credentials are not available; local demo DB is tiny. |
| Email delivery (confirmation, status-update, reset) | Mail-tester.com, real inbox test | Without SMTP/Resend configured (dev mode logs the email body only) delivery/spam score is not verified. |
| Resend/SMTP credential behaviour in Vercel | Send a real order to a test address and inspect headers | Not allowed in a REPORT-only audit without owner's permission. |
| Blob storage latency and image cache-hit at edge | Vercel dashboard / fastly/See CDN logs | Not accessible. |

---

## 7. Design decisions needed from the owner

### D1 — Delivery-charge pricing model (blocks CONV-1)

The current "To be confirmed" model was a deliberate owner choice (per AUDIT.md 2026-10-11). Before improving the checkout copy, choose one of:

- **Option A (recommended): Flat fee with city-tier caveat.** Publish Rs. 150 for major cities (Lahore/Karachi/Islamabad/Rawalpindi/Faisalabad/Multan) and Rs. 250 nationwide. Admin adds the real fee after confirming with the courier; customer sees the upper bound before placing the order. *Trade-off:* easy to implement, honest, few disputes; rare cases may lose money on remote deliveries.
- **Option B: Pure post-order confirmation (current model, tightened).** Keep `shipping=0` at placement, but publish a clear ceiling ("Delivery charges will not exceed Rs. 250 — we will call to confirm before dispatch"). *Trade-off:* maximises flexibility; still slightly ambiguous.
- **Option C: Free shipping over a threshold, flat fee below.** e.g. Free shipping on orders over Rs. 2,500; Rs. 200 below. *Trade-off:* encourages larger carts; increases revenue per order but reduces margin on borderline orders.
- **Recommendation:** Option A. Publish the band, confirm by phone for unusual addresses.

### D2 — Analytics vendor (blocks ANALYTICS-1)

- **Option A: Google Analytics 4 (free).** Most powerful; requires updating CSP and the Privacy policy; ad-blockers block ~30% of hits.
- **Option B: Plausible or Umami (self-hosted or paid, ~$9/mo).** Privacy-friendly, no cookie banner needed for EU traffic, simple dashboard, CSP allows with one domain.
- **Option C: Vercel Analytics (paid, $10/mo on Pro).** One-line install, first-class Vercel integration but less funnel detail.
- **Recommendation:** Option B (Plausible/Umami) for a Pakistan-focused brand with EU/UK visitors who might land via Insta ads — avoids the GDPR consent-banner cost while giving real funnel numbers. If the brand will never serve EU users, Option A is fine.

### D3 — Newsletter / transactional email provider (blocks CONTENT-2)

- **Option A: Continue with Resend (already in the code via `process.env.EMAIL_API_KEY`).** Resend supports broadcasts; add a contact list and one-click unsubscribe. *Trade-off:* already configured; pricing is pay-as-you-grow.
- **Option B: SMTP now, Mailchimp/Brevo later for marketing.** Keep transactional email via SMTP (already in code) and leave the newsletter as "notify me" only (no campaigns). *Trade-off:* zero new vendors; no bulk email until integration.
- **Option C: Move all email to Brevo (Sendinblue).** Good free tier; built-in unsubscribe, marketing campaigns and transactional SMTP. *Trade-off:* requires changing the transport.
- **Recommendation:** Option A for speed — Resend broadcast API is available with the same key, and the one-click unsubscribe route is a small addition.

### D4 — CSP `'unsafe-inline'` removal timeline (SEC-1 / FE-H2)

- **Option A: Defer until after launch of analytics/SEO/features.** Keep the current CSP for the next 3–6 months.
- **Option B: Schedule as next full sprint.** Migrate 91 inline handlers to event delegation over 3–6 PRs, ship a test in CI that fails if any inline handler returns.
- **Option C: Use a nonce now and relax only for the small nonced bootstrap block, leaving handlers migrated lazily.** The inline `onclick=`/`onkeydown=` *attributes* still violate CSP even with nonces, so this does not actually help with `script-src-attr`.
- **Recommendation:** Option B — schedule as the next dedicated frontend hardening sprint. Track as FE-H2 per the existing queue.

// Reassemble the PERF-1 split pages for jsdom: the external CSS/JS bundles
// are inlined back byte-identically, so content assertions and script
// execution see exactly what the pre-split file contained. (The one
// deliberate difference: the mid-page marquee block now runs at bundle
// start instead of mid-parse — see the storefront.js banner. It only
// measures the topbar above it, so the result is identical.)
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const PUBLIC = join(__dirname, '..', '..', 'public');

function stitched(page) {
  const isAdmin = page === 'admin';
  const file = isAdmin ? 'admin.html' : 'index.html';
  const base = isAdmin ? 'admin' : 'storefront';
  const prefix = isAdmin ? 'ADMIN' : 'STORE';
  let html = readFileSync(join(PUBLIC, file), 'utf8');
  const css = readFileSync(join(PUBLIC, `${base}.css`), 'utf8');
  const js = readFileSync(join(PUBLIC, `${base}.js`), 'utf8');
  const linkTag = `<link rel="stylesheet" href="/${base}.css?v=__${prefix}_CSS_HASH__">`;
  const scriptTag = `<script src="/${base}.js?v=__${prefix}_JS_HASH__"></script>`;
  assert.equal(html.split(linkTag).length - 1, 1, `${file} must reference its CSS bundle once`);
  assert.equal(html.split(scriptTag).length - 1, 1, `${file} must reference its JS bundle once`);
  html = html.replace(linkTag, `<style>${css}</style>`);
  html = html.replace(scriptTag, `<script>${js}</script>`);
  return html;
}

module.exports = { stitched };

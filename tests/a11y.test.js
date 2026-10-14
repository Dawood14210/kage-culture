// WCAG 2.x sRGB contrast + explicit outline-reset coverage + real input modality.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { launchChromium } = require('./fixtures/chromium');
const { readPage, cssFrom, rulesFrom, color, luminance, composite, contrast, contrastPairs, outlineResets } = require('./fixtures/a11y');
const modalitySource = readFileSync(require.resolve('../public/focus-modality.js'), 'utf8');
const pointerResets = new Set([':root[data-focus-modality="pointer"] :focus', ':root[data-focus-modality="pointer"] :focus-within']);

function checkContrast(name, dark = false) {
  const html = readPage(name);
  const { tokens, pairs, foregrounds } = contrastPairs(name, html, dark);
  const covered = new Set([...foregrounds, '--text-on-primary', '--text-on-primary-hover', '--text-on-danger', '--text-on-accent']);
  // The two storefront tokens below color only heart/star icons, not body text.
  if (name === 'index') { covered.add('--heart-red'); covered.add('--border-color'); }
  for (const match of html.matchAll(/(?<![-\w])color\s*:\s*var\((--[\w-]+)/g)) {
    assert.ok(covered.has(match[1]), `${name}: untested text token ${match[1]}`);
    assert.ok(tokens[match[1]], `${name}: undefined text token ${match[1]}`);
  }
  const failures = pairs.filter(pair => pair.ratio < 4.5);
  assert.deepEqual(failures.map(pair => `${pair.foreground} / ${pair.background} over ${pair.underlay}: ${pair.ratio.toFixed(3)}:1`), [], `${name} ${dark ? 'dark' : 'light'} needs 4.5:1 for all body/secondary text (also exceeds large-text 3:1)`);
  // A hierarchy must not collapse to one accessible but undifferentiated color.
  const hierarchy = ['--text-primary', '--text-secondary', '--text-muted', '--text-dim'].map(k => luminance(color(tokens[k])));
  assert.ok(hierarchy.every((value, i) => i === 0 || (dark ? value < hierarchy[i - 1] : value > hierarchy[i - 1])), `${name}: primary > secondary > muted > dim hierarchy`);
  console.log(`✅ ${name} ${dark ? 'dark' : 'light'}: ${pairs.length} parsed text/background pairs ≥4.5:1`);
}
function checkOutlines(name) {
  const html = readPage(name), rules = rulesFrom(html);
  assert.match(html, /<script src="\/focus-modality\.js" defer><\/script>/);
  const positive = new Set();
  for (const rule of rules) {
    if (!/^2px solid var\(--(?:accent|text-accent)\)$/.test(rule.style.getPropertyValue('outline').trim())) continue;
    assert.equal(rule.style.getPropertyValue('outline-offset'), '2px');
    rule.selectorText.split(',').forEach(selector => positive.add(selector.trim()));
  }
  const resets = outlineResets(html);
  for (const { selector, rule } of resets) {
    if (pointerResets.has(selector)) {
      // This is an intentional non-keyboard-only suppression, not a missing ring.
      assert.equal(rule.style.getPropertyPriority('outline'), 'important');
      continue;
    }
    assert.ok(!selector.includes(':focus-visible'), `${name}: never suppress keyboard focus (${selector})`);
    const counterpart = selector.replace(/:focus\b(?!-visible)/g, '') + ':focus-visible';
    assert.ok(positive.has(counterpart), `${name}: ${selector} has no explicit visible keyboard counterpart`);
  }
  console.log(`✅ ${name}: every outline reset has a 2px/2px :focus-visible counterpart`);
  return [...new Set(resets.filter(r => !pointerResets.has(r.selector)).map(r => r.selector.replace(/:focus\b(?!-visible)/g, '')))];
}
(async () => {
  // Guard the math itself against a wrong gamma formula or missing alpha compositing.
  const { contrast } = require('./fixtures/a11y');
  assert.equal(contrast(color('#000'), color('#FFF')), 21);
  assert.equal(contrast(color('#FFF'), color('#FFF')), 1);
  assert.ok(Math.abs(contrast(color('#8A8578'), color('#C4BEB0')) - 1.987) < 0.001);
  assert.ok(contrast(color('rgba(0,0,0,0.5)'), color('#FFF')) < contrast(color('#000'), color('#FFF')));
  const selectors = {};
  for (const name of ['index', 'admin']) {
    checkContrast(name);
    if (name === 'admin') checkContrast(name, true);
    selectors[name] = checkOutlines(name);
  }
  const browser = await launchChromium();
  try {
    for (const [name, dark] of [['index', false], ['admin', false], ['admin', true]]) {
      const page = await browser.newPage();
      await page.setContent(`<html${dark ? ' data-theme="dark"' : ''}><head><style>${cssFrom(readPage(name))}</style></head><body><script>${modalitySource}</script></body></html>`);
      for (const selector of selectors[name]) {
        await page.evaluate(selector => {
          document.getElementById('a11y-fixture')?.remove();
          const fixture = document.createElement('div');
          fixture.id = 'a11y-fixture';
          fixture.style.cssText = 'position:fixed;inset:0;z-index:2147483647;padding:40px;overflow:auto;background:var(--bg-primary,var(--bg));';
          const before = document.createElement('button');
          before.id = 'a11y-before'; before.textContent = 'Before';
          fixture.append(before);
          let parent = fixture;
          const parts = selector.split(/\s+/);
          parts.forEach((part, index) => {
            const last = index === parts.length - 1;
            const tag = /^(input|select|textarea)/.exec(part)?.[1] || (last ? (/sort-select/.test(part) ? 'select' : 'input') : 'div');
            const element = document.createElement(tag);
            element.className = [...part.matchAll(/\.([\w-]+)/g)].map(m => m[1]).join(' ');
            for (const m of part.matchAll(/\[([\w-]+)=(?:"([^"]+)"|([^\]]+))\]/g)) element.setAttribute(m[1], m[2] || m[3]);
            element.style.cssText = 'display:block!important;position:static!important;opacity:1!important;transform:none!important;';
            if (last) { element.id = 'a11y-target'; element.setAttribute('aria-label', selector); element.setAttribute('placeholder', 'Secondary text'); }
            parent.append(element); parent = element;
          });
          document.body.append(fixture);
          if (!document.getElementById('a11y-target').matches(selector)) throw new Error('fixture does not match ' + selector);
        }, selector);
        const rendered = await page.$eval('#a11y-target', el => {
          const layers = [];
          for (let node = el; node; node = node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor);
          const placeholder = getComputedStyle(el, '::placeholder');
          return { foreground: getComputedStyle(el).color, placeholder: placeholder.color, opacity: placeholder.opacity, layers };
        });
        const background = rendered.layers.reduce((under, layer) => composite(color(layer), under), color('#FFF'));
        assert.ok(contrast(color(rendered.foreground), background) >= 4.5, `${name} ${selector}: rendered input text contrast`);
        if (!selector.includes('select')) {
          assert.equal(rendered.opacity, '1', `${name} ${selector}: placeholder opacity must not reduce contrast`);
          assert.ok(contrast(color(rendered.placeholder), background) >= 4.5, `${name} ${selector}: rendered placeholder contrast`);
        }
        await page.click('#a11y-target');
        assert.equal(await page.$eval('#a11y-target', el => getComputedStyle(el).outlineStyle), 'none', `${name} ${selector}: pointer must not show the keyboard ring`);
        await page.focus('#a11y-before');
        await page.keyboard.press('Tab');
        const result = await page.$eval('#a11y-target', el => {
          const style = getComputedStyle(el);
          return { focused: document.activeElement === el, style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset };
        });
        assert.deepEqual(result, { focused: true, style: 'solid', width: '2px', offset: '2px' }, `${name} ${dark ? 'dark' : 'light'} ${selector}: Tab ring must win the actual cascade`);
      }
      console.log(`✅ Chromium ${name} ${dark ? 'dark' : 'light'}: ${selectors[name].length} reset selectors tested with click and Tab`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

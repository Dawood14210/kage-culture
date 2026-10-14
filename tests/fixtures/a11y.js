const { readFileSync } = require('node:fs');
const path = require('node:path');
// Already installed by jsdom and pinned in package-lock.json; no new dependency.
const { parse } = require('rrweb-cssom');

function readPage(name) {
  return readFileSync(path.join(__dirname, '../../public', `${name}.html`), 'utf8');
}
function cssFrom(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
}
function rulesFrom(html) {
  const out = [];
  function walk(rules) {
    for (const rule of rules) {
      if (rule.cssRules) walk(rule.cssRules);
      if (rule.selectorText && rule.style) out.push(rule);
    }
  }
  walk(parse(cssFrom(html)).cssRules);
  return out;
}
function tokensFrom(html, dark = false) {
  const tokens = {};
  for (const rule of rulesFrom(html)) {
    if (rule.selectorText !== ':root' && !(dark && rule.selectorText === '[data-theme="dark"]')) continue;
    for (let i = 0; i < rule.style.length; i++) {
      const key = rule.style[i];
      if (key.startsWith('--')) tokens[key] = rule.style.getPropertyValue(key).trim();
    }
  }
  return tokens;
}
function color(value, tokens = {}) {
  if (Array.isArray(value)) return value;
  if (value.startsWith('var(')) return color(tokens[value.match(/var\((--[\w-]+)/)[1]], tokens);
  if (value.startsWith('--')) return color(tokens[value], tokens);
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map(x => x + x).join('') : hex[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgb) { const channels = rgb[1].split(',').map(Number); return channels.length === 3 ? [...channels, 1] : channels; }
  throw new Error(`Unsupported or missing color: ${value}`);
}
function composite(foreground, background) {
  const a = foreground[3];
  return foreground.slice(0, 3).map((channel, i) => channel * a + background[i] * (1 - a)).concat(1);
}
function luminance(c) {
  const linear = c.slice(0, 3).map(v => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return linear.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(foreground, background) {
  const lum = [luminance(composite(foreground, background)), luminance(background)].sort((a, b) => a - b);
  return (lum[1] + 0.05) / (lum[0] + 0.05);
}
// Conservative coverage: every ordinary text token on every base surface,
// including input/sidebar/hover surfaces, not just today's observed combinations.
// Inverse tokens apply only to their explicit button/selection backgrounds.
function contrastPairs(name, html = readPage(name), dark = false) {
  const tokens = tokensFrom(html, dark);
  const rules = rulesFrom(html);
  const page = name === 'index' ? '--bg-primary' : '--bg';
  const surfaces = Object.keys(tokens).filter(k => k.startsWith('--bg'));
  const foregrounds = Object.keys(tokens).filter(k => k.startsWith('--text-') && !k.startsWith('--text-on-'));
  if (name === 'index') foregrounds.push('--accent');
  const pairs = [];
  const seen = new Set();
  function add(fg, bg, underlay = page, label = bg) {
    const key = `${fg}/${label}/${underlay}`;
    if (seen.has(key)) return;
    seen.add(key);
    const background = composite(color(bg, tokens), color(underlay, tokens));
    pairs.push({ foreground: fg, background: label, underlay, ratio: contrast(color(fg, tokens), background) });
  }
  for (const foreground of foregrounds) for (const background of surfaces) add(foreground, background);
  if (name === 'admin') {
    add('--text-on-primary', '--text-primary');
    add('--text-on-primary-hover', '#374151');
    add('--text-on-danger', '--red');
    add('--text-on-accent', '--accent');
    // White-tinted hover on a transparent period control inherits its elevated surface.
    add('--text-primary', 'rgba(255,255,255,0.05)', '--bg-elevated');
  }
  // Direct text-token/background declarations (including translucent status tints).
  // A translucent background can inherit any base surface: check every one.
  for (const rule of rules) {
    let foreground = /^var\((--[\w-]+)\)$/.exec(rule.style.getPropertyValue('color').trim());
    // Background-only hover rules retain their base selector's text color.
    if (!foreground && /:(?:hover|active)/.test(rule.selectorText)) {
      const baseSelector = rule.selectorText.replace(/:(?:hover|active)/g, '');
      const base = rules.filter(r => r.selectorText === baseSelector && r.style.getPropertyValue('color')).pop();
      if (base) foreground = /^var\((--[\w-]+)\)$/.exec(base.style.getPropertyValue('color').trim());
    }
    const background = (rule.style.getPropertyValue('background-color') || rule.style.getPropertyValue('background')).trim();
    if (!foreground || !background || background === 'none' || background === 'transparent') continue;
    try {
      const c = color(background, tokens);
      for (const surface of c[3] < 1 ? surfaces.filter(s => color(s, tokens)[3] === 1) : [page]) add(foreground[1], background, surface);
    } catch (error) {
      // Do not silently drop token/solid-color declarations; gradients/images are non-flat.
      if (/^(var\(|#|rgba?\()/.test(background)) throw error;
    }
  }
  return { tokens, pairs, surfaces, foregrounds };
}
function outlineResets(html) {
  const resets = [];
  for (const rule of rulesFrom(html)) {
    if (!/^(?:none|0(?:px)?)(?:\s+.*)?$/.test(rule.style.getPropertyValue('outline').trim())) continue;
    for (const selector of rule.selectorText.split(',').map(s => s.trim())) {
      resets.push({ selector, rule });
    }
  }
  return resets;
}
module.exports = { readPage, cssFrom, rulesFrom, tokensFrom, color, composite, luminance, contrast, contrastPairs, outlineResets };

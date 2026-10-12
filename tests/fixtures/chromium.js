// ================================================================
// Real-Chromium launcher for the browser layout checks
// ----------------------------------------------------------------
// Resolution order:
//   1. PUPPETEER_EXECUTABLE_PATH / CHROME_PATH / well-known system installs
//   2. @sparticuz/chromium — an npm package that ships the browser binary
//      (chosen because Google's download hosts are not reachable everywhere).
// On bare Linux hosts the package's bundled shared libraries (al2023.tar.br)
// are normally only extracted on AWS Lambda — extract them ourselves and put
// them on LD_LIBRARY_PATH so the browser starts anywhere.
// ================================================================
const fs = require('node:fs');
const path = require('node:path');

function findSystemChromium() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch (_) { return false; }
  }) || null;
}

async function launchChromium() {
  const puppeteer = require('puppeteer-core');
  let executablePath = findSystemChromium();
  let extraArgs = [];

  if (!executablePath) {
    let chromium;
    try {
      chromium = require('@sparticuz/chromium').default;
    } catch (err) {
      throw new Error('No Chromium available: set PUPPETEER_EXECUTABLE_PATH or add @sparticuz/chromium as a dev dependency');
    }
    if (process.platform === 'linux') {
      const { inflate } = require('@sparticuz/chromium');
      const packageRoot = path.join(path.dirname(require.resolve('@sparticuz/chromium')), '..');
      const libDir = path.join('/tmp', 'al2023', 'lib');
      if (!fs.existsSync(libDir)) {
        await inflate(path.join(packageRoot, 'bin', 'al2023.tar.br'));
      }
      if (!process.env.LD_LIBRARY_PATH || !process.env.LD_LIBRARY_PATH.split(':').includes(libDir)) {
        process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
      }
    }
    executablePath = await chromium.executablePath();
    extraArgs = chromium.args;
  }

  return puppeteer.launch({
    executablePath,
    args: [...extraArgs, '--no-sandbox', '--disable-dev-shm-usage'],
    headless: true
  });
}

// Wait until the SPA's catalog has loaded (its `productsLoadedFromApi` is a
// module-level `let`, so read it through eval like the jsdom suites do).
async function waitForCatalog(page, timeout = 20000) {
  await page.waitForFunction(
    () => { try { return eval('productsLoadedFromApi') === true; } catch (e) { return false; } },
    { timeout }
  );
}

// Finish in-flight page animations so geometry measurements see final
// positions, without changing category-card visibility classes.
async function settleLayout(page) {
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* infinite */ } });
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

module.exports = { launchChromium, waitForCatalog, settleLayout };

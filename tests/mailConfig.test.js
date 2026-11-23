// ================================================================
// KAGE Culture — email transport configuration tests
// ================================================================
// Covers the independent reasons a shop with a valid Gmail App Password can
// still send nothing:
//   1. `.env` values kept their trailing "# comment" (SMTP_PORT stopped being a
//      number and SMTP_PASS gained the comment text);
//   2. `npm run dev` never called startServer(), so the app that reads .env
//      never listened — while `npm start`, the one that does listen, never
//      reads .env;
//   3. a provider rejection was swallowed, so signup said "check your email"
//      and checkout still returned a cheerful 201.
// ================================================================
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const { parseEnvLine, loadEnvFile } = require('../scripts/dev');
const { describeMailConfig, formatMailConfigLine } = require('../utils/mailConfig');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (err) { failures += 1; console.error(`❌ ${name}\n   ${err.message}`); }
}

function envFrom(text, preset = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kage-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text);
  const env = { ...preset };
  try { loadEnvFile(file, env, () => {}); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return env;
}

(async () => {
  // ------------------------------------------------------------- .env parser
  await check('.env.example copied verbatim yields clean values', () => {
    const env = envFrom([
      'SMTP_HOST=smtp.gmail.com            # e.g. smtp.gmail.com; takes precedence over Resend when set',
      'SMTP_PORT=465            # Gmail: 465 (implicit TLS); 587 also works with STARTTLS',
      'SMTP_USER=shop@gmail.com               # Full Gmail address, e.g. shop@example.com',
      'SMTP_PASS=abcdefghijklmnop               # Gmail App Password without display spaces',
      'SITE_URL=https://kage.pk                # Canonical public HTTPS origin'
    ].join('\n'));
    assert.strictEqual(env.SMTP_HOST, 'smtp.gmail.com');
    assert.strictEqual(env.SMTP_PORT, '465', 'the trailing comment must not become part of the port');
    assert.strictEqual(env.SMTP_USER, 'shop@gmail.com');
    assert.strictEqual(env.SMTP_PASS, 'abcdefghijklmnop', 'the trailing comment must not become part of the password');
    assert.strictEqual(env.SITE_URL, 'https://kage.pk');
  });

  await check('quotes protect spaces and "#"; export prefixes and inline comments work', () => {
    const env = envFrom([
      'SMTP_USER="shop@gmail.com"           # quoted',
      "SMTP_PASS='abcd efgh ijkl mnop'",
      'export SITE_URL=https://kage.pk   # inline',
      'EMAIL_FROM="KAGE Culture <shop@gmail.com>"',
      '# a full-line comment is skipped',
      'SMTP_PORT="587"'
    ].join('\n'));
    assert.strictEqual(env.SMTP_USER, 'shop@gmail.com');
    assert.strictEqual(env.SMTP_PASS, 'abcd efgh ijkl mnop', 'single quotes are literal and protect spaces');
    assert.strictEqual(env.SITE_URL, 'https://kage.pk');
    assert.strictEqual(env.EMAIL_FROM, 'KAGE Culture <shop@gmail.com>');
    assert.strictEqual(env.SMTP_PORT, '587');
  });

  await check('a "#" inside quotes is kept, not treated as a comment', () => {
    const env = envFrom('SMTP_PASS="p#ss word"   # note');
    assert.strictEqual(env.SMTP_PASS, 'p#ss word');
  });

  await check('values already exported in the shell win over .env', () => {
    const env = envFrom('SMTP_USER=from-dotenv@gmail.com', { SMTP_USER: 'from-shell@gmail.com' });
    assert.strictEqual(env.SMTP_USER, 'from-shell@gmail.com');
  });

  await check('parseEnvLine rejects non-assignment lines', () => {
    assert.strictEqual(parseEnvLine('not an assignment'), null);
    assert.deepStrictEqual(parseEnvLine('KEY='), { key: 'KEY', value: '' });
  });

  // ------------------------------------------------------------ diagnostics
  await check('a correct Gmail App Password setup reports ok and never logs the secret', () => {
    const status = describeMailConfig({
      SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'shop@gmail.com',
      SMTP_PASS: 'abcdefghijklmnop', SITE_URL: 'https://kage.pk'
    });
    assert.strictEqual(status.ok, true, JSON.stringify(status.problems));
    assert.strictEqual(status.transport, 'smtp');
    assert.strictEqual(status.port, 465);
    assert.strictEqual(status.secure, true);
    assert.strictEqual(status.passwordLooksLikeAppPassword, true);
    const line = formatMailConfigLine(status);
    assert.match(line, /smtp\.gmail\.com:465 \(implicit TLS\)/);
    assert.ok(!line.includes('abcdefghijklmnop'), 'the password must never appear in a log line');
  });

  await check('copied .env.example comments are named as the actual problem', () => {
    const status = describeMailConfig({
      SMTP_HOST: 'smtp.gmail.com            # e.g. smtp.gmail.com',
      SMTP_PORT: '465            # Gmail: 465',
      SMTP_USER: 'shop@gmail.com               # Full Gmail address',
      SMTP_PASS: 'abcd efgh ijkl mnop               # Gmail App Password',
      SITE_URL: '# Canonical public HTTPS origin'
    });
    assert.strictEqual(status.ok, false);
    const all = status.problems.join('\n');
    assert.match(all, /SMTP_PORT .* is not a number/, 'the port comment must be called out');
    assert.match(all, /SMTP_HOST .* does not look like a hostname/);
    assert.match(all, /SMTP_PASS contains a "#"/, 'the pasted "# comment" in the password must be called out');
  });

  await check('Google\'s space-separated display form is accepted, not a hard error', () => {
    const status = describeMailConfig({
      SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'shop@gmail.com',
      SMTP_PASS: 'abcd efgh ijkl mnop', SITE_URL: 'https://kage.pk'
    });
    assert.strictEqual(status.problems.length, 0, JSON.stringify(status.problems));
    assert.strictEqual(status.passwordLooksLikeAppPassword, true);
  });

  await check('port 25 names the fix; 587 is reported as STARTTLS', () => {
    const on25 = describeMailConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '25', SMTP_USER: 'a@b.com', SMTP_PASS: 'x'.repeat(16) });
    assert.strictEqual(on25.ok, false);
    assert.match(on25.problems.join(' '), /blocked outbound/);
    const on587 = describeMailConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_USER: 'a@b.com', SMTP_PASS: 'x'.repeat(16) });
    assert.strictEqual(on587.secure, false);
    assert.match(formatMailConfigLine(on587), /STARTTLS/);
  });

  await check('a missing SITE_URL warns, but does not block order confirmations', () => {
    const status = describeMailConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'a@b.com', SMTP_PASS: 'x'.repeat(16) });
    assert.strictEqual(status.ok, true, 'order confirmations do not need SITE_URL');
    assert.match(status.warnings.join(' '), /verification and password-reset emails are suppressed/);
  });

  await check('an empty environment says "not configured" instead of pretending', () => {
    const status = describeMailConfig({});
    assert.strictEqual(status.transport, 'none');
    assert.strictEqual(status.ok, false);
    assert.match(formatMailConfigLine(status), /NOT CONFIGURED/);
  });

  await check('an empty password is a problem, not a silent unauthenticated send', () => {
    const status = describeMailConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@b.com', SMTP_PASS: '' });
    assert.strictEqual(status.ok, false);
    assert.match(status.problems.join(' '), /SMTP_PASS is empty/);
  });

  // -------------------------------------------------------------- lifecycle
  await check('server.js exports startServer so the .env-aware dev entry can boot it', () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'server.js'), 'utf8');
    assert.match(src, /function startServer\(\)/, 'startServer must exist');
    assert.match(src, /module\.exports\.startServer = startServer;/, 'and be exported');
    const devSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'dev.js'), 'utf8');
    assert.match(devSrc, /require\('\.\.\/server\.js'\)\.startServer\(\)/, 'npm run dev must boot the server it just configured');
  });

  await check('signup reports delivery, not just that a link was built', () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'routes', 'auth.js'), 'utf8');
    assert.match(src, /verification\.sent/, 'the signup message must depend on delivery');
    assert.match(src, /we could not send the verification email/, 'and say so when the provider refuses');
  });

  await check('a send failure logs the variables to check', () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'routes', 'auth.js'), 'utf8');
    assert.match(src, /Verification email was NOT delivered/);
    assert.match(src, /16-character App Password/);
  });

  if (failures) { console.error(`\n${failures} email-configuration check(s) failed`); process.exit(1); }
  console.log('\nAll email configuration checks passed.');
})();

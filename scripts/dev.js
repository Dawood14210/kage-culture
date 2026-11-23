#!/usr/bin/env node
// ================================================================
// KAGE Culture — local development entry point
// ================================================================
// `npm run dev` (and only that) treats the machine as development:
//   - NODE_ENV defaults to 'development', which is what lets utils/secret.js
//     use its throwaway fallback secret. Anywhere else SESSION_SECRET is
//     mandatory, so `node server.js` with no env vars refuses to boot.
//   - .env is loaded if present — the app has no dotenv dependency, this is
//     the whole loader. Real environments get real variables.
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

// Parse one `KEY=value` line the way every other .env tool does:
//   KEY=value            -> value
//   KEY="value with #"   -> value with #   (quotes protect # and spaces)
//   KEY=value            # trailing comment is DROPPED
//   KEY='literal value'  -> literal value
// The app's own .env.example ends every variable with a `# comment`, and the
// previous naive parser kept that comment as part of the value — so
// `SMTP_PORT=465  # Gmail...` became the string "465 # Gmail..." and every
// mail send failed on an invalid port. Trailing comments are now stripped
// unless they are inside quotes.
function parseEnvLine(line) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!match) return null;
  const key = match[1];
  let value = match[2].trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    // Quoted value: find the matching close quote, ignore # inside it.
    const end = value.indexOf(quote, 1);
    if (end !== -1) {
      const quoted = value.slice(1, end);
      // Double quotes honour \n / \t escapes; single quotes stay literal.
      return { key, value: quote === '"' ? quoted.replace(/\\([nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c])) : quoted };
    }
    value = value.slice(1); // unterminated quote: take the rest literally
  } else {
    // Unquoted: a # preceded by whitespace starts a comment.
    const comment = value.search(/\s#/);
    if (comment !== -1) value = value.slice(0, comment);
    value = value.trim();
  }
  return { key, value };
}

// Load a .env file into `env` (defaults to process.env). Exported so the tests
// run the real parser rather than a copy of it.
function loadEnvFile(envFile, env = process.env, log = console.log) {
  if (!fs.existsSync(envFile)) return { loaded: 0, withComments: 0 };

  let loaded = 0;
  let withComments = 0;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (/\s#/.test(line) || /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']/.test(line)) withComments += 1;
    // Values already in the environment (Docker, Vercel, a shell export) win.
    if (env[parsed.key] === undefined) {
      env[parsed.key] = parsed.value;
      loaded += 1;
    }
  }
  log(`Loaded environment from .env (${loaded} new variable${loaded === 1 ? '' : 's'}; values already in the shell win).`);
  if (withComments) log(`  (${withComments} line${withComments === 1 ? '' : 's'} had an inline comment — comments are stripped, not part of the value.)`);
  return { loaded, withComments };
}

module.exports = { parseEnvLine, loadEnvFile };

if (require.main === module) {
  loadEnvFile(path.join(__dirname, '..', '.env'));
  // This script is the entry module, so server.js's own `require.main === module`
  // guard is false and requiring it boots nothing. Call the exported starter
  // instead: without this, `npm run dev` printed "Loaded environment" and exited,
  // while the only command that did listen (`npm start`) never reads .env at all.
  require('../server.js').startServer();
}


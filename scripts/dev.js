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

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  console.log('Loaded environment from .env (values already in the shell win).');
}

require('../server.js');

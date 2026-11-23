// ================================================================
// KAGE Culture — Email transport configuration check
// ================================================================
// "Account created, but verification email is unavailable" was previously the
// only hint that mail was misconfigured, and a 201 order response said nothing
// at all. This module turns the environment into one explicit status object so
// the boot log, the admin diagnostics endpoint and the tests can all agree on
// what is wrong and what to do about it.
//
// It never prints or returns the SMTP password: only whether it is present and
// whether its shape looks like a Google App Password.
// ================================================================

const APP_PASSWORD_LENGTH = 16;

function describeMailConfig(env = process.env) {
  const host = String(env.SMTP_HOST || '').trim();
  const rawPort = String(env.SMTP_PORT || '').trim();
  const user = String(env.SMTP_USER || '').trim();
  const passRaw = String(env.SMTP_PASS || '');
  // Google shows app passwords as "abcd efgh ijkl mnop"; Nodemailer tolerates
  // the spaces, but a "# comment" or an account password never works.
  const pass = passRaw.replace(/\s+/g, '');
  const from = String(env.EMAIL_FROM || '').trim();
  const apiKey = String(env.EMAIL_API_KEY || '').trim();
  const siteUrl = String(env.SITE_URL || '').trim();

  const problems = [];
  const warnings = [];

  let transport = 'none';
  if (host) transport = 'smtp';
  else if (apiKey) transport = 'resend';

  if (transport === 'smtp') {
    if (/[\s#]/.test(host) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      problems.push(`SMTP_HOST "${host}" does not look like a hostname (a trailing "# comment" leaks in if .env is not parsed correctly).`);
    }
    if (rawPort) {
      const port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push(`SMTP_PORT "${rawPort}" is not a number between 1 and 65535 (a trailing "# comment" leaks in if .env is not parsed correctly).`);
      } else if (port === 25) {
        problems.push('SMTP_PORT 25 is blocked outbound by Vercel and most hosts; use 465 (implicit TLS) or 587 (STARTTLS).');
      }
    }
    if (!user) problems.push('SMTP_USER is empty: Gmail rejects an unauthenticated send.');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user) || /[\s#]/.test(user)) {
      problems.push(`SMTP_USER "${user}" is not a single email address.`);
    }
    if (!pass) problems.push('SMTP_PASS is empty: an App Password is required for SMTP auth.');
    else if (pass.includes('#')) {
      // A "#" can only be the leftover .env.example comment; no provider
      // issues those in a secret.
      problems.push('SMTP_PASS contains a "#": the "# comment" from .env.example was pasted as part of the value. Use the 16-character App Password alone.');
    } else if (/\s/.test(passRaw.trim())) {
      // Google DISPLAYS app passwords as "abcd efgh ijkl mnop". The spaces are
      // removed automatically and Nodemailer tolerates them, so this is a
      // pointer, not an error.
      if (pass.length !== APP_PASSWORD_LENGTH) {
        warnings.push(`SMTP_PASS contains spaces and is ${pass.length} characters without them; a Google App Password is exactly ${APP_PASSWORD_LENGTH}.`);
      }
    }
  } else if (transport === 'resend') {
    if (!apiKey.startsWith('re_')) warnings.push('EMAIL_API_KEY does not start with "re_" — check that it is a Resend API key.');
  } else {
    warnings.push('No email provider configured: SMTP_HOST and EMAIL_API_KEY are both empty, so messages are only logged to the console (dev mode).');
  }

  if (!siteUrl) {
    warnings.push('SITE_URL is not set: verification and password-reset emails are suppressed because their links need a stable public origin.');
  }

  const port = transport === 'smtp' ? (rawPort ? Number(rawPort) : 465) : null;

  return {
    transport,
    host: transport === 'smtp' ? host : null,
    port,
    secure: transport === 'smtp' ? port === 465 : null,
    user: user || null,
    hasPassword: Boolean(pass),
    passwordLooksLikeAppPassword: transport === 'smtp' ? pass.length === APP_PASSWORD_LENGTH : null,
    from: from || (transport === 'smtp' ? user || null : null),
    siteUrl: siteUrl || null,
    problems,
    warnings,
    ok: problems.length === 0 && transport !== 'none'
  };
}

// One-line boot summary. Never includes the password.
function formatMailConfigLine(status) {
  if (status.transport === 'smtp') {
    const secureLabel = status.port === 465 ? 'implicit TLS' : 'STARTTLS';
    const kind = status.passwordLooksLikeAppPassword ? 'App-Password-shaped secret' : 'secret';
    return `📧 Email: SMTP ${status.host}:${status.port} (${secureLabel}) as ${status.user || '(no user)'}, ${kind}`;
  }
  if (status.transport === 'resend') return '📧 Email: Resend HTTP API';
  return '📧 Email: NOT CONFIGURED — messages are logged to the console only (dev mode)';
}

module.exports = { describeMailConfig, formatMailConfigLine, APP_PASSWORD_LENGTH };

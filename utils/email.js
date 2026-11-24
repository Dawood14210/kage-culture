// ================================================================
// KAGE Culture — Email service
// ================================================================

const nodemailer = require('nodemailer');
const config = require('../config');
const { escapeHtml, stripHeaderChars } = require('./helpers');
const { DELIVERY_FEE_BAND } = require('../config');
const { getConfiguredSiteUrl } = require('./siteUrl');

// Links emailed to users require an explicitly configured public origin. Page
// rendering has a request-origin fallback; email links deliberately do not.
function buildLink(path, params) {
  const siteUrl = getConfiguredSiteUrl();
  if (!siteUrl) throw new Error('SITE_URL must be configured before building password-reset or verification email links.');
  const emailPath = String(path || '');
  if (!emailPath.startsWith('/')) throw new Error('Email link paths must start with /.');
  const query = Object.entries(params || {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${siteUrl}${emailPath}${query ? '?' + query : ''}`;
}

// A race protects the request even if a provider/transport does not honour
// its own timeout. onTimeout aborts fetch or closes the SMTP socket where
// possible; the provider promise is still observed by Promise.race if it later
// rejects after the caller has already moved on.
function withTimeout(operation, timeoutMs, onTimeout) {
  let timeoutId;
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      try { if (onTimeout) onTimeout(); } catch (_) { /* timeout still wins */ }
      reject(new Error(`Email send timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([operationPromise, timeoutPromise])
    .finally(() => clearTimeout(timeoutId));
}

function closeTransport(transport) {
  if (transport && typeof transport.close === 'function') {
    try { transport.close(); } catch (_) { /* best-effort cleanup */ }
  }
}

function smtpPort() {
  const rawPort = process.env.SMTP_PORT;
  if (!rawPort) return 465;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid TCP port number.');
  }
  return port;
}

async function sendSmtpEmail(to, subject, html) {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = smtpPort();
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const timeoutMs = config.EMAIL_SEND_TIMEOUT_MS;
  const transportOptions = {
    host,
    port,
    // Port 465 uses implicit TLS; other ports require STARTTLS (including Gmail's 587).
    secure: port === 465,
    requireTLS: port !== 465,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    auth: { user, pass }
  };

  const transport = nodemailer.createTransport(transportOptions);
  try {
    await withTimeout(
      () => transport.sendMail({
        from: process.env.EMAIL_FROM || user,
        to,
        subject,
        html
      }),
      timeoutMs,
      () => closeTransport(transport)
    );
    return true;
  } finally {
    closeTransport(transport);
  }
}

async function sendResendEmail(to, subject, html) {
  const controller = new AbortController();
  const resp = await withTimeout(
    () => fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'KAGE Culture <noreply@kage-culture.vercel.app>', to: [to], subject, html }),
      signal: controller.signal
    }),
    config.EMAIL_SEND_TIMEOUT_MS,
    () => controller.abort()
  );
  if (!resp.ok) throw new Error('Email API returned ' + resp.status);
  return true;
}

async function sendEmail(to, subject, html) {
  // SECURITY: a subject or recipient containing CR/LF could inject extra
  // headers. Values are stripped here as well as at construction time.
  const safeTo = stripHeaderChars(to);
  const safeSubject = stripHeaderChars(subject);
  const smtpHost = String(process.env.SMTP_HOST || '').trim();

  if (!smtpHost && !process.env.EMAIL_API_KEY) {
    // Dev mode: print the links as well as the text preview — the reset and
    // verification flows are unusable locally otherwise (the href is stripped
    // from the text preview). EMAIL_DEBUG_HTML dumps the raw body so the
    // escaping can be inspected (and rendered) locally.
    const links = [...String(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    console.log(`📧 Email (dev mode — not sent):\n  To: ${safeTo}\n  Subject: ${safeSubject}\n  Body preview: ${html.replace(/<[^>]*>/g, '').slice(0, 120)}...${links.length ? '\n  Links:\n' + links.map((l) => '    ' + l).join('\n') : ''}${process.env.EMAIL_DEBUG_HTML === 'true' ? '\n  HTML-BEGIN\n' + html + '\n  HTML-END' : ''}`);
    return true;
  }

  try {
    // SMTP takes precedence when configured; a failure is reported rather than
    // silently falling back to a different provider with different credentials.
    if (smtpHost) return await sendSmtpEmail(safeTo, safeSubject, html);
    return await sendResendEmail(safeTo, safeSubject, html);
  } catch (err) {
    console.warn('Email send failed:', err && err.message ? err.message : err);
    return false;
  }
}

// ================================================================
// EMAIL LAYOUT
// ----------------------------------------------------------------
// One shared skeleton for every transactional email, so a change lands in
// all of them at once. What this fixes over the old templates:
//   * no web-font dependency — 'Archivo' was never loaded in mail clients,
//     so text rendered in an unpredictable fallback face;
//   * bigger type (16px body, 15px table cells) and generous line-height;
//   * readable, AA-contrast colours — the old #8A8578 on white was 3.68:1
//     and #504C47 on the #C4BEB0 panel was 4.6:1;
//   * table-based layout with explicit widths and role="presentation", which
//     is what Outlook and Gmail actually render consistently;
//   * light "paper" background (#EFEBE2) instead of the heavy olive canvas,
//     so the card reads as a document rather than a dimmed poster.
// Colours are the storefront brand tokens, darkened only where needed for
// contrast: INK #1A1815 on white is 17.7:1, MUTED #5A5445 is 7.5:1.
// ================================================================
const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const EMAIL_INK = '#1A1815';
const EMAIL_MUTED = '#5A5445';
const EMAIL_ACCENT = '#4A4433';
const EMAIL_PANEL = '#EDE9DF';
const EMAIL_BORDER = '#DCD5C6';
const EMAIL_PAGE = '#EFEBE2';

// Wraps body rows in the branded card. `preheader` is the grey preview line
// mail clients show next to the subject; keep it short.
function emailShell({ title, kicker, preheader, body, footerNote }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${EMAIL_PAGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader || ''}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_PAGE};">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid ${EMAIL_BORDER};border-radius:14px;">
          <tr>
            <td style="height:4px;background:${EMAIL_ACCENT};border-radius:14px 14px 0 0;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:32px 32px 8px;font-family:${EMAIL_FONT};">
              <p style="margin:0;font-size:20px;line-height:1.2;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_INK};">KAGE Culture</p>
              ${kicker ? `<p style="margin:6px 0 0;font-size:13px;line-height:1.4;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:${EMAIL_MUTED};">${kicker}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 32px;font-family:${EMAIL_FONT};font-size:16px;line-height:1.65;color:${EMAIL_INK};">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 24px;border-top:1px solid ${EMAIL_BORDER};font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:${EMAIL_MUTED};">
              ${footerNote || ''}
              <p style="margin:8px 0 0;">Need help? Reply to this email or message us on WhatsApp.</p>
              <p style="margin:8px 0 0;color:${EMAIL_MUTED};">KAGE Culture · Cash on delivery across Pakistan · 7-day returns</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// A paragraph in the email body.
function emailPara(text, { mt = 16 } = {}) {
  return `<p style="margin:${mt}px 0 0;font-size:16px;line-height:1.65;color:${EMAIL_INK};">${text}</p>`;
}

// The olive-tinted callout panel (status badge, order number, totals…).
function emailPanel(inner, { align = 'center' } = {}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;background:${EMAIL_PANEL};border:1px solid ${EMAIL_BORDER};border-radius:10px;">
    <tr><td align="${align}" style="padding:18px 20px;font-family:${EMAIL_FONT};text-align:${align};">${inner}</td></tr>
  </table>`;
}

// A primary button. No border-radius on the <a> alone would be lost in
// Outlook, so the anchor carries its own padding and radius.
function emailButton(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
    <tr><td align="center" style="background:${EMAIL_ACCENT};border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:14px 28px;font-family:${EMAIL_FONT};font-size:15px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${label}</a>
    </td></tr>
  </table>`;
}

// Small print under a button, e.g. the "or paste this link" fallback.
function emailFinePrint(text, { mt = 16 } = {}) {
  return `<p style="margin:${mt}px 0 0;font-size:13px;line-height:1.6;color:${EMAIL_MUTED};">${text}</p>`;
}

// A plain-text link that survives clients stripping styles.
function emailLink(href, label) {
  return `<a href="${href}" style="color:${EMAIL_ACCENT};font-weight:700;text-decoration:underline;word-break:break-all;">${label}</a>`;
}

async function sendOrderConfirmation(order) {
  // Every interpolated value is escaped: names, sizes, addresses and payment
  // references all come from the checkout form.
  const cell = (extra = '') => `padding:12px 14px;border-bottom:1px solid ${EMAIL_BORDER};font-size:15px;line-height:1.5;color:${EMAIL_INK};${extra}`;
  const itemsList = (order.items || []).map(i => `<tr>` +
    `<td style="${cell('text-align:left;font-weight:600;')}">${escapeHtml(i.name)}</td>` +
    `<td style="${cell('text-align:left;')}">${escapeHtml(i.size)}</td>` +
    `<td style="${cell('text-align:center;')}">${escapeHtml(i.qty)}</td>` +
    `<td style="${cell('text-align:right;white-space:nowrap;')}">Rs. ${escapeHtml(i.total)}</td>` +
    `</tr>`).join('');
  const headCell = (align) => `padding:10px 14px;background:${EMAIL_PANEL};border-bottom:1px solid ${EMAIL_BORDER};font-size:12px;line-height:1.4;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${EMAIL_MUTED};text-align:${align};`;
  const payLabel = order.payment_method === 'bank' ? 'Bank Transfer' : order.payment_method === 'jazzcash' ? 'JazzCash' : 'Cash on Delivery';
  const payRef = order.payment_ref
    ? emailPara(`Payment reference: <strong>${escapeHtml(order.payment_ref)}</strong>`, { mt: 8 })
    : '';
  // D1 (CONV-1): the published Rs. 250–500 band; the exact fee is confirmed by phone before dispatch.
  const shippingLabel = order.shipping_pending ? `${DELIVERY_FEE_BAND} (confirmed by phone)` : `Rs. ${escapeHtml(order.shipping)}`;
  const totalLabel = order.shipping_pending ? 'Total (before delivery)' : 'Total';
  const deliveryContactNote = order.shipping_pending
    ? emailPara("We'll call you to confirm your order and the exact delivery charge before dispatch. You pay the total plus delivery in cash when it arrives.")
    : '';
  const body = [
    emailPara(`Hi ${escapeHtml(order.customer_name)},`, { mt: 0 }),
    emailPara(`Thanks for your order — <strong style="white-space:nowrap;">${escapeHtml(order.order_number)}</strong> is confirmed and we're getting it ready.`),
    emailPanel(
      `<p style="margin:0;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${EMAIL_MUTED};">Order number</p>
       <p style="margin:6px 0 0;font-size:22px;line-height:1.2;font-weight:800;letter-spacing:0.04em;color:${EMAIL_INK};white-space:nowrap;">${escapeHtml(order.order_number)}</p>`
    ),
    emailPara(`Payment method: <strong>${payLabel}</strong>`),
    payRef,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;border:1px solid ${EMAIL_BORDER};border-radius:10px;border-collapse:separate;">
      <tr>
        <th style="${headCell('left')}" align="left">Item</th>
        <th style="${headCell('left')}" align="left">Size</th>
        <th style="${headCell('center')}" align="center">Qty</th>
        <th style="${headCell('right')}" align="right">Total</th>
      </tr>
      ${itemsList}
      <tr>
        <td colspan="3" style="padding:12px 14px;font-size:15px;color:${EMAIL_MUTED};text-align:right;">Subtotal</td>
        <td style="padding:12px 14px;font-size:15px;color:${EMAIL_INK};text-align:right;white-space:nowrap;">Rs. ${escapeHtml(order.subtotal)}</td>
      </tr>
      <tr>
        <td colspan="3" style="padding:0 14px 12px;font-size:15px;color:${EMAIL_MUTED};text-align:right;">Delivery charge</td>
        <td style="padding:0 14px 12px;font-size:15px;color:${EMAIL_INK};text-align:right;">${shippingLabel}</td>
      </tr>
      <tr>
        <td colspan="3" style="padding:14px;border-top:2px solid ${EMAIL_ACCENT};font-size:17px;font-weight:800;color:${EMAIL_INK};text-align:right;">${totalLabel}</td>
        <td style="padding:14px;border-top:2px solid ${EMAIL_ACCENT};font-size:17px;font-weight:800;color:${EMAIL_INK};text-align:right;white-space:nowrap;">Rs. ${escapeHtml(order.total)}</td>
      </tr>
    </table>`,
    deliveryContactNote,
    emailPara(`Delivering to: <strong>${escapeHtml(order.address)}, ${escapeHtml(order.city)}</strong>`)
  ].join('\n');
  const html = emailShell({
    title: `Order ${escapeHtml(order.order_number)} — KAGE Culture`,
    kicker: 'Order Confirmation',
    preheader: `Order ${escapeHtml(order.order_number)} received — we'll confirm the delivery charge by phone.`,
    body,
    footerNote: '<p style="margin:0;">This is an automated order confirmation from KAGE Culture.</p>'
  });
  await sendEmail(order.email, `Order ${stripHeaderChars(order.order_number)} — KAGE Culture`, html);
}

async function sendStatusUpdate(order, oldStatus) {
  const statusLabels = { pending: 'Pending', awaiting_verification: 'Awaiting Payment Verification', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
  const label = statusLabels[order.status] || order.status;
  // A deep link only when the public origin is configured — never a guess.
  const siteUrl = getConfiguredSiteUrl();
  const trackUrl = siteUrl ? escapeHtml(`${siteUrl}/tracking`) : '';
  // One line of plain language under the badge, so the status means something
  // without the customer having to interpret a single word.
  const statusBlurb = {
    pending: "We've received your order and it's waiting to be packed.",
    awaiting_verification: "We're checking your payment. Your order ships as soon as it clears.",
    confirmed: 'Your order is confirmed and being prepared for dispatch.',
    shipped: "Your order is on its way. Our courier will call before delivery.",
    delivered: 'Your order has been delivered. Thanks for shopping with KAGE Culture.',
    cancelled: 'Your order was cancelled. Reply to this email if that is unexpected.'
  }[order.status] || '';
  const body = [
    emailPara(`Hi ${escapeHtml(order.customer_name)},`, { mt: 0 }),
    emailPara(`There's an update on order <strong style="white-space:nowrap;">${escapeHtml(order.order_number)}</strong>.`),
    emailPanel(
      `<p style="margin:0;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${EMAIL_MUTED};">New status</p>
       <p style="margin:8px 0 0;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${EMAIL_INK};">${escapeHtml(label)}</p>
       ${statusBlurb ? `<p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:${EMAIL_MUTED};">${escapeHtml(statusBlurb)}</p>` : ''}`
    ),
    emailPara(`Order number: <strong style="white-space:nowrap;">${escapeHtml(order.order_number)}</strong>`),
    trackUrl ? emailButton(trackUrl, 'Track Order') : '',
    emailFinePrint('You can follow this order any time from <strong>Track Order</strong> on the site — you will need the order number and the phone number you ordered with.')
  ].join('\n');
  const html = emailShell({
    title: `Order ${escapeHtml(order.order_number)} — ${escapeHtml(label)} — KAGE Culture`,
    kicker: 'Order Status Update',
    preheader: `Order ${escapeHtml(order.order_number)} is now ${escapeHtml(label)}.`,
    body,
    footerNote: '<p style="margin:0;">This is an automated update from KAGE Culture.</p>'
  });
  await sendEmail(order.email, `Order ${stripHeaderChars(order.order_number)} — ${stripHeaderChars(statusLabels[order.status] || order.status)} — KAGE Culture`, html);
}

async function sendVerificationEmail(customer, verifyUrl) {
  const name = escapeHtml((customer && customer.name) || 'there');
  // The URL is built from an explicitly configured SITE_URL plus a server token.
  const safeUrl = escapeHtml(verifyUrl);
  const body = [
    emailPara(`Hi ${name},`, { mt: 0 }),
    emailPara('Confirm this email address to see your order history and keep your account secure. The link expires in 24 hours.'),
    emailButton(safeUrl, 'Verify Email'),
    emailFinePrint('Button not working? Paste this link into your browser:'),
    emailFinePrint(emailLink(safeUrl, safeUrl), { mt: 6 })
  ].join('\n');
  const html = emailShell({
    title: 'Verify your KAGE Culture email',
    kicker: 'Verify Your Email',
    preheader: 'One tap to verify your email and unlock your order history.',
    body,
    footerNote: "<p style=\"margin:0;\">If you didn't create a KAGE Culture account, you can safely ignore this email.</p>"
  });
  return sendEmail(customer && customer.email, 'Verify your KAGE Culture email', html);
}

// Shared by the customer and admin reset flows (routes/auth.js builds the link).
function passwordResetEmailHtml(resetUrl, { minLength } = {}) {
  const safeUrl = escapeHtml(resetUrl);
  const body = [
    emailPara("We received a request to reset your KAGE Culture password. Choose a new one with the button below — the link expires in 1 hour and can only be used once.", { mt: 0 }),
    emailButton(safeUrl, 'Reset Password'),
    emailFinePrint('Button not working? Paste this link into your browser:'),
    emailFinePrint(emailLink(safeUrl, safeUrl), { mt: 6 }),
    emailFinePrint(minLength ? `Your new password must be at least ${minLength} characters long.` : '')
  ].join('\n');
  return emailShell({
    title: 'Reset your KAGE Culture password',
    kicker: 'Password Reset',
    preheader: 'Reset your KAGE Culture password — the link expires in 1 hour.',
    body,
    footerNote: "<p style=\"margin:0;\">If you didn't request this, you can safely ignore this email — your password stays unchanged.</p>"
  });
}

// Proves the configured transport can actually authenticate, without sending
// mail to a customer. Used by the admin diagnostics endpoint; the error message
// (never the password) is returned so the operator can act on it.
async function verifyEmailTransport() {
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  if (!smtpHost) {
    if (process.env.EMAIL_API_KEY) return { ok: true, detail: 'Resend API key configured (HTTP API; no handshake to verify).' };
    return { ok: false, detail: 'No provider configured: set SMTP_HOST (+ SMTP_USER/SMTP_PASS) or EMAIL_API_KEY.' };
  }
  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort(),
    secure: smtpPort() === 465,
    requireTLS: smtpPort() !== 465,
    connectionTimeout: config.EMAIL_SEND_TIMEOUT_MS,
    greetingTimeout: config.EMAIL_SEND_TIMEOUT_MS,
    socketTimeout: config.EMAIL_SEND_TIMEOUT_MS,
    auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' }
  });
  try {
    await withTimeout(() => transport.verify(), config.EMAIL_SEND_TIMEOUT_MS, () => closeTransport(transport));
    return { ok: true, detail: `SMTP ${smtpHost}:${smtpPort()} authenticated successfully.` };
  } catch (err) {
    return { ok: false, detail: err && err.message ? err.message : String(err) };
  } finally {
    closeTransport(transport);
  }
}

module.exports = { sendEmail, sendOrderConfirmation, sendStatusUpdate, sendVerificationEmail, passwordResetEmailHtml, emailShell, verifyEmailTransport, escapeHtml, stripHeaderChars, buildLink };

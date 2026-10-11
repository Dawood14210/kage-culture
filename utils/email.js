// ================================================================
// KAGE Culture — Email service
// ================================================================

const { escapeHtml, stripHeaderChars } = require('./helpers');

// Links emailed to users are built from SITE_URL plus a server-generated,
// URL-encoded token — never from anything a requester supplied.
const SITE_URL = () => process.env.SITE_URL || 'https://kage-culture-ruby.vercel.app';
function buildLink(path, params) {
  const query = Object.entries(params || {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${SITE_URL()}${path}${query ? '?' + query : ''}`;
}

async function sendEmail(to, subject, html) {
  // SECURITY: a subject or recipient containing CR/LF could inject extra
  // headers. Values are stripped here as well as at construction time.
  const safeTo = stripHeaderChars(to);
  const safeSubject = stripHeaderChars(subject);
  if (!process.env.EMAIL_API_KEY) {
    // Dev mode: print the links as well as the text preview — the reset and
    // verification flows are unusable locally otherwise (the href is stripped
    // from the text preview). EMAIL_DEBUG_HTML dumps the raw body so the
    // escaping can be inspected (and rendered) locally.
    const links = [...String(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    console.log(`📧 Email (dev mode — not sent):\n  To: ${safeTo}\n  Subject: ${safeSubject}\n  Body preview: ${html.replace(/<[^>]*>/g, '').slice(0, 120)}...${links.length ? '\n  Links:\n' + links.map((l) => '    ' + l).join('\n') : ''}${process.env.EMAIL_DEBUG_HTML === 'true' ? '\n  HTML-BEGIN\n' + html + '\n  HTML-END' : ''}`);
    return true;
  }
  try {
    const resendKey = process.env.EMAIL_API_KEY;
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'KAGE Culture <noreply@kage-culture.vercel.app>', to: [safeTo], subject: safeSubject, html })
    });
    if (!resp.ok) throw new Error('Email API returned ' + resp.status);
    return true;
  } catch (err) {
    console.error('Email send failed:', err.message);
    return false;
  }
}

async function sendOrderConfirmation(order) {
  // Every interpolated value is escaped: names, sizes, addresses and payment
  // references all come from the checkout form.
  const itemsList = (order.items || []).map(i => `<tr><td style="padding:6px 12px;border:1px solid #D9D4C8;">${escapeHtml(i.name)}</td><td style="padding:6px 12px;border:1px solid #D9D4C8;">${escapeHtml(i.size)}</td><td style="padding:6px 12px;border:1px solid #D9D4C8;text-align:center;">${escapeHtml(i.qty)}</td><td style="padding:6px 12px;border:1px solid #D9D4C8;text-align:right;">Rs. ${escapeHtml(i.total)}</td></tr>`).join('');
  const payLabel = order.payment_method === 'bank' ? 'Bank Transfer' : order.payment_method === 'jazzcash' ? 'JazzCash' : 'Cash on Delivery';
  const payRef = order.payment_ref ? `<p style="color:#504C47;font-size:14px;">Payment Reference: <strong>${escapeHtml(order.payment_ref)}</strong></p>` : '';
  const shippingLabel = order.shipping_pending ? 'To be confirmed' : `Rs. ${escapeHtml(order.shipping)}`;
  const totalLabel = order.shipping_pending ? 'Items subtotal (delivery charge pending)' : 'Total';
  const deliveryContactNote = order.shipping_pending ? '<p style="font-size:13px;color:#504C47;margin-top:16px;">We will contact you about the delivery charges and confirm the final amount.</p>' : '';
  const html = `
  <div style="font-family:'Archivo',Arial,sans-serif;background:#D9D4C8;padding:32px;color:#1A1815;">
    <div style="max-width:560px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #BDB6A6;">
      <h1 style="font-size:24px;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 4px;color:#4A4433;">KAGE Culture</h1>
      <p style="color:#7A7468;font-size:13px;margin:0 0 24px;">Order Confirmation</p>
      <p style="font-size:15px;color:#1A1815;">Hi ${escapeHtml(order.customer_name)},</p>
      <p style="font-size:15px;color:#3D3931;line-height:1.6;">Your order <strong>${escapeHtml(order.order_number)}</strong> has been placed successfully.</p>
      <div style="margin:20px 0;padding:16px;background:#C4BEB0;border-radius:8px;">
        <p style="font-size:13px;color:#504C47;margin:0 0 4px;">Order Number</p>
        <p style="font-size:18px;font-weight:700;margin:0;color:#1A1815;">${escapeHtml(order.order_number)}</p>
      </div>
      <p style="font-size:13px;color:#504C47;margin:0 0 8px;">Payment Method: <strong>${payLabel}</strong></p>
      ${payRef}
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead><tr><th style="padding:6px 12px;border:1px solid #D9D4C8;text-align:left;font-size:12px;color:#7A7468;">Item</th><th style="padding:6px 12px;border:1px solid #D9D4C8;text-align:left;font-size:12px;color:#7A7468;">Size</th><th style="padding:6px 12px;border:1px solid #D9D4C8;text-align:center;font-size:12px;color:#7A7468;">Qty</th><th style="padding:6px 12px;border:1px solid #D9D4C8;text-align:right;font-size:12px;color:#7A7468;">Total</th></tr></thead>
        <tbody>${itemsList}</tbody>
      </table>
      <p style="font-size:14px;color:#1A1815;">Subtotal: Rs. ${escapeHtml(order.subtotal)}</p>
      <p style="font-size:14px;color:#1A1815;">Delivery charge: ${shippingLabel}</p>
      <p style="font-size:18px;font-weight:700;color:#4A4433;border-top:2px solid #BDB6A6;padding-top:12px;margin-top:12px;">${totalLabel}: Rs. ${escapeHtml(order.total)}</p>
      ${deliveryContactNote}
      <p style="font-size:13px;color:#504C47;margin-top:16px;">Ship to: ${escapeHtml(order.address)}, ${escapeHtml(order.city)}</p>
      <p style="font-size:12px;color:#8A8578;margin-top:24px;">This is an automated order confirmation from KAGE Culture.</p>
    </div>
  </div>`;
  await sendEmail(order.email, `Order ${stripHeaderChars(order.order_number)} — KAGE Culture`, html);
}

async function sendStatusUpdate(order, oldStatus) {
  const statusLabels = { pending: 'Pending', awaiting_verification: 'Awaiting Payment Verification', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
  const html = `
  <div style="font-family:'Archivo',Arial,sans-serif;background:#D9D4C8;padding:32px;color:#1A1815;">
    <div style="max-width:560px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #BDB6A6;">
      <h1 style="font-size:24px;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 4px;color:#4A4433;">KAGE Culture</h1>
      <p style="color:#7A7468;font-size:13px;margin:0 0 24px;">Order Status Update</p>
      <p style="font-size:15px;color:#1A1815;">Hi ${escapeHtml(order.customer_name)},</p>
      <p style="font-size:15px;color:#3D3931;line-height:1.6;">Your order <strong>${escapeHtml(order.order_number)}</strong> has been updated.</p>
      <div style="margin:20px 0;padding:16px;background:#C4BEB0;border-radius:8px;text-align:center;">
        <p style="font-size:13px;color:#504C47;margin:0 0 4px;">New Status</p>
        <p style="font-size:22px;font-weight:700;margin:0;color:#4A4433;text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(statusLabels[order.status] || order.status)}</p>
      </div>
      <p style="font-size:12px;color:#8A8578;margin-top:24px;">This is an automated update from KAGE Culture.</p>
    </div>
  </div>`;
  await sendEmail(order.email, `Order ${stripHeaderChars(order.order_number)} — ${stripHeaderChars(statusLabels[order.status] || order.status)} — KAGE Culture`, html);
}

async function sendVerificationEmail(customer, verifyUrl) {
  const name = escapeHtml((customer && customer.name) || 'there');
  // The URL is server-built (SITE_URL + hex token) and escaped for the href.
  const safeUrl = escapeHtml(verifyUrl);
  const html = `
  <div style="font-family:'Archivo',Arial,sans-serif;background:#D9D4C8;padding:32px;color:#1A1815;">
    <div style="max-width:560px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #BDB6A6;">
      <h1 style="font-size:24px;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 4px;color:#4A4433;">KAGE Culture</h1>
      <p style="color:#7A7468;font-size:13px;margin:0 0 24px;">Verify Your Email</p>
      <p style="font-size:15px;color:#1A1815;">Hi ${name},</p>
      <p style="font-size:15px;color:#3D3931;line-height:1.6;">Confirm this email address to see your order history and keep your account secure. This link expires in 24 hours.</p>
      <a href="${safeUrl}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#4A4433;color:#FFF;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.06em;text-transform:uppercase;border-radius:8px;">Verify Email</a>
      <p style="font-size:12px;color:#8A8578;margin-top:24px;">If you didn't create a KAGE Culture account, you can safely ignore this email.</p>
    </div>
  </div>`;
  return sendEmail(customer && customer.email, 'Verify your KAGE Culture email', html);
}

module.exports = { sendEmail, sendOrderConfirmation, sendStatusUpdate, sendVerificationEmail, escapeHtml, stripHeaderChars, buildLink, SITE_URL };

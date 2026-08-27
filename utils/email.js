// ================================================================
// KAGE Culture — Email service
// ================================================================

async function sendEmail(to, subject, html) {
  if (!process.env.EMAIL_API_KEY) {
    console.log(`📧 Email (dev mode — not sent):\n  To: ${to}\n  Subject: ${subject}\n  Body preview: ${html.replace(/<[^>]*>/g, '').slice(0, 120)}...`);
    return true;
  }
  try {
    const resendKey = process.env.EMAIL_API_KEY;
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'KAGE Culture <noreply@kage-culture.vercel.app>', to: [to], subject, html })
    });
    if (!resp.ok) throw new Error('Email API returned ' + resp.status);
    return true;
  } catch (err) {
    console.error('Email send failed:', err.message);
    return false;
  }
}

async function sendOrderConfirmation(order) {
  const itemsList = (order.items || []).map(i => `<tr><td style="padding:6px 12px;border:1px solid #D9D4C8;">${i.name}</td><td style="padding:6px 12px;border:1px solid #D9D4C8;">${i.size}</td><td style="padding:6px 12px;border:1px solid #D9D4C8;text-align:center;">${i.qty}</td><td style="padding:6px 12px;border:1px solid #D9D4C8;text-align:right;">Rs. ${i.total}</td></tr>`).join('');
  const payLabel = order.payment_method === 'bank' ? 'Bank Transfer' : order.payment_method === 'jazzcash' ? 'JazzCash' : 'Cash on Delivery';
  const payRef = order.payment_ref ? `<p style="color:#504C47;font-size:14px;">Payment Reference: <strong>${order.payment_ref}</strong></p>` : '';
  const html = `
  <div style="font-family:'Archivo',Arial,sans-serif;background:#D9D4C8;padding:32px;color:#1A1815;">
    <div style="max-width:560px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #BDB6A6;">
      <h1 style="font-size:24px;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 4px;color:#4A4433;">KAGE Culture</h1>
      <p style="color:#7A7468;font-size:13px;margin:0 0 24px;">Order Confirmation</p>
      <p style="font-size:15px;color:#1A1815;">Hi ${order.customer_name},</p>
      <p style="font-size:15px;color:#3D3931;line-height:1.6;">Your order <strong>${order.order_number}</strong> has been placed successfully.</p>
      <div style="margin:20px 0;padding:16px;background:#C4BEB0;border-radius:8px;">
        <p style="font-size:13px;color:#504C47;margin:0 0 4px;">Order Number</p>
        <p style="font-size:18px;font-weight:700;margin:0;color:#1A1815;">${order.order_number}</p>
      </div>
      <p style="font-size:13px;color:#504C47;margin:0 0 8px;">Payment Method: <strong>${payLabel}</strong></p>
      ${payRef}
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead><tr><th style="padding:6px 12px;border:1px solid #D9D4C8;text-align:left;font-size:12px;color:#7A7468;">Item</th><th style="padding:6px 12px;border:1px solid #D9D4C8;text-align:left;font-size:12px;color:#7A7468;">Size</th><th style="padding:6px 12px;border:1px solid #D9D4C8;text-align:center;font-size:12px;color:#7A7468;">Qty</th><th style="padding:6px 12px;border:1px solid #D9D4C8;text-align:right;font-size:12px;color:#7A7468;">Total</th></tr></thead>
        <tbody>${itemsList}</tbody>
      </table>
      <p style="font-size:14px;color:#1A1815;">Subtotal: Rs. ${order.subtotal}</p>
      <p style="font-size:14px;color:#1A1815;">Shipping: Rs. ${order.shipping}</p>
      <p style="font-size:18px;font-weight:700;color:#4A4433;border-top:2px solid #BDB6A6;padding-top:12px;margin-top:12px;">Total: Rs. ${order.total}</p>
      <p style="font-size:13px;color:#504C47;margin-top:16px;">Ship to: ${order.address}, ${order.city}</p>
      <p style="font-size:12px;color:#8A8578;margin-top:24px;">This is an automated order confirmation from KAGE Culture.</p>
    </div>
  </div>`;
  await sendEmail(order.email, `Order ${order.order_number} — KAGE Culture`, html);
}

async function sendStatusUpdate(order, oldStatus) {
  const statusLabels = { pending: 'Pending', awaiting_verification: 'Awaiting Payment Verification', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
  const html = `
  <div style="font-family:'Archivo',Arial,sans-serif;background:#D9D4C8;padding:32px;color:#1A1815;">
    <div style="max-width:560px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #BDB6A6;">
      <h1 style="font-size:24px;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 4px;color:#4A4433;">KAGE Culture</h1>
      <p style="color:#7A7468;font-size:13px;margin:0 0 24px;">Order Status Update</p>
      <p style="font-size:15px;color:#1A1815;">Hi ${order.customer_name},</p>
      <p style="font-size:15px;color:#3D3931;line-height:1.6;">Your order <strong>${order.order_number}</strong> has been updated.</p>
      <div style="margin:20px 0;padding:16px;background:#C4BEB0;border-radius:8px;text-align:center;">
        <p style="font-size:13px;color:#504C47;margin:0 0 4px;">New Status</p>
        <p style="font-size:22px;font-weight:700;margin:0;color:#4A4433;text-transform:uppercase;letter-spacing:0.06em;">${statusLabels[order.status] || order.status}</p>
      </div>
      <p style="font-size:12px;color:#8A8578;margin-top:24px;">This is an automated update from KAGE Culture.</p>
    </div>
  </div>`;
  await sendEmail(order.email, `Order ${order.order_number} — ${statusLabels[order.status] || order.status} — KAGE Culture`, html);
}

module.exports = { sendEmail, sendOrderConfirmation, sendStatusUpdate };

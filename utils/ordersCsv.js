// ================================================================
// KAGE Culture — one RFC 4180 / spreadsheet-safe orders CSV writer
// ----------------------------------------------------------------
// Shared by the admin export endpoint and the mandatory backup written
// before a clear-all-orders run. csvCell defuses spreadsheet formulas
// (= + - @ and leading tab/CR); money columns are quoted only when the
// value is not a finite number.
// ================================================================
const { csvCell } = require('./helpers');

function ordersToCsv(orders) {
  const csvNumber = (value) => {
    if (value === null || value === undefined || value === '') return '';
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : csvCell(value);
  };
  const header = ['Order Number', 'Customer Name', 'Email', 'Phone', 'Address', 'City',
    'Payment Method', 'Payment Reference', 'COD Confirmed', 'Subtotal', 'Shipping',
    'Delivery Charge Pending', 'Total', 'Status', 'Created At', 'Notes'].map(csvCell).join(',');
  const rows = orders.map(o => [
    csvCell(o.order_number), csvCell(o.customer_name), csvCell(o.email), csvCell(o.phone),
    csvCell(o.address), csvCell(o.city), csvCell(o.payment_method), csvCell(o.payment_ref),
    csvCell(o.cod_confirmed ? 'Yes' : 'No'), csvNumber(o.subtotal), csvNumber(o.shipping),
    csvCell(o.shipping_pending && o.status !== 'cancelled' ? 'Yes' : 'No'), csvNumber(o.total),
    csvCell(o.status), csvCell(o.created_at), csvCell(o.notes)
  ].join(','));
  // BOM so Excel reads non-ASCII names; CRLF is the RFC 4180 line ending.
  return '\uFEFF' + header + '\r\n' + (rows.length ? rows.join('\r\n') + '\r\n' : '');
}

module.exports = { ordersToCsv };

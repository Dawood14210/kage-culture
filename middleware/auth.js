// ================================================================
// KAGE Culture — Authentication middleware
// ================================================================

function requireAuth(req, res, next) {
  const adminId = req.session && req.session.adminId;
  if (adminId) {
    req.adminId = adminId;
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
}

/**
 * Best-effort customer id for public routes (order placement): returns the
 * signed-in customer's id, or null. Never rejects — an anonymous visitor must
 * still be able to place an order.
 */
function optionalCustomerId(req) {
  return (req.session && req.session.customerId) || null;
}

function requireCustomerAuth(req, res, next) {
  const customerId = req.session && req.session.customerId;
  if (customerId) {
    req.customerId = customerId;
    next();
  } else {
    res.status(401).json({ error: 'Please log in to continue.' });
  }
}

module.exports = { requireAuth, requireCustomerAuth, optionalCustomerId };

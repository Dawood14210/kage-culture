// ================================================================
// KAGE Culture — Authentication middleware
// ================================================================
const { parseCookies } = require('../utils/helpers');

function requireAuth(req, res, next) {
  let adminId = req.session && req.session.adminId;
  if (!adminId) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionVal = cookies['kage.session'];
    if (sessionVal) {
      try {
        const parts = sessionVal.split('.');
        const data = JSON.parse(Buffer.from(parts[0], 'base64').toString());
        adminId = data.adminId;
      } catch (e) { /* invalid cookie */ }
    }
  }
  if (adminId) {
    req.adminId = adminId;
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
}

function requireCustomerAuth(req, res, next) {
  let customerId = req.session && req.session.customerId;
  if (!customerId) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionVal = cookies['kage.cust'];
    if (sessionVal) {
      try {
        const parts = sessionVal.split('.');
        const data = JSON.parse(Buffer.from(parts[0], 'base64').toString());
        customerId = data.customerId;
      } catch (e) { /* invalid cookie */ }
    }
  }
  if (customerId) {
    req.customerId = customerId;
    next();
  } else {
    res.status(401).json({ error: 'Please log in to continue.' });
  }
}

module.exports = { requireAuth, requireCustomerAuth };

// ================================================================
// KAGE Culture — Rate limiters
// ================================================================
const rateLimit = require('express-rate-limit');
const config = require('../config');

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.RATE_LIMIT_GLOBAL,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.RATE_LIMIT_STRICT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.RATE_LIMIT_ORDERS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many order attempts. Please try again later.' }
});

const resetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.RATE_LIMIT_RESET,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Please try again later.' }
});

module.exports = { globalLimiter, strictLimiter, orderLimiter, resetLimiter };

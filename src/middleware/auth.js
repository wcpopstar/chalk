const jwt = require('jsonwebtoken');
const { sendError } = require('../utils/http');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return sendError(res, 401, 'Missing or malformed Authorization header');
  }

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (_) {
    return sendError(res, 401, 'Invalid or expired token');
  }
}

function optionalAuth(req, _res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    } catch (_) { /* ignore */ }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };

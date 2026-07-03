const { verifyAccessToken } = require('../utils/jwt');
const tokenBlacklist = require('../services/tokenBlacklist');
const { sendError } = require('../utils/http');

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

// Verifies signature/issuer/audience/expiry via jsonwebtoken, then checks the
// blacklist for tokens that were explicitly revoked (logout, logout-all,
// refresh-token-reuse response) before their natural expiry.
function verify(token) {
  const payload = verifyAccessToken(token); // throws JsonWebTokenError / TokenExpiredError
  if (tokenBlacklist.isRevoked(payload.jti)) {
    const err = new Error('Token has been revoked');
    err.code = 'TOKEN_REVOKED';
    throw err;
  }
  return payload;
}

// ── requireAuth ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return sendError(res, 401, 'Missing or malformed Authorization header');
  }

  try {
    req.user = verify(token);
    req.accessToken = token;
    return next();
  } catch (err) {
    if (err.code === 'TOKEN_REVOKED') {
      return sendError(res, 401, 'Token has been revoked', { code: 'TOKEN_REVOKED' });
    }
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 401, 'Token expired', { code: 'TOKEN_EXPIRED' });
    }
    return sendError(res, 401, 'Invalid or expired token');
  }
}

// ── optionalAuth ─────────────────────────────────────────────────────────────
// Populates req.user when a valid token is present, but never blocks the
// request — used by endpoints that behave differently for logged-in users
// without requiring login (e.g. logout, which should still 200 for a client
// whose token already expired).
function optionalAuth(req, _res, next) {
  const token = extractBearerToken(req);
  if (token) {
    try {
      req.user = verify(token);
      req.accessToken = token;
    } catch (_) {
      /* ignore — treated as anonymous */
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth, extractBearerToken };

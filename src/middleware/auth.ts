import { verifyAccessToken } from '../utils/jwt';
import tokenBlacklist from '../services/tokenBlacklist';
import { sendError } from '../utils/http';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'auth-middleware' });

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractBearerToken(req: any) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

// Verifies signature/issuer/audience/expiry via jsonwebtoken, then checks the
// blacklist for tokens that were explicitly revoked (logout, logout-all,
// refresh-token-reuse response) before their natural expiry.
function verify(token: any) {
  const payload = verifyAccessToken(token); // throws JsonWebTokenError / TokenExpiredError
  if (tokenBlacklist.isRevoked(payload.jti)) {
    const err: any = new Error('Token has been revoked');
    err.code = 'TOKEN_REVOKED';
    throw err;
  }
  return payload;
}

// ── requireAuth ──────────────────────────────────────────────────────────────
function requireAuth(req: any, res: any, next: any) {
  const token = extractBearerToken(req);
  if (!token) {
    return sendError(res, 401, 'Missing or malformed Authorization header');
  }

  try {
    req.user = verify(token);
    req.accessToken = token;
    return next();
  } catch (err: any) {
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
function optionalAuth(req: any, _res: any, next: any) {
  const token = extractBearerToken(req);
  if (token) {
    try {
      req.user = verify(token);
      req.accessToken = token;
    } catch (err: any) {
      // Expected/routine, not an error: an expired or malformed token on an
      // optional-auth route just means "treat as anonymous" — that's the
      // whole point of this middleware. Debug-level only (no Sentry, no
      // app_errors_total) so it doesn't create alert noise, but it's no
      // longer completely invisible if you're debugging an auth issue.
      logger.debug({ err }, 'optionalAuth: token present but invalid, continuing as anonymous');
    }
  }
  next();
}

export { requireAuth, optionalAuth, extractBearerToken };

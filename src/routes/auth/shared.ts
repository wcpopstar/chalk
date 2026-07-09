import type { Request } from 'express';
import type { UserRow } from '../../types/db';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createRateLimitStore } = require('../../middleware/rateLimit');
const { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } = require('../../utils/jwt');
const { issueRefreshToken } = require('../../services/refreshTokens');
const tokenBlacklist = require('../../services/tokenBlacklist');

const USER_FIELDS =
  'id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, presence, created_at';

// Strict rate limit for auth endpoints, keyed by IP
const authLimiter = rateLimit({
  store: createRateLimitStore(),
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, try again later.' },
});

// Additional limit on /login keyed by the email being attempted, so an
// attacker can't bypass the IP limit by rotating IPs against one account.
const loginEmailLimiter = rateLimit({
  store: createRateLimitStore(),
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : (req.ip as string)),
  message: { error: 'Слишком много попыток входа для этого email. Попробуй позже или сбрось пароль.' },
});

// Limit on /forgot-password keyed by email, so it can't be used to spam someone's inbox.
const forgotPasswordEmailLimiter = rateLimit({
  store: createRateLimitStore(),
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : (req.ip as string)),
  message: { error: 'Слишком много запросов на сброс пароля для этого email. Попробуй позже.' },
});

// Refresh/rotation gets its own generous-but-bounded limit, keyed by IP —
// it's hit far more often than login but should still be capped against abuse.
const refreshLimiter = rateLimit({
  store: createRateLimitStore(),
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many refresh attempts, try again later.' },
});

function hashToken(rawToken: string) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function requestMeta(req: Request) {
  return { userAgent: req.headers['user-agent'] || null, ip: req.ip };
}

// Issues a fresh access + refresh token pair for a user and shapes the
// standard auth response body.
async function issueSession(user: Pick<UserRow, 'id' | 'username'>, req: Request) {
  const { token, jti } = signAccessToken({ id: user.id, username: user.username });
  const { raw: refreshToken } = await issueRefreshToken(user.id, requestMeta(req));
  return { token, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, jti };
}

// Blacklists whatever access token authenticated the current request, if any
// — used by /logout and /logout-all so the token that's still "live" for up
// to 15 more minutes can't keep being used after the user asked to sign out.
function blacklistCurrentAccessToken(req: Request) {
  if (req.user?.jti && req.user?.exp) {
    tokenBlacklist.revoke(req.user.jti, req.user.exp * 1000);
  }
}

export {
  USER_FIELDS,
  authLimiter,
  loginEmailLimiter,
  forgotPasswordEmailLimiter,
  refreshLimiter,
  hashToken,
  requestMeta,
  issueSession,
  blacklistCurrentAccessToken,
};

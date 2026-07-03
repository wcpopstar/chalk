const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────
// Access tokens are short-lived JWTs used for API/socket auth. Refresh tokens
// are long-lived opaque secrets (never JWTs — see services/refreshTokens.js)
// used only to mint new access tokens.
const ISSUER = 'chalk-backend';
const AUDIENCE = 'chalk-app';

const ACCESS_TOKEN_TTL = '15m';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Access tokens (JWT) ──────────────────────────────────────────────────────
function signAccessToken({ id, username }) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { id, username },
    process.env.JWT_SECRET,
    {
      expiresIn: ACCESS_TOKEN_TTL,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: jti,
    }
  );
  return { token, jti, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

// Throws jwt.JsonWebTokenError / jwt.TokenExpiredError on bad tokens — callers
// should catch and translate, never assume this always resolves.
function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

// ── Refresh tokens (opaque, random — not JWTs) ───────────────────────────────
// Opaque tokens carry no claims of their own, so a leaked one is useless
// without the DB row backing it, and it's trivial to revoke by hash.
function generateOpaqueToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashOpaqueToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

module.exports = {
  ISSUER,
  AUDIENCE,
  ACCESS_TOKEN_TTL,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  signAccessToken,
  verifyAccessToken,
  generateOpaqueToken,
  hashOpaqueToken,
};

import type { JwtPayload } from '../socket/types';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/env';

// ── Config ──────────────────────────────────────────────────────────────────
// Access tokens are short-lived JWTs used for API/socket auth. Refresh tokens
// are long-lived opaque secrets (never JWTs — see services/refreshTokens.js)
// used only to mint new access tokens.
const ISSUER = 'chalk-backend';
const AUDIENCE = 'chalk-app';

const ACCESS_TOKEN_TTL = '15m';

// config.jwt.secret is `string | null` because env parsing can't prove it's
// set, but validateEnv() refuses to start the server without it — so by the
// time any token is signed or verified it is a string. Narrowed once here
// rather than cast at each of the four call sites below.
const JWT_SECRET = config.jwt.secret as string;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Access tokens (JWT) ──────────────────────────────────────────────────────
function signAccessToken({ id, username }: { id: string; username: string }): { token: string; jti: string; expiresIn: number } {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { id, username },
    JWT_SECRET,
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
function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as JwtPayload;
}

// ── Refresh tokens (opaque, random — not JWTs) ───────────────────────────────
// Opaque tokens carry no claims of their own, so a leaked one is useless
// without the DB row backing it, and it's trivial to revoke by hash.
function generateOpaqueToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

function hashOpaqueToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export {
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

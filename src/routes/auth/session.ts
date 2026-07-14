import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import * as usersRepository from '../../repositories/usersRepository';
import { requireAuth, optionalAuth } from '../../middleware/auth';
import { signAccessToken } from '../../utils/jwt';
import { rotateRefreshToken, revokeRefreshToken, revokeAllForUser, InvalidRefreshTokenError, TokenReuseError } from '../../services/refreshTokens';
import { refreshLimiter, requestMeta, blacklistCurrentAccessToken, bannedResponse } from './shared';
import { userLimiter } from '../../middleware/rateLimit';

// Session-lifecycle reads/writes after the initial refresh — loose (a page
// reload calls GET /me, logout is one-click) but not unbounded.
const sessionActionLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many requests, slow down.' });

// ── POST /api/auth/refresh ──────────────────────────────────────────────────
// Exchanges a refresh token for a new access + refresh token pair. The
// refresh token is single-use (rotation): the one presented here is revoked
// and a new one is issued in its place, even if the caller doesn't end up
// using the response. Presenting an already-rotated token is treated as
// theft and revokes every session descended from it (see refreshTokens.js).
/**
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Exchange a refresh token for a new session
 *     description: |
 *       The refresh token is **single-use** (rotation): the one presented here is revoked and a new one
 *       is issued in its place. Presenting an already-rotated (i.e. stolen/replayed) token is treated as
 *       theft and revokes every session descended from it — the caller must log in again.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New token pair issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { $ref: '#/components/schemas/AuthTokens/properties/token' }
 *                 refreshToken: { $ref: '#/components/schemas/AuthTokens/properties/refreshToken' }
 *                 expiresIn: { $ref: '#/components/schemas/AuthTokens/properties/expiresIn' }
 *       400:
 *         description: refreshToken missing from body
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: "Invalid/expired token, or reuse detected (code: TOKEN_REUSE) — session family revoked"
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const { raw: newRefreshToken, userId } = await rotateRefreshToken(refreshToken, requestMeta(req));

    const { data: user, error } = await usersRepository.findBasicById(userId);

    if (error || !user) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    // A ban must also cut off session refresh — otherwise a banned user could
    // keep minting fresh access tokens from a pre-ban refresh token.
    const banned = bannedResponse(user);
    if (banned) return res.status(403).json(banned);

    const { token, expiresIn } = signAccessToken({ id: user.id, username: user.username });
    return res.json({ token, refreshToken: newRefreshToken, expiresIn });
  } catch (err: any) {
    if (err instanceof TokenReuseError) {
      req.log.warn('Refresh token reuse detected — session family revoked');
      return res.status(401).json({ error: 'Session invalidated, please log in again', code: 'TOKEN_REUSE' });
    }
    if (err instanceof InvalidRefreshTokenError) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    req.log.error({ err }, 'Token refresh failed');
    return res.status(500).json({ error: 'Could not refresh session' });
  }
});

// ── POST /api/auth/logout ───────────────────────────────────────────────────
// Logs out the current device/session: revokes the refresh token it sent (if
// any) and blacklists whatever access token was still valid.
/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Log out the current device/session
 *     description: Revokes the supplied refresh token (if any) and blacklists the access token that authenticated this request. Works even with an expired/missing access token so a client can always clear its own session.
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string, description: 'This device''s refresh token, if known.' }
 *     responses:
 *       200:
 *         description: Logged out
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Ok' }
 */
router.post('/logout', optionalAuth, sessionActionLimiter, async (req: Request, res: Response) => {
  const { refreshToken } = req.body || {};

  if (refreshToken && typeof refreshToken === 'string') {
    await revokeRefreshToken(refreshToken);
  }
  blacklistCurrentAccessToken(req);

  if (req.user) {
    await usersRepository.setStatus(req.user.id, 'offline');
  }
  return res.json({ ok: true });
});

// ── POST /api/auth/logout-all ───────────────────────────────────────────────
// Revokes every refresh token for the account (all devices/sessions) — for
// "sign out everywhere" or when a user suspects their account is compromised.
/**
 * @openapi
 * /api/auth/logout-all:
 *   post:
 *     tags: [Auth]
 *     summary: Log out every device/session
 *     description: Revokes every refresh token for the account and blacklists the current access token — use for "sign out everywhere" or a suspected account compromise.
 *     responses:
 *       200:
 *         description: All sessions revoked
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       401:
 *         description: Missing/invalid access token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/logout-all', requireAuth, sessionActionLimiter, async (req: Request, res: Response) => {
  await revokeAllForUser(req.user.id);
  blacklistCurrentAccessToken(req);
  await usersRepository.setStatus(req.user.id, 'offline');
  return res.json({ ok: true });
});

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get the currently authenticated user's full profile
 *     responses:
 *       200:
 *         description: Current user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *       401:
 *         description: Missing/invalid access token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/me', requireAuth, sessionActionLimiter, async (req: Request, res: Response) => {
  const { data: user } = await usersRepository.findFullProfileById(req.user.id);
  return res.json({ user });
});

export = router;

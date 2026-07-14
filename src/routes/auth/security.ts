import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import * as analytics from '../../services/analytics';
import * as usersRepository from '../../repositories/usersRepository';
import { issueAndSendCode, checkCode } from '../../services/emailCodes';
import { findRecentForUser } from '../../services/loginEvents';
import { revokeAllForUser, listActiveSessionsForUser, revokeSessionById, hashRefreshToken } from '../../services/refreshTokens';
import { requireAuth } from '../../middleware/auth';
import { userLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { issueSession } from './shared';

// Security-sensitive writes are rare in normal use — clamp hard.
const securityWriteLimiter = userLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Слишком много попыток, подожди немного.' });
const securityReadLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Слишком много запросов, подожди немного.' });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, 'Пароль должен быть не короче 6 символов').max(200),
});

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Код — 6 цифр') });
const sessionsListSchema = z.object({ refreshToken: z.string().optional() });
const revokeSessionSchema = z.object({ sessionId: z.string().uuid() });

// ── POST /api/auth/change-password ──────────────────────────────────────────
// Requires the current password, then rotates the hash and revokes every
// refresh token (all devices sign out) — a fresh session pair is issued for
// THIS device so the user isn't logged out of the tab they did it from.
router.post('/change-password', requireAuth, securityWriteLimiter, validate({ body: changePasswordSchema }), async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body;

  const { data: user, error } = await usersRepository.findAuthById(req.user.id);
  if (error || !user) return res.status(500).json({ error: 'Не удалось загрузить аккаунт' });

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Текущий пароль неверный' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  const { error: updateError } = await usersRepository.updatePasswordHash(req.user.id, passwordHash);
  if (updateError) return res.status(500).json({ error: updateError.message });

  // Kill every existing session (stolen-laptop scenario), then re-issue for
  // the current device so the client just swaps its token pair.
  await revokeAllForUser(req.user.id);
  const { token, refreshToken, expiresIn } = await issueSession(user, req);
  analytics.capture(req.user.id, 'password_changed');
  return res.json({ ok: true, token, refreshToken, expiresIn });
});

// ── Email 2FA ────────────────────────────────────────────────────────────────
// Enabling/disabling is confirmed with a mailed code (purpose 'login' — the
// same kind the 2FA login step itself uses), proving the user still controls
// the mailbox that the second factor depends on.

// POST /api/auth/2fa/request — mail a confirmation code to the account email.
router.post('/2fa/request', requireAuth, securityWriteLimiter, async (req: Request, res: Response) => {
  const { data: user, error } = await usersRepository.findAuthById(req.user.id);
  if (error || !user) return res.status(500).json({ error: 'Не удалось загрузить аккаунт' });
  try {
    await issueAndSendCode({ id: user.id, email: user.email }, 'login');
  } catch (e: any) {
    req.log.error({ err: e }, 'Failed to send 2FA confirmation code');
    return res.status(500).json({ error: 'Не удалось отправить код на почту' });
  }
  return res.json({ ok: true });
});

// POST /api/auth/2fa/enable — verify the mailed code, then turn 2FA on.
router.post('/2fa/enable', requireAuth, securityWriteLimiter, validate({ body: codeSchema }), async (req: Request, res: Response) => {
  const result = await checkCode(req.user.id, 'login', req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const { error } = await usersRepository.setTwofaEmailEnabled(req.user.id, true);
  if (error) return res.status(500).json({ error: error.message });
  analytics.capture(req.user.id, 'twofa_enabled');
  return res.json({ ok: true, twofa_email_enabled: true });
});

// POST /api/auth/2fa/disable — verify the mailed code, then turn 2FA off.
router.post('/2fa/disable', requireAuth, securityWriteLimiter, validate({ body: codeSchema }), async (req: Request, res: Response) => {
  const result = await checkCode(req.user.id, 'login', req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const { error } = await usersRepository.setTwofaEmailEnabled(req.user.id, false);
  if (error) return res.status(500).json({ error: error.message });
  analytics.capture(req.user.id, 'twofa_disabled');
  return res.json({ ok: true, twofa_email_enabled: false });
});

// ── Devices / sessions ───────────────────────────────────────────────────────
// POST (not GET) so the client can pass its own refresh token in the body —
// that's how the "это устройство" flag is computed — without putting a
// credential in a URL.
router.post('/sessions', requireAuth, securityReadLimiter, validate({ body: sessionsListSchema }), async (req: Request, res: Response) => {
  const { data: rows, error } = await listActiveSessionsForUser(req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  const currentHash = req.body.refreshToken ? hashRefreshToken(req.body.refreshToken) : null;
  const sessions = (rows || []).map((r) => ({
    id: r.id,
    user_agent: r.user_agent,
    ip: r.ip,
    last_active: r.created_at, // rotation re-creates the row, so created_at ≈ last activity
    expires_at: r.expires_at,
    current: Boolean(currentHash && r.token_hash === currentHash),
  }));
  return res.json({ sessions });
});

// POST /api/auth/sessions/revoke — sign out one device.
router.post('/sessions/revoke', requireAuth, securityWriteLimiter, validate({ body: revokeSessionSchema }), async (req: Request, res: Response) => {
  const ok = await revokeSessionById(req.user.id, req.body.sessionId);
  if (!ok) return res.status(404).json({ error: 'Сессия не найдена' });
  analytics.capture(req.user.id, 'session_revoked');
  return res.json({ ok: true });
});

// ── GET /api/auth/login-history — журнал входов ─────────────────────────────
router.get('/login-history', requireAuth, securityReadLimiter, async (req: Request, res: Response) => {
  const { data, error } = await findRecentForUser(req.user.id, 30);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ events: data || [] });
});

export = router;

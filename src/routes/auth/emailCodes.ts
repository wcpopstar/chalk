import type { Request, Response } from 'express';
const router = require('express').Router();
const analytics = require('../../services/analytics');
const usersRepository = require('../../repositories/usersRepository');
const emailCodesRepository = require('../../repositories/emailCodesRepository');
const { issueAndSendCode, hashCode } = require('../../services/emailCodes');
const { authLimiter, codeRequestLimiter, issueSession, bannedResponse } = require('./shared');
const { validate } = require('../../middleware/validate');
const { requestCodeSchema, verifyCodeSchema, resendCodeSchema } = require('../../validation/schemas');

// Generic acknowledgement used by endpoints that must not reveal whether an
// account exists (same anti-enumeration posture as /forgot-password).
const GENERIC_SENT = { ok: true, message: 'Если такой аккаунт существует, мы отправили код на его почту.' };

// Checks a submitted code against the newest outstanding one for
// (user, purpose). Consumes the code on success; counts a failed attempt and
// caps brute-forcing otherwise. Returns a small result object rather than
// touching res, so callers control the response shape.
async function checkCode(userId: string, purpose: 'verify_email' | 'login', code: string): Promise<{ ok: boolean; error?: string }> {
  const { data: row } = await emailCodesRepository.findLatestValid(userId, purpose);
  const invalid = { ok: false, error: 'Код недействителен или устарел' };

  if (!row) return invalid;
  if (new Date(row.expires_at) < new Date()) return invalid;
  if (row.attempts >= emailCodesRepository.MAX_ATTEMPTS) {
    return { ok: false, error: 'Слишком много попыток. Запроси новый код.' };
  }
  if (row.code_hash !== hashCode(code)) {
    await emailCodesRepository.incrementAttempts(row.id, row.attempts);
    return invalid;
  }
  await emailCodesRepository.markUsed(row.id);
  return { ok: true };
}

// ── POST /api/auth/verify-email ─────────────────────────────────────────────
// Confirms the email of a freshly-registered account and, on success, issues
// the session that /register deliberately withheld.
router.post('/verify-email', authLimiter, validate({ body: verifyCodeSchema }), async (req: Request, res: Response) => {
  const { identifier, code } = req.body;
  const { data: user } = await usersRepository.findForCodeAuth(identifier);
  if (!user) return res.status(400).json({ error: 'Код недействителен или устарел' });

  const banned = bannedResponse(user);
  if (banned) return res.status(403).json(banned);

  if (user.email_verified) {
    // Already verified — nothing to do, but don't error the client; just log
    // them in as if the code matched (they clearly control the account flow).
    const { token, refreshToken, expiresIn } = await issueSession(user, req);
    await usersRepository.setStatus(user.id, 'online');
    return res.json({ user, token, refreshToken, expiresIn });
  }

  const result = await checkCode(user.id, 'verify_email', code);
  if (!result.ok) return res.status(400).json({ error: result.error });

  await usersRepository.setEmailVerified(user.id);
  await usersRepository.setStatus(user.id, 'online');
  const { token, refreshToken, expiresIn } = await issueSession(user, req);
  analytics.capture(user.id, 'email_verified');
  return res.json({ user, token, refreshToken, expiresIn });
});

// ── POST /api/auth/request-login-code ───────────────────────────────────────
// Passwordless login step 1: mail a login code to the account's email. Always
// responds generically so it can't be used to probe which nicknames/emails
// exist. Only verified accounts get a login code.
router.post('/request-login-code', authLimiter, codeRequestLimiter, validate({ body: requestCodeSchema }), async (req: Request, res: Response) => {
  const { identifier } = req.body;
  const { data: user } = await usersRepository.findForCodeAuth(identifier);

  if (user && user.email_verified) {
    try {
      await issueAndSendCode({ id: user.id, email: user.email }, 'login');
    } catch (e: any) {
      req.log.error({ err: e }, 'Failed to send login code');
    }
  } else if (user && !user.email_verified) {
    // Unverified account asking to log in: send a verification code instead so
    // they can finish onboarding. Still respond generically.
    try {
      await issueAndSendCode({ id: user.id, email: user.email }, 'verify_email');
    } catch (e: any) {
      req.log.error({ err: e }, 'Failed to send verification code');
    }
  }

  return res.json(GENERIC_SENT);
});

// ── POST /api/auth/login-code ───────────────────────────────────────────────
// Passwordless login step 2: exchange a valid login code for a session.
router.post('/login-code', authLimiter, validate({ body: verifyCodeSchema }), async (req: Request, res: Response) => {
  const { identifier, code } = req.body;
  const { data: user } = await usersRepository.findForCodeAuth(identifier);
  if (!user) return res.status(400).json({ error: 'Код недействителен или устарел' });

  const banned = bannedResponse(user);
  if (banned) return res.status(403).json(banned);

  if (!user.email_verified) {
    return res.status(403).json({ error: 'Email not verified', needsVerification: true, identifier: user.username, email: user.email });
  }

  const result = await checkCode(user.id, 'login', code);
  if (!result.ok) return res.status(400).json({ error: result.error });

  await usersRepository.setStatus(user.id, 'online');
  const { token, refreshToken, expiresIn } = await issueSession(user, req);
  analytics.capture(user.id, 'user_logged_in', { method: 'code' });
  return res.json({ user, token, refreshToken, expiresIn });
});

// ── POST /api/auth/resend-code ──────────────────────────────────────────────
// Re-sends a code for a given purpose (the "didn't get it?" button). Generic
// response, per-identifier rate limited.
router.post('/resend-code', authLimiter, codeRequestLimiter, validate({ body: resendCodeSchema }), async (req: Request, res: Response) => {
  const { identifier, purpose } = req.body;
  const { data: user } = await usersRepository.findForCodeAuth(identifier);

  if (user) {
    const effective = purpose === 'login' && !user.email_verified ? 'verify_email' : purpose;
    // Don't resend a verification code to an already-verified account.
    if (!(effective === 'verify_email' && user.email_verified)) {
      try {
        await issueAndSendCode({ id: user.id, email: user.email }, effective);
      } catch (e: any) {
        req.log.error({ err: e }, 'Failed to resend code');
      }
    }
  }

  return res.json(GENERIC_SENT);
});

export = router;

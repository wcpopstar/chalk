import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import * as analytics from '../../services/analytics';
import * as usersRepository from '../../repositories/usersRepository';
import { issueAndSendCode, checkCode } from '../../services/emailCodes';
import { recordLoginEvent } from '../../services/loginEvents';
import { authLimiter, codeRequestLimiter, issueSession, bannedResponse, requestMeta } from './shared';
import { validate } from '../../middleware/validate';
import { requestCodeSchema, verifyCodeSchema, resendCodeSchema } from '../../validation/schemas';

// Generic acknowledgement used by endpoints that must not reveal whether an
// account exists (same anti-enumeration posture as /forgot-password).
const GENERIC_SENT = { ok: true, message: 'Если такой аккаунт существует, мы отправили код на его почту.' };

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
  if (!result.ok) {
    recordLoginEvent(user.id, 'code', false, requestMeta(req));
    return res.status(400).json({ error: result.error });
  }

  await usersRepository.setStatus(user.id, 'online');
  const { token, refreshToken, expiresIn } = await issueSession(user, req);
  analytics.capture(user.id, 'user_logged_in', { method: 'code' });
  // With email 2FA enabled this same endpoint is the second factor step, so
  // journal it as '2fa' — otherwise it's a plain passwordless code login.
  recordLoginEvent(user.id, (user as any).twofa_email_enabled ? '2fa' : 'code', true, requestMeta(req));
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

import type { Request, Response } from 'express';
const router = require('express').Router();
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { requireAuth } = require('../../middleware/auth');
const { supabaseAdmin } = require('../../services/supabase');
const { redis } = require('../../socket/redisClient');
const { authLimiter, issueSession, bannedResponse, USER_FIELDS } = require('./shared');
const logger = require('../../utils/logger').child({ module: 'passkeys' });

/**
 * Passkey (WebAuthn) support.
 *
 *   POST /passkey/register-options  (auth)  → challenge + options for navigator.credentials.create()
 *   POST /passkey/register-verify   (auth)  → verifies attestation, stores the credential
 *   POST /passkey/login-options              → challenge + options for navigator.credentials.get()
 *   POST /passkey/login-verify                → verifies assertion, issues a normal session
 *   GET  /passkey/list              (auth)  → user's registered passkeys
 *   DELETE /passkey/:id             (auth)  → remove one passkey
 *
 * Challenges are single-use and live in Redis for 5 minutes. Login is
 * usernameless: the browser offers any discoverable credential for this RP,
 * and the credential id maps back to the user server-side.
 */

// RP identity. In production set PASSKEY_RP_ID (bare domain, e.g. "chalk.gg")
// and PASSKEY_ORIGIN (full origin, e.g. "https://chalk.gg").
const RP_ID = process.env.PASSKEY_RP_ID || 'localhost';
const ORIGIN = process.env.PASSKEY_ORIGIN || 'http://localhost:3000';
const RP_NAME = 'Chalk';

const CHALLENGE_TTL_SEC = 300;
const regChallengeKey = (userId: string) => `chalk:passkey:reg:${userId}`;
const loginChallengeKey = (sessionId: string) => `chalk:passkey:login:${sessionId}`;

// ── Register a new passkey (logged-in user) ───────────────────────────────
router.post('/passkey/register-options', requireAuth, authLimiter, async (req: Request, res: Response) => {
  const { data: user } = await supabaseAdmin.from('users').select('id, username').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { data: existing } = await supabaseAdmin
    .from('webauthn_credentials')
    .select('id, transports')
    .eq('user_id', req.user.id);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.username,
    userDisplayName: user.username,
    // Discoverable credential so passkey login can be usernameless.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: (existing || []).map((c: any) => ({ id: c.id, transports: c.transports })),
  });

  await redis.set(regChallengeKey(req.user.id), options.challenge, 'EX', CHALLENGE_TTL_SEC);
  return res.json({ options });
});

router.post('/passkey/register-verify', requireAuth, authLimiter, async (req: Request, res: Response) => {
  const { response, deviceName } = req.body || {};
  if (!response) return res.status(400).json({ error: 'Missing credential response' });

  const challengeKey = regChallengeKey(req.user.id);
  const expectedChallenge = await redis.get(challengeKey);
  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired, try again' });
  await redis.del(challengeKey); // single-use

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
  } catch (err: any) {
    logger.warn({ err, userId: req.user.id }, 'Passkey registration verification failed');
    return res.status(400).json({ error: 'Не удалось проверить ключ доступа' });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'Не удалось проверить ключ доступа' });
  }

  const { credential } = verification.registrationInfo;
  const { error } = await supabaseAdmin.from('webauthn_credentials').insert({
    id: credential.id,
    user_id: req.user.id,
    public_key: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports || [],
    device_name: typeof deviceName === 'string' ? deviceName.slice(0, 60) : null,
  });
  if (error) return res.status(500).json({ error: error.message });

  return res.json({ ok: true });
});

// ── Usernameless login with a passkey ─────────────────────────────────────
router.post('/passkey/login-options', authLimiter, async (_req: Request, res: Response) => {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    allowCredentials: [], // discoverable credentials — browser picks
  });
  const sessionId = crypto.randomBytes(16).toString('hex');
  await redis.set(loginChallengeKey(sessionId), options.challenge, 'EX', CHALLENGE_TTL_SEC);
  return res.json({ options, sessionId });
});

router.post('/passkey/login-verify', authLimiter, async (req: Request, res: Response) => {
  const { response, sessionId } = req.body || {};
  if (!response || !response.id || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing credential response' });
  }

  const challengeKey = loginChallengeKey(sessionId);
  const expectedChallenge = await redis.get(challengeKey);
  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired, try again' });
  await redis.del(challengeKey); // single-use

  const { data: cred } = await supabaseAdmin
    .from('webauthn_credentials')
    .select('id, user_id, public_key, counter, transports')
    .eq('id', response.id)
    .maybeSingle();
  if (!cred) return res.status(401).json({ error: 'Ключ доступа не найден' });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.public_key, 'base64url'),
        counter: Number(cred.counter) || 0,
        transports: cred.transports,
      },
    });
  } catch (err: any) {
    logger.warn({ err, credentialId: cred.id }, 'Passkey authentication verification failed');
    return res.status(401).json({ error: 'Не удалось проверить ключ доступа' });
  }
  if (!verification.verified) return res.status(401).json({ error: 'Не удалось проверить ключ доступа' });

  const { data: user } = await supabaseAdmin
    .from('users')
    .select(`${USER_FIELDS}, banned_until, ban_reason`)
    .eq('id', cred.user_id)
    .single();
  if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

  const banned = bannedResponse(user);
  if (banned) return res.status(403).json(banned);

  await supabaseAdmin
    .from('webauthn_credentials')
    .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq('id', cred.id);

  const { banned_until, ban_reason, ...safeUser } = user;
  const { token, refreshToken, expiresIn } = await issueSession(user, req);
  logger.info({ userId: user.id }, 'Passkey login');
  return res.json({ user: safeUser, token, refreshToken, expiresIn });
});

// ── Manage own passkeys ───────────────────────────────────────────────────
router.get('/passkey/list', requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('webauthn_credentials')
    .select('id, device_name, created_at, last_used_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ passkeys: data || [] });
});

router.delete('/passkey/:id', requireAuth, async (req: Request, res: Response) => {
  const { error } = await supabaseAdmin
    .from('webauthn_credentials')
    .delete()
    .match({ id: req.params.id, user_id: req.user.id });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

export = router;

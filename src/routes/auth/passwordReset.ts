const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const usersRepository = require('../../repositories/usersRepository');
const passwordResetsRepository = require('../../repositories/passwordResetsRepository');
const { enqueuePasswordResetEmail } = require('../../queues');
const { revokeAllForUser } = require('../../services/refreshTokens');
const { config } = require('../../config/env');
const { authLimiter, forgotPasswordEmailLimiter, hashToken } = require('./shared');
const { validate } = require('../../middleware/validate');
const { forgotPasswordSchema, resetPasswordSchema } = require('../../validation/schemas');

// ── POST /api/auth/forgot-password ─────────────────────────────────────────
/**
 * @openapi
 * /api/auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request a password reset email
 *     description: Always responds with the same generic message whether or not the email is registered, to avoid leaking which emails exist. Rate-limited per email address.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Generic acknowledgement (does not confirm account existence)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 message: { type: string }
 *       400:
 *         description: email missing
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/forgot-password', authLimiter, forgotPasswordEmailLimiter, validate({ body: forgotPasswordSchema }), async (req: any, res: any) => {
  const { email } = req.body;

  // Always respond with the same generic message, whether or not the email
  // exists — this avoids leaking which emails are registered.
  const genericResponse = { ok: true, message: 'Если такой email зарегистрирован, на него отправлена ссылка для сброса пароля.' };

  const { data: user } = await usersRepository.findByEmailForPasswordReset(email);

  if (!user) {
    return res.json(genericResponse);
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

  const { error } = await passwordResetsRepository.create({
    userId: user.id,
    tokenHash: hashToken(rawToken),
    expiresAt,
  });

  if (error) {
    req.log.error({ err: error }, 'Failed to create password reset record');
    return res.status(500).json({ error: 'Could not start password reset' });
  }

  const baseUrl = (config.server.clientOrigin !== '*' ? config.server.clientOrigin : null) || `${req.protocol}://${req.get('host')}`;
  const resetUrl = `${baseUrl}/?reset=${rawToken}`;

  try {
    // Enqueued instead of awaited inline: the worker process does the
    // actual SMTP send (with retries/backoff), so a slow or down mail
    // server can't hold this request open or eat into the auth rate limit's
    // request budget.
    await enqueuePasswordResetEmail(user.email, resetUrl);
  } catch (e: any) {
    req.log.error({ err: e }, 'Failed to enqueue password reset email');
    // Don't reveal the failure to the client — still respond generically.
  }

  res.json(genericResponse);
});

// ── POST /api/auth/reset-password ──────────────────────────────────────────
/**
 * @openapi
 * /api/auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Complete a password reset
 *     description: Consumes a one-time reset token (emailed via /api/auth/forgot-password) and sets a new password. Revokes every existing session for the account afterwards.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *             schema:
 *               type: object
 *               required: [token, password]
 *             properties:
 *               token: { type: string, description: 'Raw token from the reset email link.' }
 *               password: { type: string, format: password, minLength: 6 }
 *     responses:
 *       200:
 *         description: Password updated, all sessions revoked
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       400:
 *         description: Missing fields, weak password, or invalid/expired/used token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/reset-password', authLimiter, validate({ body: resetPasswordSchema }), async (req: any, res: any) => {
  const { token, password } = req.body;

  const tokenHash = hashToken(token);

  const { data: resetRow, error: lookupError } = await passwordResetsRepository.findByTokenHash(tokenHash);

  if (lookupError || !resetRow || resetRow.used_at || new Date(resetRow.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Ссылка для сброса пароля недействительна или устарела' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { error: updateError } = await usersRepository.updatePasswordHash(resetRow.user_id, passwordHash);

  if (updateError) {
    req.log.error({ err: updateError }, 'Failed to update password during reset');
    return res.status(500).json({ error: 'Could not reset password' });
  }

  await passwordResetsRepository.markUsed(resetRow.id);

  // A password reset means any credential-holder before this point should be
  // logged out — revoke every existing session for the account.
  await revokeAllForUser(resetRow.user_id);

  res.json({ ok: true });
});

export = router;

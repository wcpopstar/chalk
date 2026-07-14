import type { Request, Response } from 'express';
const router = require('express').Router();
const analytics = require('../../services/analytics');
const bcrypt = require('bcryptjs');
const usersRepository = require('../../repositories/usersRepository');
const { loginSchema } = require('../../validation/schemas');
const { issueAndSendCode } = require('../../services/emailCodes');
const { authLimiter, loginEmailLimiter, issueSession, bannedResponse } = require('./shared');

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in with email and password
 *     description: Returns a fresh access + refresh token pair on success. Rate-limited both by IP and by the email being attempted.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email, example: player@example.com }
 *               password: { type: string, format: password, example: 'Str0ngPass' }
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400:
 *         description: Validation error (Zod)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       429:
 *         description: Too many attempts
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/login', authLimiter, loginEmailLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.parse(req.body);
    const { email, password } = parsed;

    const { data: user, error } = await usersRepository.findForLogin(email);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Banned accounts can't sign in. Checked only after the password matched
    // so the ban reason is never disclosed to someone guessing credentials.
    const banned = bannedResponse(user);
    if (banned) return res.status(403).json(banned);

    // Password was correct, but a brand-new account must confirm its email
    // before it can sign in. Mail a fresh code and steer the client to the
    // verification step rather than issuing a session.
    if (user.email_verified === false) {
      try {
        await issueAndSendCode({ id: user.id, email: user.email }, 'verify_email');
      } catch (e: any) {
        req.log.error({ err: e }, 'Failed to send verification code on login of unverified account');
      }
      return res.status(403).json({ error: 'Email not verified', needsVerification: true, identifier: user.username, email: user.email });
    }

    await usersRepository.setStatus(user.id, 'online');

    const { password_hash, ...safeUser } = user;
    const { token, refreshToken, expiresIn } = await issueSession(user, req);
    analytics.capture(user.id, 'user_logged_in');
    return res.json({ user: safeUser, token, refreshToken, expiresIn });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid request payload', details: error.issues.map((e: { message: string }) => e.message) });
    }
    req.log.error({ err: error }, 'Login failed');
    return res.status(500).json({ error: 'Could not log in' });
  }
});

export = router;

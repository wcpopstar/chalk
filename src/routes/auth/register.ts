export {};
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const usersRepository = require('../../repositories/usersRepository');
const { registerSchema } = require('../../validation/schemas');
const { generateUsername } = require('../../utils/usernames');
const { USER_FIELDS, authLimiter, issueSession } = require('./shared');

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Create a new account
 *     description: Registers a new user and immediately returns an authenticated session (access + refresh token). If `username` is omitted, a random one is generated.
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
 *               password: { type: string, format: password, minLength: 8, description: 'Min 8 chars, must include uppercase, lowercase and a digit.', example: 'Str0ngPass' }
 *               username: { type: string, minLength: 3, maxLength: 24, example: ShadowFox_42 }
 *               country: { type: string, maxLength: 100, example: NL }
 *               languages: { type: array, items: { type: string }, example: ['en', 'ru'] }
 *     responses:
 *       201:
 *         description: Account created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400:
 *         description: Validation error (Zod)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       409:
 *         description: Email or username already taken
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/register', authLimiter, async (req: any, res: any) => {
  try {
    const parsed = registerSchema.parse({ ...req.body, languages: req.body.languages || ['en'] });
    const { email, password, country, languages } = parsed;
    const username = (parsed.username || '').trim() || generateUsername();

    const { data: existing } = await usersRepository.existsByEmailOrUsername(email, username);

    if (existing) {
      return res.status(409).json({ error: 'Email or username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const id = uuid();

    const { data: user, error } = await usersRepository.createUser(
      {
        id,
        username,
        email: email.toLowerCase(),
        password_hash: passwordHash,
        country: country || null,
        languages,
        avatar_emoji: '🎮',
        onboarding_completed: false,
        created_at: new Date().toISOString(),
      },
      USER_FIELDS
    );

    if (error) {
      req.log.error({ err: error }, 'Failed to insert new user during registration');
      return res.status(500).json({ error: 'Could not create account' });
    }

    const { token, refreshToken, expiresIn } = await issueSession(user, req);
    res.status(201).json({ user, token, refreshToken, expiresIn });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid request payload', details: error.issues.map((e: any) => e.message) });
    }
    req.log.error({ err: error }, 'Registration failed');
    res.status(500).json({ error: 'Could not create account' });
  }
});

module.exports = router;

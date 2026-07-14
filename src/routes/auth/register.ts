import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import * as analytics from '../../services/analytics';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import * as usersRepository from '../../repositories/usersRepository';
import { registerSchema } from '../../validation/schemas';
import { generateUsername } from '../../utils/usernames';
import { issueAndSendCode } from '../../services/emailCodes';
import { USER_FIELDS, authLimiter } from './shared';

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
// Picks an auto-generated username that isn't taken yet: a few clean
// candidates ("SilentViper") first, then a few with a short numeric suffix
// ("SilentViper42"), and finally a timestamp-suffixed one that's
// effectively always free. The users.username UNIQUE constraint remains
// the hard guarantee underneath for the (tiny) check-then-insert race.
async function pickGeneratedUsername(): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = generateUsername();
    const { data: taken } = await usersRepository.existsByUsername(candidate);
    if (!taken) return candidate;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = generateUsername({ suffix: true });
    const { data: taken } = await usersRepository.existsByUsername(candidate);
    if (!taken) return candidate;
  }
  return `${generateUsername()}${Date.now() % 10000}`;
}

router.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.parse({ ...req.body, languages: req.body.languages || ['en'] });
    const { email, password, country, languages } = parsed;
    const username = (parsed.username || '').trim() || await pickGeneratedUsername();

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
        // The account starts unverified: we mail a code below and the user
        // must confirm it via POST /verify-email before a session is issued.
        email_verified: false,
        created_at: new Date().toISOString(),
      },
      USER_FIELDS
    );

    if (error) {
      req.log.error({ err: error }, 'Failed to insert new user during registration');
      return res.status(500).json({ error: 'Could not create account' });
    }

    // Mail the verification code. If this fails we don't want to leave a
    // dangling unverified account with no way in, but the code can also be
    // re-requested via /resend-code, so a send hiccup isn't fatal — log and
    // still tell the client to go to the code screen.
    try {
      await issueAndSendCode({ id: user.id, email: user.email }, 'verify_email');
    } catch (e: any) {
      req.log.error({ err: e }, 'Failed to send verification code during registration');
    }

    analytics.capture(user.id, 'user_registered');
    analytics.identify(user.id, { country: user.country || null });
    // No session yet — the client shows the code-entry step and calls
    // /verify-email, which issues the session on success.
    return res.status(201).json({ pendingVerification: true, identifier: user.username, email: user.email });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid request payload', details: error.issues.map((e: { message: string }) => e.message) });
    }
    req.log.error({ err: error }, 'Registration failed');
    return res.status(500).json({ error: 'Could not create account' });
  }
});

export = router;

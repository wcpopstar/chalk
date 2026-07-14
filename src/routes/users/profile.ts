import type { Request, Response } from 'express';
const router = require('express').Router();
const { requireAuth } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { userLimiter } = require('../../middleware/rateLimit');
const usersRepository = require('../../repositories/usersRepository');
const userGamesRepository = require('../../repositories/userGamesRepository');
const statsRepository = require('../../repositories/statsRepository');
const { invalidate } = require('../../utils/cache');
const { profileCacheKey } = require('./shared');
const { updateProfileSchema, onboardingSchema, updateGamesSchema } = require('../../validation/userSchemas');

// Profile edits are occasional, not something legitimately hit dozens of
// times a minute — cap generously enough for "tweak a few fields in a row"
// while still stopping a scripted hammer.
const profileWriteLimiter = userLimiter({ windowMs: 60 * 1000, max: 20, message: 'Слишком много изменений профиля, подожди немного.' });
const statsReadLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Слишком много запросов, подожди немного.' });

/**
 * @openapi
 * /api/users/me:
 *   patch:
 *     tags: [Users]
 *     summary: Update the current user's profile
 *     description: Partial update — only send the fields you want to change. Invalidates the cached public profile for this user.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string, minLength: 3, maxLength: 24 }
 *               country: { type: string, nullable: true }
 *               languages: { type: array, items: { type: string } }
 *               avatar_emoji: { type: string }
 *               avatar_url: { type: string, nullable: true }
 *               bio: { type: string, nullable: true }
 *               age: { type: integer, minimum: 13, maximum: 100 }
 *               gender: { type: string, enum: [male, female, other, prefer_not_to_say] }
 *               presence: { type: string, enum: [online, away, busy] }
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { user: { $ref: '#/components/schemas/User' } }
 *       400:
 *         description: Nothing to update, or a field failed validation
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       409:
 *         description: Username already taken
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.patch('/me', requireAuth, profileWriteLimiter, validate({ body: updateProfileSchema }), async (req: Request, res: Response) => {
  const updates = req.body;

  // Nickname must stay unique
  if (updates.username) {
    const { data: existing } = await usersRepository.existsByUsernameExcludingId(updates.username, req.user.id);
    if (existing) return res.status(409).json({ error: 'Username already taken' });
  }

  // Drop cleared handles so the stored jsonb only holds platforms actually set.
  if (updates.gaming_links) {
    updates.gaming_links = Object.fromEntries(
      Object.entries(updates.gaming_links).filter(([, v]) => typeof v === 'string' && v.length > 0)
    );
  }

  const { data, error } = await usersRepository.updateProfile(
    req.user.id,
    updates,
    'id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, status_text, presence, gaming_links, public_key, e2ee_backup_secret, e2ee_backup_nonce, e2ee_backup_salt, e2ee_backup_iters'
  );

  if (error) return res.status(500).json({ error: error.message });
  invalidate(profileCacheKey(req.user.id));
  return res.json({ user: data });
});

/**
 * @openapi
 * /api/users/me/onboarding:
 *   post:
 *     tags: [Users]
 *     summary: Complete first-time profile setup
 *     description: One-shot setup completed right after registration. Marks onboarding_completed=true. Invalidates the cached public profile.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [age, gender, languages]
 *             properties:
 *               username: { type: string, minLength: 3, maxLength: 24 }
 *               avatar_url: { type: string, nullable: true }
 *               age: { type: integer, minimum: 13, maximum: 100 }
 *               gender: { type: string, enum: [male, female, other, prefer_not_to_say] }
 *               languages: { type: array, items: { type: string }, minItems: 1 }
 *               games:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties: { game_id: { type: string }, rank: { type: string, nullable: true }, hours_played: { type: integer } }
 *     responses:
 *       200:
 *         description: Onboarding completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { user: { $ref: '#/components/schemas/User' } }
 *       400:
 *         description: Missing required field, or validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       409:
 *         description: Username already taken
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/me/onboarding', requireAuth, profileWriteLimiter, validate({ body: onboardingSchema }), async (req: Request, res: Response) => {
  const { games, ...profileFields } = req.body;
  const updates = { ...profileFields, onboarding_completed: true };

  if (updates.username) {
    const { data: existing } = await usersRepository.existsByUsernameExcludingId(updates.username, req.user.id);
    if (existing) return res.status(409).json({ error: 'Username already taken' });
  }

  const { data: user, error } = await usersRepository.updateProfile(
    req.user.id,
    updates,
    'id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, bio, presence'
  );

  if (error) return res.status(500).json({ error: error.message });

  if (Array.isArray(games)) {
    try {
      await userGamesRepository.replaceForUser(req.user.id, games);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  invalidate(profileCacheKey(req.user.id));
  return res.json({ user });
});

/**
 * @openapi
 * /api/users/me/games:
 *   put:
 *     tags: [Users]
 *     summary: Replace the current user's game list
 *     description: Full replace — deletes all existing user_games rows and inserts the given list. Invalidates the cached public profile.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [games]
 *             properties:
 *               games:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties: { game_id: { type: string }, rank: { type: string, nullable: true }, hours_played: { type: integer } }
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       400:
 *         description: games is not an array
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.put('/me/games', requireAuth, profileWriteLimiter, validate({ body: updateGamesSchema }), async (req: Request, res: Response) => {
  try {
    await userGamesRepository.replaceForUser(req.user.id, req.body.games);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }

  invalidate(profileCacheKey(req.user.id));
  return res.json({ ok: true });
});

/**
 * @openapi
 * /api/users/me/stats:
 *   get:
 *     tags: [Users]
 *     summary: Get the current user's stats summary
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UserStats' }
 */
router.get('/me/stats', requireAuth, statsReadLimiter, async (req: Request, res: Response) => {
  const [{ count: matchCount }, { data: ratingRow }, { count: friendCount }] = await statsRepository.getUserStats(req.user.id);

  return res.json({
    matches_found: matchCount || 0,
    avg_rating: ratingRow?.avg_rating || null,
    friends_count: friendCount || 0,
  });
});

export = router;

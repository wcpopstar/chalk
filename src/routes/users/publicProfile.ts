import type { Request, Response } from 'express';
const router = require('express').Router();
const { requireAuth } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { userLimiter } = require('../../middleware/rateLimit');
const { uuidParam } = require('../../validation/common');
const usersRepository = require('../../repositories/usersRepository');
const blocksRepository = require('../../repositories/blocksRepository');
const { cached } = require('../../utils/cache');
const { profileCacheKey, PROFILE_CACHE_TTL_SECONDS } = require('./shared');

// Loose — normal browsing hits this a lot — but caps a script from walking
// through every user id on the platform scraping profiles.
const viewLimiter = userLimiter({ windowMs: 60 * 1000, max: 60, message: 'Слишком много запросов, подожди немного.' });

/**
 * @openapi
 * /api/users/{id}:
 *   get:
 *     tags: [Users]
 *     summary: Get another user's public profile
 *     description: The profile fields are served from a short-lived Redis cache (see utils/cache.ts); blocked_by_me/has_blocked_me are always computed fresh per viewer and are never part of the cached payload.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { user: { $ref: '#/components/schemas/PublicProfile' } }
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
// Must be mounted LAST so it doesn't swallow /me, /me/stats, /discover, etc.
router.get('/:id', requireAuth, viewLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  // Only the viewer-independent fields are cached — same behavior as
  // before on error/not-found (any failure here still surfaces as a 404,
  // matching this route's pre-existing behavior; not changing that here).
  //
  // NOTE: this includes status/presence/last_seen, so an online badge here
  // can be up to PROFILE_CACHE_TTL_SECONDS stale. Deliberately acceptable
  // here in a way it wasn't for GET /api/friends (see utils/cache.ts): a
  // single profile view is opened briefly and closed, not watched
  // continuously the way a friends list's live indicators are — if this
  // becomes a UX problem in practice, merge live status in the same way
  // blocked_by_me is merged below instead of widening the cache TTL down.
  let user: any;
  try {
    user = await cached(profileCacheKey(req.params.id), PROFILE_CACHE_TTL_SECONDS, async () => {
      const { data, error } = await usersRepository.findPublicProfileById(req.params.id);
      if (error || !data) throw error || new Error('User not found');
      return data;
    });
  } catch (_) {
    return res.status(404).json({ error: 'User not found' });
  }

  // blocked_by_me / has_blocked_me depend on WHO is asking, not just whose
  // profile it is — computed fresh every request and merged into the
  // (possibly cached) profile object. JSON.parse inside cached() already
  // hands back a fresh object per call, so mutating it here doesn't leak
  // between different viewers' requests.
  const { data: blockRows } = await blocksRepository.findPairBetween(req.user.id, req.params.id);

  user.blocked_by_me = !!(blockRows || []).find((r: any) => r.blocker_id === req.user.id);
  user.has_blocked_me = !!(blockRows || []).find((r: any) => r.blocker_id === req.params.id);

  return res.json({ user });
});

export = router;

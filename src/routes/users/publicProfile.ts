import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { userLimiter } from '../../middleware/rateLimit';
import { uuidParam } from '../../validation/common';
import * as usersRepository from '../../repositories/usersRepository';
import * as blocksRepository from '../../repositories/blocksRepository';
import { cached } from '../../utils/cache';
import { profileCacheKey, PROFILE_CACHE_TTL_SECONDS } from './shared';
import { supabaseAdmin } from '../../services/supabase';

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
/**
 * @openapi
 * /api/users/{id}/reviews:
 *   get:
 *     tags: [Users]
 *     summary: Text reviews left for a user after calls
 *     description: The subset of post-call ratings that include a written comment, newest first, with the reviewer's basic profile.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: OK }
 */
// More specific than the '/:id' catch-all below, so it must be declared first.
router.get('/:id/reviews', requireAuth, viewLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('ratings')
    .select('rating, comment, created_at, rater:users!ratings_rater_user_id_fkey ( id, username, avatar_emoji, avatar_url )')
    .eq('rated_user_id', req.params.id!)
    .not('comment', 'is', null)
    .neq('comment', '')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ reviews: data || [] });
});

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
    user = await cached(profileCacheKey(req.params.id!), PROFILE_CACHE_TTL_SECONDS, async () => {
      const { data, error } = await usersRepository.findPublicProfileById(req.params.id!);
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
  const { data: blockRows } = await blocksRepository.findPairBetween(req.user.id, req.params.id!);

  user.blocked_by_me = !!(blockRows || []).find((r) => r.blocker_id === req.user.id);
  user.has_blocked_me = !!(blockRows || []).find((r) => r.blocker_id === req.params.id);

  // Advanced privacy settings: strip fields the profile owner chose to hide.
  // The privacy object itself is the owner's business — never sent to viewers.
  const privacy = user.privacy || {};
  delete user.privacy;
  if (privacy.show_age === false) user.age = null;
  if (privacy.show_country === false) user.country = null;
  if (privacy.show_online === false) {
    user.status = 'offline';
    user.presence = null;
    user.last_seen = null;
  }

  return res.json({ user });
});

export = router;

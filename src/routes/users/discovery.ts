import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { userLimiter } from '../../middleware/rateLimit';
import * as usersRepository from '../../repositories/usersRepository';
import * as swipesRepository from '../../repositories/swipesRepository';
import * as blocksRepository from '../../repositories/blocksRepository';
import * as userGamesRepository from '../../repositories/userGamesRepository';
import * as analytics from '../../services/analytics';
import { areUsersBlocked } from '../../services/blockHelper';
import { searchLimiter } from './shared';
import { discoverQuerySchema, searchQuerySchema } from '../../validation/userSchemas';
import { isEnabled } from '../../services/featureFlags';
import { getIO } from '../../socket/registry';
import { getOnlineSocket } from '../../socket/state';

const likeLimiter = userLimiter({ windowMs: 60 * 1000, max: 60, message: 'Слишком много действий, подожди немного.' });

const likeSchema = z.object({
  targetUserId: z.string().uuid(),
  action: z.enum(['like', 'dislike', 'letter']),
  message: z.string().trim().max(300).optional(),
});
const ACTION_TO_DIRECTION: Record<'dislike' | 'like' | 'letter', 'left' | 'right' | 'super'> = { dislike: 'left', like: 'right', letter: 'super' };

// Ranks candidates by overlap with the viewer's own tastes so the most
// compatible profiles surface first: shared games (heaviest), a matching
// rank inside a shared game, shared languages, and age proximity.
function compatibilityScore(
  me: { age: number | null; languages: string[]; gamesByRank: Map<string, string | null> },
  candidate: any
): number {
  let score = 0;
  const candGames = (candidate.user_games || []) as Array<{ game_id: string; rank: string | null }>;
  for (const g of candGames) {
    if (me.gamesByRank.has(g.game_id)) {
      score += 10; // shared game
      const myRank = me.gamesByRank.get(g.game_id);
      if (myRank && g.rank && String(myRank).toLowerCase() === String(g.rank).toLowerCase()) score += 6; // same rank
    }
  }
  const candLangs = (candidate.languages || []) as string[];
  const sharedLangs = candLangs.filter((l) => me.languages.includes(l)).length;
  score += sharedLangs * 4;

  if (me.age && candidate.age) {
    const diff = Math.abs(me.age - candidate.age);
    if (diff <= 2) score += 5;
    else if (diff <= 5) score += 3;
    else if (diff <= 10) score += 1;
  }
  return score;
}

/**
 * @openapi
 * /api/users/discover:
 *   get:
 *     tags: [Users]
 *     summary: Get a feed of discoverable users to swipe on
 *     description: Excludes the current user, anyone already swiped on, and anyone blocked in either direction. Deliberately NOT cached — see utils/cache.ts for why (personalized, must exclude already-seen profiles).
 *     parameters:
 *       - in: query
 *         name: game_id
 *         schema: { type: string }
 *         description: Filter to users who play this specific game.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/UserSummary'
 *                       - type: object
 *                         properties:
 *                           country: { type: string, nullable: true }
 *                           languages: { type: array, items: { type: string } }
 *                           age: { type: integer, nullable: true }
 *                           gender: { type: string, nullable: true }
 *                           bio: { type: string, nullable: true }
 *                           user_games: { type: array, items: { $ref: '#/components/schemas/UserGame' } }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
/**
 * @openapi
 * /api/users/leaderboard:
 *   get:
 *     tags: [Users]
 *     summary: Most active users by time spent in calls
 *     description: Ranks users by cumulative call time (total_call_seconds), with their average rating. Powers the "most active" board opened from the global chat.
 *     responses:
 *       200: { description: OK }
 */
// Literal path — declared here (before '/:id' in publicProfile.js) so it isn't
// swallowed by the id catch-all.
router.get('/leaderboard', requireAuth, searchLimiter, async (_req: Request, res: Response) => {
  const { data, error } = await usersRepository.getCallLeaderboard(50);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ leaders: data || [] });
});

router.get('/discover', requireAuth, validate({ query: discoverQuerySchema }), async (req: Request, res: Response) => {
  if (!(await isEnabled('discovery.enabled', { userId: req.user.id }))) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Parsed by discoverQuerySchema in validate().
  const { game_id, limit } = req.query as unknown as { game_id?: string; limit: number };
  const uid = req.user.id;

  const { data: swipes } = await swipesRepository.findSwipedTargetIds(uid);
  const excludeIds = (swipes || []).map((s) => s.target_user_id);
  excludeIds.push(uid); // exclude self

  const { data: blockRows } = await blocksRepository.findPairsInvolving(uid);
  (blockRows || []).forEach((r) => {
    excludeIds.push(r.blocker_id === uid ? r.blocked_id : r.blocker_id);
  });

  let gameFilterIds: any = null;
  if (game_id) {
    const { data: gameUsers } = await userGamesRepository.findUserIdsByGame(game_id);
    gameFilterIds = (gameUsers || []).map((r) => r.user_id).filter((id) => !excludeIds.includes(id));
    if (!gameFilterIds.length) return res.json({ users: [] });
  }

  // Pull a larger pool than requested, then rank it by shared interests and
  // return the top `limit`. Capped so the scoring stays cheap.
  const poolLimit = Math.min(50, Math.max(limit * 4, 20));
  const { data: users, error } = await usersRepository.findDiscoverCandidates({
    excludeIds,
    gameFilterIds,
    limit: poolLimit,
  });
  if (error) return res.status(500).json({ error: error.message });

  // Drop anyone who turned off discoverability in their privacy settings.
  const visible = (users || []).filter((u) => !(u.privacy && u.privacy.discoverable === false));

  // Build the viewer's taste profile and rank by compatibility.
  const { data: mine } = await usersRepository.findDiscoveryProfileById(uid);
  const gamesByRank = new Map<string, string | null>();
  (mine?.user_games || []).forEach((g) => gamesByRank.set(g.game_id, g.rank || null));
  const me = { age: mine?.age || null, languages: mine?.languages || [], gamesByRank };

  // Separate binding rather than reassigning `visible`: the ranked list drops
  // the `privacy` field, so it genuinely has a different type.
  const candidates = visible
    .map((u) => {
      // privacy is the owner's business — never expose it to viewers.
      const { privacy, ...clean } = u;
      return { user: clean, score: compatibilityScore(me, u) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.user);

  return res.json({ users: candidates });
});

/**
 * @openapi
 * /api/users/discover/like:
 *   post:
 *     tags: [Users]
 *     summary: React to a discovery profile (like / dislike / letter)
 *     description: |
 *       Replaces the old swipe socket event. `letter` carries an optional short message shown to the
 *       target in their likes inbox. Likes/letters notify the target in real time and detect a mutual match.
 *     responses:
 *       200: { description: OK }
 */
router.post('/discover/like', requireAuth, likeLimiter, validate({ body: likeSchema }), async (req: Request, res: Response) => {
  const uid = req.user.id;
  const { targetUserId, action } = req.body as { targetUserId: string; action: 'like' | 'dislike' | 'letter'; message?: string };
  if (targetUserId === uid) return res.status(400).json({ error: 'Нельзя лайкнуть себя' });

  if (await areUsersBlocked(uid, targetUserId)) {
    return res.status(403).json({ error: 'Пользователь недоступен' });
  }

  const direction = ACTION_TO_DIRECTION[action];
  const message = action === 'letter' ? (req.body.message || '').trim() || null : null;

  const { error } = await swipesRepository.recordSwipe(uid, targetUserId, direction, message);
  if (error) return res.status(500).json({ error: error.message });
  analytics.capture(uid, 'discover_like', { action });

  let matched = false;
  if (direction === 'right' || direction === 'super') {
    const { data: incoming } = await swipesRepository.findIncomingLike(targetUserId, uid);
    matched = Boolean(incoming);

    // Notify the target in real time: either a mutual match, or a new like to
    // show in their likes inbox (with the letter text, if any).
    try {
      const io = getIO();
      const targetSocket = io ? await getOnlineSocket(targetUserId) : null;
      if (io && targetSocket) {
        if (matched) {
          io.to(targetSocket).emit('swipe:match', { with: uid });
        } else {
          // This branch only runs when direction is 'right' or 'super', which
          // ACTION_TO_DIRECTION produces solely for 'like' and 'letter' — a
          // 'dislike' maps to 'left' and never notifies the target. TypeScript
          // narrows `direction`, not `action`, hence the assertion.
          const notifyAction = action as 'like' | 'letter';
          io.to(targetSocket).emit('like:received', { from: uid, action: notifyAction, message });
        }
      }
    } catch (_) { /* realtime notify is best-effort */ }

    if (matched) analytics.capture(uid, 'swipe_match');
  }

  return res.json({ ok: true, matched });
});

/**
 * @openapi
 * /api/users/likes:
 *   get:
 *     tags: [Users]
 *     summary: People who liked me and I haven't answered yet
 *     responses:
 *       200: { description: OK }
 */
router.get('/likes', requireAuth, searchLimiter, async (req: Request, res: Response) => {
  const { data, error } = await swipesRepository.findIncomingLikes(req.user.id, 50);
  if (error) return res.status(500).json({ error: error.message });

  const likes = (data || []).map((row) => {
    const { privacy, ...liker } = row.liker || {};
    if (privacy && privacy.show_age === false) liker.age = null;
    if (privacy && privacy.show_country === false) liker.country = null;
    return {
      action: row.direction === 'super' ? 'letter' : 'like',
      message: row.message || null,
      created_at: row.created_at,
      user: liker,
    };
  });
  return res.json({ likes });
});

/**
 * @openapi
 * /api/users/search:
 *   get:
 *     tags: [Users]
 *     summary: Search users by username
 *     description: |
 *       Two modes depending on `exact`:
 *       - `exact=1`: case-insensitive exact match, returns a single `user` (404 if no match). Used by the "send friend request" flow.
 *       - omitted: live/partial substring match as the user types, returns `users[]` ranked by relevance (exact > prefix > substring match, then shorter names first).
 *     parameters:
 *       - in: query
 *         name: username
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: exact
 *         schema: { type: string }
 *         description: Any truthy value switches to exact-match mode.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 8, maximum: 20 }
 *         description: Only applies in partial-match mode.
 *     responses:
 *       200:
 *         description: OK — shape depends on `exact`
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties: { user: { $ref: '#/components/schemas/UserSummary' } }
 *                 - type: object
 *                   properties: { users: { type: array, items: { $ref: '#/components/schemas/UserSummary' } } }
 *       400:
 *         description: username missing
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: No exact match found (exact mode only)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
// Must stay above /:id (mounted in users/index.ts) so it isn't swallowed by that route.
router.get('/search', requireAuth, searchLimiter, validate({ query: searchQuerySchema }), async (req: Request, res: Response) => {
  // Parsed by searchQuerySchema in validate().
  const { username: raw, exact, limit } = req.query as unknown as { username: string; exact?: string; limit: number };

  if (exact) {
    const { data: user, error } = await usersRepository.findByUsernameExact(raw, req.user.id);

    if (error) return res.status(500).json({ error: error.message });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    return res.json({ user });
  }

  // Escape % and _ so they aren't treated as SQL wildcards by the user's input.
  const escaped = raw.replace(/[%_]/g, (ch) => '\\' + ch);

  const { data: users, error } = await usersRepository.searchByUsername(`%${escaped}%`, req.user.id, 30);

  if (error) return res.status(500).json({ error: error.message });

  const q = raw.toLowerCase();
  const ranked = (users || [])
    .map((u) => {
      const name = (u.username || '').toLowerCase();
      let rank = 3; // plain substring match
      if (name === q) rank = 0;            // exact
      else if (name.startsWith(q)) rank = 1; // prefix match
      else if (name.includes(q)) rank = 2;   // word-ish/other substring
      return { u, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.u.username.length - b.u.username.length)
    .slice(0, limit)
    .map((r) => r.u);

  return res.json({ users: ranked });
});

export = router;

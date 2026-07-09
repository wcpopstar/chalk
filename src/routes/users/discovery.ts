const router = require('express').Router();
const { requireAuth } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const usersRepository = require('../../repositories/usersRepository');
const swipesRepository = require('../../repositories/swipesRepository');
const blocksRepository = require('../../repositories/blocksRepository');
const userGamesRepository = require('../../repositories/userGamesRepository');
const { searchLimiter } = require('./shared');
const { discoverQuerySchema, searchQuerySchema } = require('../../validation/userSchemas');
const { isEnabled } = require('../../services/featureFlags');

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
router.get('/discover', requireAuth, validate({ query: discoverQuerySchema }), async (req: any, res: any) => {
  if (!(await isEnabled('discovery.enabled', { userId: req.user.id }))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { game_id, limit } = req.query;
  const uid = req.user.id;

  const { data: swipes } = await swipesRepository.findSwipedTargetIds(uid);
  const excludeIds = (swipes || []).map((s: any) => s.target_user_id);
  excludeIds.push(uid); // exclude self

  const { data: blockRows } = await blocksRepository.findPairsInvolving(uid);
  (blockRows || []).forEach((r: any) => {
    excludeIds.push(r.blocker_id === uid ? r.blocked_id : r.blocker_id);
  });

  let gameFilterIds: any = null;
  if (game_id) {
    const { data: gameUsers } = await userGamesRepository.findUserIdsByGame(game_id);
    gameFilterIds = (gameUsers || []).map((r: any) => r.user_id).filter((id: any) => !excludeIds.includes(id));
    if (!gameFilterIds.length) return res.json({ users: [] });
  }

  const { data: users, error } = await usersRepository.findDiscoverCandidates({
    excludeIds,
    gameFilterIds,
    limit,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: users || [] });
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
router.get('/search', requireAuth, searchLimiter, validate({ query: searchQuerySchema }), async (req: any, res: any) => {
  const { username: raw, exact, limit } = req.query;

  if (exact) {
    const { data: user, error } = await usersRepository.findByUsernameExact(raw, req.user.id);

    if (error) return res.status(500).json({ error: error.message });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    return res.json({ user });
  }

  // Escape % and _ so they aren't treated as SQL wildcards by the user's input.
  const escaped = raw.replace(/[%_]/g, (ch: any) => '\\' + ch);

  const { data: users, error } = await usersRepository.searchByUsername(`%${escaped}%`, req.user.id, 30);

  if (error) return res.status(500).json({ error: error.message });

  const q = raw.toLowerCase();
  const ranked = (users || [])
    .map((u: any) => {
      const name = (u.username || '').toLowerCase();
      let rank = 3; // plain substring match
      if (name === q) rank = 0;            // exact
      else if (name.startsWith(q)) rank = 1; // prefix match
      else if (name.includes(q)) rank = 2;   // word-ish/other substring
      return { u, rank };
    })
    .sort((a: any, b: any) => a.rank - b.rank || a.u.username.length - b.u.username.length)
    .slice(0, limit)
    .map((r: any) => r.u);

  res.json({ users: ranked });
});

export = router;

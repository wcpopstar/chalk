"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { userLimiter } = require('../middleware/rateLimit');
const { submitScoreSchema, leaderboardQuerySchema } = require('../validation/gameSchemas');
const { supabaseAdmin } = require('../services/supabase');
const { cached, invalidate } = require('../utils/cache');
const { isEnabled } = require('../services/featureFlags');
const LEADERBOARD_CACHE_KEY = 'leaderboard:tetris:top50';
// Short TTL: leaderboard is read constantly but doesn't need to be
// to-the-second accurate — a few seconds of staleness after someone beats
// their high score is an acceptable tradeoff for not re-running 2 full
// table counts on every single page view. Also explicitly invalidated
// below whenever a new score is submitted, so the TTL is really just a
// safety net for invalidation bugs, not the primary freshness mechanism.
const LEADERBOARD_CACHE_TTL_SECONDS = 15;
const scoreLimiter = userLimiter({ windowMs: 60 * 1000, max: 20, message: 'Слишком много отправок результата, подожди немного.' });
// Leaderboard runs a few COUNT queries per call — cap reads too, not just writes.
const leaderboardLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Слишком много запросов, подожди немного.' });
// Kill-switch: if games.tetris.enabled is turned off (e.g. during an
// incident with the leaderboard query), both endpoints below respond 404
// instead of hitting the DB — same as if the feature didn't exist.
async function requireTetrisEnabled(req, res, next) {
    if (!(await isEnabled('games.tetris.enabled', { userId: req.user?.id }))) {
        return res.status(404).json({ error: 'Not found' });
    }
    next();
}
/**
 * @openapi
 * /api/games/tetris/score:
 *   post:
 *     tags: [Games]
 *     summary: Submit a Tetris score
 *     description: Only the best score across all runs is kept (games_played still increments every submission). Invalidates the cached leaderboard since ranking may have changed.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [score]
 *             properties:
 *               score: { type: integer, minimum: 0, maximum: 1000000 }
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 score: { type: integer }
 *                 bestScore: { type: integer }
 *                 gamesPlayed: { type: integer }
 *                 rank: { type: integer }
 *                 totalPlayers: { type: integer }
 *       400:
 *         description: score missing, negative, or out of range
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/tetris/score', requireAuth, requireTetrisEnabled, scoreLimiter, validate({ body: submitScoreSchema }), async (req, res) => {
    const { score } = req.body;
    const uid = req.user.id;
    const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('tetris_scores')
        .select('best_score, games_played')
        .eq('user_id', uid)
        .maybeSingle();
    if (fetchErr)
        return res.status(500).json({ error: fetchErr.message });
    const bestScore = Math.max(score, existing?.best_score || 0);
    const gamesPlayed = (existing?.games_played || 0) + 1;
    const { error: upsertErr } = await supabaseAdmin
        .from('tetris_scores')
        .upsert({ user_id: uid, best_score: bestScore, games_played: gamesPlayed, updated_at: new Date().toISOString() });
    if (upsertErr)
        return res.status(500).json({ error: upsertErr.message });
    // This submission may have changed who's in the top 50 (or their order),
    // so the cached leaderboard is now potentially stale — drop it rather
    // than wait out the TTL. Fire-and-forget: invalidate() already logs its
    // own failures and doesn't need to block this response.
    invalidate(LEADERBOARD_CACHE_KEY);
    // Compute rank: how many players have a strictly higher best_score.
    const { count, error: rankErr } = await supabaseAdmin
        .from('tetris_scores')
        .select('user_id', { count: 'exact', head: true })
        .gt('best_score', bestScore);
    if (rankErr)
        return res.status(500).json({ error: rankErr.message });
    const { count: totalCount } = await supabaseAdmin
        .from('tetris_scores')
        .select('user_id', { count: 'exact', head: true });
    res.json({
        score,
        bestScore,
        gamesPlayed,
        rank: (count || 0) + 1,
        totalPlayers: totalCount || 1,
    });
});
/**
 * @openapi
 * /api/games/tetris/leaderboard:
 *   get:
 *     tags: [Games]
 *     summary: Get the Tetris leaderboard
 *     description: The top-50 portion of this response is served from a short-lived Redis cache (see utils/cache.ts) — up to 15s stale after a new high score, refreshed immediately on submission via explicit invalidation. The `me` section is always computed fresh, never cached.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 50 }
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 top: { type: array, items: { $ref: '#/components/schemas/LeaderboardEntry' } }
 *                 me:
 *                   nullable: true
 *                   type: object
 *                   properties:
 *                     bestScore: { type: integer }
 *                     gamesPlayed: { type: integer }
 *                     rank: { type: integer }
 *                 totalPlayers: { type: integer }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/tetris/leaderboard', requireAuth, requireTetrisEnabled, leaderboardLimiter, validate({ query: leaderboardQuerySchema }), async (req, res) => {
    const { limit } = req.query;
    // Cache the full top-50 as ONE key regardless of the requested limit, and
    // slice it below — avoids needing a separate cache key (and separate
    // invalidation) per distinct ?limit= value a client happens to send.
    let top50;
    try {
        top50 = await cached(LEADERBOARD_CACHE_KEY, LEADERBOARD_CACHE_TTL_SECONDS, async () => {
            const { data, error } = await supabaseAdmin
                .from('tetris_scores')
                .select('user_id, best_score, games_played, users(username, avatar_emoji)')
                .order('best_score', { ascending: false })
                .limit(50);
            if (error)
                throw error;
            return data || [];
        });
    }
    catch (err) {
        return res.status(500).json({ error: err.message });
    }
    const top = top50.slice(0, limit);
    // "me" section is per-viewer — deliberately NOT part of the cached
    // payload above, computed fresh on every request (see utils/cache.ts).
    const uid = req.user.id;
    const { data: mine } = await supabaseAdmin
        .from('tetris_scores')
        .select('best_score, games_played')
        .eq('user_id', uid)
        .maybeSingle();
    let myRank = null;
    let totalPlayers = 0;
    if (mine) {
        const { count } = await supabaseAdmin
            .from('tetris_scores')
            .select('user_id', { count: 'exact', head: true })
            .gt('best_score', mine.best_score);
        myRank = (count || 0) + 1;
    }
    const { count: total } = await supabaseAdmin
        .from('tetris_scores')
        .select('user_id', { count: 'exact', head: true });
    totalPlayers = total || 0;
    res.json({
        top: (top || []).map((row, i) => ({
            rank: i + 1,
            userId: row.user_id,
            username: row.users?.username || 'Игрок',
            avatarEmoji: row.users?.avatar_emoji || '🎮',
            bestScore: row.best_score,
            gamesPlayed: row.games_played,
        })),
        me: mine ? { bestScore: mine.best_score, gamesPlayed: mine.games_played, rank: myRank } : null,
        totalPlayers,
    });
});
module.exports = router;
//# sourceMappingURL=games.js.map
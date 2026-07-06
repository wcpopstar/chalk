export {};
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { userLimiter } = require('../middleware/rateLimit');
const { uuidParam } = require('../validation/common');
const { historyQuerySchema, recordCallSchema, rateMatchSchema } = require('../validation/matchSchemas');
const { supabaseAdmin } = require('../services/supabase');

// History is just a read, so it's kept loose. record-call and rate both
// write, and record-call in particular is triggered by the call-ending flow
// rather than a person clicking a button repeatedly, so cap it generously
// but not unboundedly.
const historyLimiter = userLimiter({ windowMs: 60 * 1000, max: 60, message: 'Слишком много запросов, подожди немного.' });
const writeLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Слишком много запросов, подожди немного.' });

/**
 * @openapi
 * /api/match/history:
 *   get:
 *     tags: [Match]
 *     summary: Get past matchmaking history
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: OK, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { matches: { type: array, items: { $ref: '#/components/schemas/MatchHistoryEntry' } } }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/history', requireAuth, historyLimiter, validate({ query: historyQuerySchema }), async (req: any, res: any) => {
  const { limit, offset } = req.query;
  const uid = req.user.id;

  const { data, error } = await supabaseAdmin
    .from('match_history')
    .select(`
      id, mode, created_at,
      games ( name, emoji ),
      user_a_profile:users!match_history_user_a_fkey ( id, username, avatar_emoji ),
      user_b_profile:users!match_history_user_b_fkey ( id, username, avatar_emoji )
    `)
    .or(`user_a.eq.${uid},user_b.eq.${uid}`)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ matches: data || [] });
});

/**
 * @openapi
 * /api/match/record-call:
 *   post:
 *     tags: [Match]
 *     summary: Record match-history rows for a group call
 *     description: Writes one match_history row per (current user, other participant) pair. Called after a group trial call is promoted to friends, so history reflects everyone who was actually in the room.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [participants]
 *             properties:
 *               participants: { type: array, items: { type: string, format: uuid }, description: 'The current user is excluded automatically if included.' }
 *               mode: { type: string, enum: [solo, group], default: group }
 *               gameId: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 matches:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties: { id: { type: string, format: uuid }, participantId: { type: string, format: uuid } }
 *       400:
 *         description: participants missing or empty
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/record-call', requireAuth, writeLimiter, validate({ body: recordCallSchema }), async (req: any, res: any) => {
  const { participants, mode, gameId } = req.body;

  const rows = participants
    .filter((pid: any) => pid !== req.user.id)
    .map((pid: any) => ({
      id: uuid(),
      user_a: req.user.id,
      user_b: pid,
      game_id: gameId || null,
      mode: mode || 'group',
      created_at: new Date().toISOString(),
    }));

  if (!rows.length) return res.json({ matches: [] });

  const { data, error } = await supabaseAdmin
    .from('match_history')
    .insert(rows)
    .select('id, user_a, user_b');

  if (error) return res.status(500).json({ error: error.message });

  const matches = (data || []).map((row: any) => ({
    id: row.id,
    participantId: row.user_a === req.user.id ? row.user_b : row.user_a,
  }));

  res.json({ matches });
});

/**
 * @openapi
 * /api/match/{matchId}/rate:
 *   post:
 *     tags: [Match]
 *     summary: Rate the other participant of a past match
 *     description: Upserts (one rating per rater per match) and recalculates the rated user's avg_rating across all their ratings.
 *     parameters:
 *       - in: path
 *         name: matchId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               comment: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Rating recorded
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       400:
 *         description: rating missing or out of range (1-5)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Match not found, or current user wasn't a participant
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/:matchId/rate', requireAuth, writeLimiter, validate({ params: uuidParam('matchId'), body: rateMatchSchema }), async (req: any, res: any) => {
  const { rating, comment } = req.body;

  // Find who to rate (the other person in this match)
  const { data: match } = await supabaseAdmin
    .from('match_history')
    .select('user_a, user_b')
    .eq('id', req.params.matchId)
    .or(`user_a.eq.${req.user.id},user_b.eq.${req.user.id}`)
    .single();

  if (!match) return res.status(404).json({ error: 'Match not found' });

  const ratedUserId = match.user_a === req.user.id ? match.user_b : match.user_a;

  const { error } = await supabaseAdmin.from('ratings').upsert({
    match_id:       req.params.matchId,
    rater_user_id:  req.user.id,
    rated_user_id:  ratedUserId,
    rating,
    comment: comment || null,
    created_at: new Date().toISOString(),
  }, { onConflict: 'match_id,rater_user_id' });

  if (error) return res.status(500).json({ error: error.message });

  // Recalculate avg rating for the rated user
  const { data: avgRow } = await supabaseAdmin
    .from('ratings')
    .select('rating')
    .eq('rated_user_id', ratedUserId);

  if (avgRow && avgRow.length) {
    const avg = avgRow.reduce((s: any, r: any) => s + r.rating, 0) / avgRow.length;
    await supabaseAdmin.from('users').update({ avg_rating: parseFloat(avg.toFixed(2)) }).eq('id', ratedUserId);
  }

  res.json({ ok: true });
});

module.exports = router;

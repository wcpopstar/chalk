import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { userLimiter } from '../middleware/rateLimit';
import { uuidParam } from '../validation/common';
import { historyQuerySchema, recordCallSchema, rateMatchSchema } from '../validation/matchSchemas';
import { supabaseAdmin } from '../services/supabase';
import { wereRecentCallPartners } from '../socket/state';

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
router.get('/history', requireAuth, historyLimiter, validate({ query: historyQuerySchema }), async (req: Request, res: Response) => {
  // Parsed by historyQuerySchema (paginationQuery) in validate().
  const { limit, offset } = req.query as unknown as { limit: number; offset: number };
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
  return res.json({ matches: data || [] });
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
router.post('/record-call', requireAuth, writeLimiter, validate({ body: recordCallSchema }), async (req: Request, res: Response) => {
  const { participants, mode, gameId } = req.body as { participants: string[]; mode?: string; gameId?: string | null };

  // The client picks who was "in the call" — without verifying that against
  // the actual call state, anyone could fabricate match_history rows against
  // an arbitrary user id and then post a fake rating for it via
  // POST /:matchId/rate. Only keep participants Redis actually recorded as
  // having shared a room with the caller (same check friends.ts uses to gate
  // "add friend from call").
  const verified = await Promise.all(
    participants
      .filter((pid) => pid !== req.user.id)
      .map(async (pid) => ((await wereRecentCallPartners(req.user.id, pid)) ? pid : null)),
  );

  const rows = verified
    .filter((pid): pid is string => pid !== null)
    .map((pid) => ({
      id: uuid(),
      user_a: req.user.id,
      user_b: pid,
      game_id: gameId || null,
      mode: mode || 'group',
      // Participants above passed the Redis call-partner check, so this row
      // is backed by a real shared call (surfaced as the "confirmed call"
      // badge on ratings; pre-migration rows stay false).
      verified: true,
      created_at: new Date().toISOString(),
    }));

  if (!rows.length) return res.json({ matches: [] });

  const { data, error } = await supabaseAdmin
    .from('match_history')
    .insert(rows)
    .select('id, user_a, user_b');

  if (error) return res.status(500).json({ error: error.message });

  const matches = (data || []).map((row) => ({
    id: row.id,
    participantId: row.user_a === req.user.id ? row.user_b : row.user_a,
  }));

  return res.json({ matches });
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
router.post('/:matchId/rate', requireAuth, writeLimiter, validate({ params: uuidParam('matchId'), body: rateMatchSchema }), async (req: Request, res: Response) => {
  const { rating, comment } = req.body;

  // Find who to rate (the other person in this match)
  const { data: match } = await supabaseAdmin
    .from('match_history')
    .select('user_a, user_b')
    .eq('id', req.params.matchId!)
    .or(`user_a.eq.${req.user.id},user_b.eq.${req.user.id}`)
    .single();

  if (!match) return res.status(404).json({ error: 'Match not found' });

  const ratedUserId = match.user_a === req.user.id ? match.user_b : match.user_a;

  const { error } = await supabaseAdmin.from('ratings').upsert({
    match_id:       req.params.matchId!,
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
    const avg = avgRow.reduce((s, r) => s + r.rating, 0) / avgRow.length;
    await supabaseAdmin.from('users').update({ avg_rating: parseFloat(avg.toFixed(2)) }).eq('id', ratedUserId);
  }

  return res.json({ ok: true });
});

export = router;

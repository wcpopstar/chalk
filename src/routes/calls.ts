import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { userLimiter } from '../middleware/rateLimit';
import { uuidParam } from '../validation/common';
import { startCallSchema, endCallSchema } from '../validation/callSchemas';
import { supabaseAdmin } from '../services/supabase';
import * as analytics from '../services/analytics';

// Call lifecycle writes — generous enough for normal use (nobody starts more
// than a handful of calls a minute) while capping a runaway client/script.
const callLimiter = userLimiter({ windowMs: 60 * 1000, max: 20, message: 'Слишком много запросов звонков, подожди немного.' });

// NOTE: Agora RTC tokens are issued by /api/agora/token (see routes/agora.js),
// which handles the UUID -> numeric-uid hashing the client needs. This file
// only logs call lifecycle events to the `calls` table.

/**
 * @openapi
 * /api/calls/start:
 *   post:
 *     tags: [Calls]
 *     summary: Log the start of a call
 *     description: Records a call as active in the database. Voice/video signaling itself happens over Socket.io (see match.js) — this endpoint is purely for history/analytics.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               roomId: { type: string, format: uuid, description: 'Defaults to a new random id if omitted' }
 *               participants: { type: array, items: { type: string, format: uuid }, description: 'Defaults to [current user] if omitted' }
 *               mode: { type: string, enum: [solo, group], default: solo }
 *     responses:
 *       201:
 *         description: Call logged
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { call: { $ref: '#/components/schemas/Call' } }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
// Logs a call start in the DB
router.post('/start', requireAuth, callLimiter, validate({ body: startCallSchema }), async (req: Request, res: Response) => {
  const { roomId, participants, mode } = req.body;

  const { data, error } = await supabaseAdmin.from('calls').insert({
    id: roomId || uuid(),
    initiated_by: req.user.id,
    participants: participants || [req.user.id],
    mode: mode || 'solo',
    started_at: new Date().toISOString(),
    status: 'active',
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  analytics.capture(req.user.id, 'call_started', { mode: mode || 'solo', participants: (participants || [req.user.id]).length });
  return res.status(201).json({ call: data });
});

/**
 * @openapi
 * /api/calls/{id}/end:
 *   patch:
 *     tags: [Calls]
 *     summary: Log the end of a call
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               duration_seconds: { type: integer, nullable: true }
 *     responses:
 *       200:
 *         description: Call marked ended
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.patch('/:id/end', requireAuth, callLimiter, validate({ params: uuidParam(), body: endCallSchema }), async (req: Request, res: Response) => {
  const { duration_seconds } = req.body;

  const { error } = await supabaseAdmin.from('calls').update({
    ended_at: new Date().toISOString(),
    duration_seconds: duration_seconds ?? null,
    status: 'ended',
  }).eq('id', req.params.id!);

  if (error) return res.status(500).json({ error: error.message });
  analytics.capture(req.user.id, 'call_ended', { durationSeconds: duration_seconds ?? null });
  return res.json({ ok: true });
});

/**
 * @openapi
 * /api/calls/activity:
 *   post:
 *     tags: [Calls]
 *     summary: Report the current user's time spent in a just-ended call
 *     description: Bumps the user's cumulative call-activity counters (total_call_seconds/total_calls) that power the "most active users" leaderboard. Each participant reports the duration their own client measured, so every participant's counter advances. Seconds are clamped to [0, 6h].
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties: { seconds: { type: integer, minimum: 0 } }
 *     responses:
 *       200: { description: Counters updated }
 */
router.post('/activity', requireAuth, callLimiter, async (req: Request, res: Response) => {
  // Clamp to a sane range so a bad/hostile client can't inflate the board.
  const raw = parseInt(String((req.body && req.body.seconds) ?? ''), 10);
  const seconds = Number.isFinite(raw) ? Math.max(0, Math.min(6 * 60 * 60, raw)) : 0;
  if (!seconds) return res.json({ ok: true });

  const { error } = await supabaseAdmin.rpc('increment_call_activity', { p_user_id: req.user.id, p_seconds: seconds });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

export = router;

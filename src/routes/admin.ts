import type { Request, Response } from 'express';
const router = require('express').Router();
const { z } = require('zod');
const { requireAdminKey } = require('../middleware/requireAdminKey');
const { validate } = require('../middleware/validate');
const { uuidParam } = require('../validation/common');
const { userLimiter } = require('../middleware/rateLimit');
const { revokeAllForUser } = require('../services/refreshTokens');
import { supabaseAdmin } from '../services/supabase';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'admin' });

// Ops tool traffic — same limiter style as the feature-flag admin endpoints
// (userLimiter keys on IP when there's no authenticated req.user).
const adminLimiter = userLimiter({ windowMs: 60 * 1000, max: 60, message: 'Too many admin requests' });

// Far-future timestamp = permanent ban (no cron needed to expire anything).
const PERMANENT = '2999-01-01T00:00:00.000Z';

const usersQuerySchema = z.object({
  q: z.string().trim().max(60).optional(),
  banned: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const banBodySchema = z.object({
  // Ban length in hours; omitted/0 → permanent.
  hours: z.coerce.number().int().min(0).max(24 * 365).optional(),
  reason: z.string().trim().max(300).optional(),
});
const reportsQuerySchema = z.object({
  status: z.enum(['open', 'reviewed', 'dismissed']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const reportStatusSchema = z.object({
  status: z.enum(['reviewed', 'dismissed']),
});

const USER_FIELDS = 'id, username, email, avatar_emoji, avatar_url, created_at, last_seen, status, banned_until, ban_reason';

/**
 * @openapi
 * /api/admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List/search users (admin)
 *     description: Requires the x-admin-key header. ?q= searches username/email, ?banned=true lists only currently-banned accounts.
 *     security: [{ adminKey: [] }]
 *     parameters:
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: banned, schema: { type: boolean } }
 *       - { in: query, name: limit, schema: { type: integer, default: 50, maximum: 100 } }
 *     responses:
 *       200: { description: OK }
 *       401: { description: Invalid or missing admin key }
 */
router.get('/users', requireAdminKey, adminLimiter, validate({ query: usersQuerySchema }), async (req: Request, res: Response) => {
  const { q, banned, limit } = req.query as unknown as { q?: string; banned?: boolean; limit: number };

  let query = supabaseAdmin
    .from('users')
    .select(USER_FIELDS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (q) {
    // Escape PostgREST or() specials so a search string can't inject filters.
    const safe = q.replace(/[,()]/g, ' ').trim();
    query = query.or(`username.ilike.%${safe}%,email.ilike.%${safe}%`);
  }
  if (banned) query = query.gt('banned_until', new Date().toISOString());

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ users: data || [] });
});

/**
 * @openapi
 * /api/admin/users/{id}/ban:
 *   post:
 *     tags: [Admin]
 *     summary: Ban a user (admin)
 *     description: Timed (hours) or permanent (hours omitted/0). Revokes all their refresh tokens and disconnects their live sockets — they can't log back in until the ban lapses or an unban.
 *     security: [{ adminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hours: { type: integer, minimum: 0, description: '0 or omitted = permanent' }
 *               reason: { type: string, maxLength: 300 }
 *     responses:
 *       200: { description: Banned }
 *       404: { description: No such user }
 *       401: { description: Invalid or missing admin key }
 */
router.post('/users/:id/ban', requireAdminKey, adminLimiter, validate({ params: uuidParam(), body: banBodySchema }), async (req: Request, res: Response) => {
  const userId = req.params.id!;
  const { hours, reason } = req.body as { hours?: number; reason?: string };

  const bannedUntil = hours && hours > 0
    ? new Date(Date.now() + hours * 3600 * 1000).toISOString()
    : PERMANENT;

  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ banned_until: bannedUntil, ban_reason: reason || null })
    .eq('id', userId)
    .select('id, username')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'No such user' });

  // Cut off everything already issued: refresh tokens die now; any live
  // sockets get kicked. (A still-valid access token survives at most its
  // ~15-minute TTL for REST calls, and can't be renewed.)
  await revokeAllForUser(userId);
  try {
    const { getIO } = require('../socket/registry');
    const { getOnlineSocket } = require('../socket/state');
    const io = getIO();
    const socketId = io ? await getOnlineSocket(userId) : null;
    if (io && socketId) {
      io.to(socketId).emit('auth:expired');
      io.in(socketId).disconnectSockets(true);
    }
  } catch (e) {
    logger.warn({ err: e, userId }, 'Could not disconnect banned user socket (non-fatal)');
  }

  logger.info({ userId, username: data.username, bannedUntil, reason }, 'User banned');
  return res.json({ ok: true, userId, bannedUntil, reason: reason || null });
});

/**
 * @openapi
 * /api/admin/users/{id}/unban:
 *   post:
 *     tags: [Admin]
 *     summary: Lift a user's ban (admin)
 *     security: [{ adminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Unbanned }
 *       404: { description: No such user }
 *       401: { description: Invalid or missing admin key }
 */
router.post('/users/:id/unban', requireAdminKey, adminLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  const userId = req.params.id!;
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ banned_until: null, ban_reason: null })
    .eq('id', userId)
    .select('id, username')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'No such user' });
  logger.info({ userId, username: data.username }, 'User unbanned');
  return res.json({ ok: true, userId });
});

/**
 * @openapi
 * /api/admin/reports:
 *   get:
 *     tags: [Admin]
 *     summary: List user reports (admin)
 *     security: [{ adminKey: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [open, reviewed, dismissed], default: open } }
 *       - { in: query, name: limit, schema: { type: integer, default: 50, maximum: 100 } }
 *     responses:
 *       200: { description: OK }
 *       401: { description: Invalid or missing admin key }
 */
router.get('/reports', requireAdminKey, adminLimiter, validate({ query: reportsQuerySchema }), async (req: Request, res: Response) => {
  const { status, limit } = req.query as unknown as { status: string; limit: number };
  const { data, error } = await supabaseAdmin
    .from('reports')
    .select(`
      id, reason, details, context, status, created_at,
      reporter:users!reports_reporter_id_fkey ( id, username ),
      reported:users!reports_reported_id_fkey ( id, username, banned_until )
    `)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ reports: data || [] });
});

/**
 * @openapi
 * /api/admin/reports/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Resolve a report (admin)
 *     security: [{ adminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties: { status: { type: string, enum: [reviewed, dismissed] } }
 *     responses:
 *       200: { description: Updated }
 *       404: { description: No such report }
 *       401: { description: Invalid or missing admin key }
 */
router.patch('/reports/:id', requireAdminKey, adminLimiter, validate({ params: uuidParam(), body: reportStatusSchema }), async (req: Request, res: Response) => {
  const { status } = req.body as { status: string };
  const { data, error } = await supabaseAdmin
    .from('reports')
    .update({ status })
    .eq('id', req.params.id!)
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'No such report' });
  return res.json({ ok: true, id: data.id, status });
});

export = router;

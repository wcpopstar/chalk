import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { uuidParam } from '../../validation/common';
import { reportBodySchema } from '../../validation/userSchemas';
import { userLimiter } from '../../middleware/rateLimit';
import * as blocksRepository from '../../repositories/blocksRepository';
import * as reportsRepository from '../../repositories/reportsRepository';
import { blockUser, unblockUser } from '../../services/blockHelper';
import { moderationLimiter } from './shared';

const blockedListLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Слишком много запросов, подожди немного.' });

/**
 * @openapi
 * /api/users/me/blocked:
 *   get:
 *     tags: [Users]
 *     summary: List users blocked by the current user
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 blocked:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       created_at: { type: string, format: date-time }
 *                       blocked: { $ref: '#/components/schemas/UserSummary' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
// Must stay above /:id.
router.get('/me/blocked', requireAuth, blockedListLimiter, async (req: Request, res: Response) => {
  const { data, error } = await blocksRepository.listBlockedByUser(req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ blocked: (data || []).filter((r) => r.blocked) });
});

/**
 * @openapi
 * /api/users/{id}/block:
 *   post:
 *     tags: [Users]
 *     summary: Block a user
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
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       400:
 *         description: Cannot block yourself
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/:id/block', requireAuth, moderationLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  // `!` here (and at the other :id routes below): noUncheckedIndexedAccess types
  // req.params.id as `string | undefined`, but validate({ params: uuidParam() })
  // has already rejected the request if it isn't a uuid.
  const targetId = req.params.id!;
  const uid = req.user.id;
  if (targetId === uid) return res.status(400).json({ error: 'Cannot block yourself' });

  try {
    await blockUser(uid, targetId);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /api/users/{id}/block:
 *   delete:
 *     tags: [Users]
 *     summary: Unblock a user
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
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.delete('/:id/block', requireAuth, moderationLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  try {
    await unblockUser(req.user.id, req.params.id!);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /api/users/{id}/report:
 *   post:
 *     tags: [Users]
 *     summary: Report a user
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, enum: [harassment, hate_speech, spam, inappropriate_content, scam, underage, other] }
 *               details: { type: string, maxLength: 1000, nullable: true }
 *               context: { type: string, maxLength: 50, nullable: true, description: 'Where the report was filed from, e.g. "profile" or "chat".' }
 *     responses:
 *       201:
 *         description: Report filed
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       400:
 *         description: Invalid reason, details too long, or reporting yourself
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post(
  '/:id/report',
  requireAuth,
  moderationLimiter,
  validate({ params: uuidParam(), body: reportBodySchema }),
  async (req: Request, res: Response) => {
    const targetId = req.params.id!;
    const uid = req.user.id;
    const { reason, details, context } = req.body;

    if (targetId === uid) return res.status(400).json({ error: 'Cannot report yourself' });

    const { error } = await reportsRepository.create({
      id: uuid(),
      reporterId: uid,
      reportedId: targetId,
      reason,
      details: details || null,
      context: context || null,
      createdAt: new Date().toISOString(),
    });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ ok: true });
  }
);

export = router;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { uuidParam } = require('../../validation/common');
const { reportBodySchema } = require('../../validation/userSchemas');
const { userLimiter } = require('../../middleware/rateLimit');
const blocksRepository = require('../../repositories/blocksRepository');
const reportsRepository = require('../../repositories/reportsRepository');
const { blockUser, unblockUser } = require('../../services/blockHelper');
const { moderationLimiter } = require('./shared');
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
router.get('/me/blocked', requireAuth, blockedListLimiter, async (req, res) => {
    const { data, error } = await blocksRepository.listBlockedByUser(req.user.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.json({ blocked: (data || []).filter((r) => r.blocked) });
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
router.post('/:id/block', requireAuth, moderationLimiter, validate({ params: uuidParam() }), async (req, res) => {
    const targetId = req.params.id;
    const uid = req.user.id;
    if (targetId === uid)
        return res.status(400).json({ error: 'Cannot block yourself' });
    try {
        await blockUser(uid, targetId);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
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
router.delete('/:id/block', requireAuth, moderationLimiter, validate({ params: uuidParam() }), async (req, res) => {
    try {
        await unblockUser(req.user.id, req.params.id);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
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
router.post('/:id/report', requireAuth, moderationLimiter, validate({ params: uuidParam(), body: reportBodySchema }), async (req, res) => {
    const targetId = req.params.id;
    const uid = req.user.id;
    const { reason, details, context } = req.body;
    if (targetId === uid)
        return res.status(400).json({ error: 'Cannot report yourself' });
    const { error } = await reportsRepository.create({
        id: uuid(),
        reporterId: uid,
        reportedId: targetId,
        reason,
        details: details || null,
        context: context || null,
        createdAt: new Date().toISOString(),
    });
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json({ ok: true });
});
module.exports = router;
//# sourceMappingURL=moderation.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { uuidParam } = require('../validation/common');
const { targetUserBodySchema } = require('../validation/friendSchemas');
const { userLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../services/supabase');
const { addFriendPairInstant } = require('../services/friendsHelper');
const { areUsersBlocked } = require('../services/blockHelper');
const { wereRecentCallPartners } = require('../socket/state');
// Sending friend requests is a one-click action — cap it so someone can't
// script-spam requests at every user id on the platform.
const friendRequestLimiter = userLimiter({ windowMs: 60 * 1000, max: 15, message: 'Слишком много заявок в друзья, подожди немного.' });
// Accept/delete are one-click actions too, just lower-stakes than sending a
// request — still capped against a mash-click/script.
const friendActionLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Слишком много действий, подожди немного.' });
// Friends list is polled by the client — loose but not unbounded.
const friendsReadLimiter = userLimiter({ windowMs: 60 * 1000, max: 60, message: 'Слишком много запросов, подожди немного.' });
/**
 * @openapi
 * /api/friends:
 *   get:
 *     tags: [Friends]
 *     summary: List friends and pending friend requests
 *     description: Returns both accepted friends and pending requests (incoming and outgoing) for the current user.
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 friends: { type: array, items: { $ref: '#/components/schemas/Friend' } }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/', requireAuth, friendsReadLimiter, async (req, res) => {
    const uid = req.user.id;
    const { data, error } = await supabaseAdmin
        .from('friends')
        .select(`
      id, status, created_at,
      user_a_profile:users!friends_user_a_fkey ( id, username, avatar_emoji, avatar_url, status, presence, last_seen ),
      user_b_profile:users!friends_user_b_fkey ( id, username, avatar_emoji, avatar_url, status, presence, last_seen )
    `)
        .or(`user_a.eq.${uid},user_b.eq.${uid}`)
        .order('created_at', { ascending: false });
    if (error)
        return res.status(500).json({ error: error.message });
    // Normalise so "friend" is always the other person
    const friends = (data || []).map((row) => {
        const isA = row.user_a_profile.id === uid;
        const other = isA ? row.user_b_profile : row.user_a_profile;
        // For pending requests: incoming = true means *this* user is the recipient (user_b)
        return { id: row.id, status: row.status, friend: other, incoming: !isA, created_at: row.created_at };
    });
    res.json({ friends });
});
/**
 * @openapi
 * /api/friends/request:
 *   post:
 *     tags: [Friends]
 *     summary: Send a friend request
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetUserId]
 *             properties:
 *               targetUserId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Request created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { request: { $ref: '#/components/schemas/FriendRequestRecord' } }
 *       400:
 *         description: Cannot add yourself
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       403:
 *         description: One of the users has blocked the other
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       409:
 *         description: Already friends, or a request already exists between these users
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/request', requireAuth, friendRequestLimiter, validate({ body: targetUserBodySchema }), async (req, res) => {
    const { targetUserId } = req.body;
    const uid = req.user.id;
    if (targetUserId === uid)
        return res.status(400).json({ error: 'Cannot add yourself' });
    if (await areUsersBlocked(uid, targetUserId)) {
        return res.status(403).json({ error: 'Нельзя добавить в друзья — пользователь заблокирован' });
    }
    // Check if already exists (accepted or pending)
    const { data: existingRows } = await supabaseAdmin
        .from('friends')
        .select('id, status')
        .or(`and(user_a.eq.${uid},user_b.eq.${targetUserId}),and(user_a.eq.${targetUserId},user_b.eq.${uid})`);
    const existing = (existingRows || [])[0];
    if (existing) {
        if (existing.status === 'accepted') {
            return res.status(409).json({ error: 'Already friends', alreadyFriend: true, status: existing.status });
        }
        return res.status(409).json({ error: 'Friend request already exists', status: existing.status });
    }
    const { data, error } = await supabaseAdmin
        .from('friends')
        .insert({
        id: uuid(),
        user_a: uid,
        user_b: targetUserId,
        status: 'pending',
        created_at: new Date().toISOString(),
    })
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json({ request: data });
});
/**
 * @openapi
 * /api/friends/{id}/accept:
 *   patch:
 *     tags: [Friends]
 *     summary: Accept an incoming friend request
 *     description: Only the recipient (user_b) of a pending request can accept it.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Accepted
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Ok' }
 *       404:
 *         description: Request not found, already handled, or you're not the recipient
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.patch('/:id/accept', requireAuth, friendActionLimiter, validate({ params: uuidParam() }), async (req, res) => {
    const { data: row } = await supabaseAdmin
        .from('friends')
        .select('id, user_a, user_b, status')
        .eq('id', req.params.id)
        .eq('user_b', req.user.id) // only the recipient can accept
        .eq('status', 'pending')
        .single();
    if (!row)
        return res.status(404).json({ error: 'Request not found or already handled' });
    const { error } = await supabaseAdmin
        .from('friends')
        .update({ status: 'accepted' })
        .eq('id', req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});
/**
 * @openapi
 * /api/friends/{id}:
 *   delete:
 *     tags: [Friends]
 *     summary: Remove a friend or cancel/decline a request
 *     description: Works for both accepted friendships and pending requests (from either side). Idempotent — succeeds even if the row didn't exist or belonged to someone else (deletes 0 rows silently).
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
router.delete('/:id', requireAuth, friendActionLimiter, validate({ params: uuidParam() }), async (req, res) => {
    const uid = req.user.id;
    const { error } = await supabaseAdmin
        .from('friends')
        .delete()
        .eq('id', req.params.id)
        .or(`user_a.eq.${uid},user_b.eq.${uid}`);
    if (error)
        return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});
/**
 * @openapi
 * /api/friends/add-after-call:
 *   post:
 *     tags: [Friends]
 *     summary: Instantly befriend someone you just called (no pending state)
 *     description: Only allowed if the two users were recent call partners (checked server-side via Redis call-partner tracking, not trusted from the client) and aren't blocking each other.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetUserId]
 *             properties:
 *               targetUserId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Already were friends
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { ok: { type: boolean }, already: { type: boolean, example: true } }
 *       201:
 *         description: Friendship created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { ok: { type: boolean }, already: { type: boolean, example: false } }
 *       400:
 *         description: targetUserId missing, or is the current user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       403:
 *         description: Not recent call partners, or one has blocked the other
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/add-after-call', requireAuth, friendRequestLimiter, validate({ body: targetUserBodySchema }), async (req, res) => {
    const { targetUserId } = req.body;
    const uid = req.user.id;
    if (targetUserId === uid)
        return res.status(400).json({ error: 'Cannot add yourself' });
    if (!(await wereRecentCallPartners(uid, targetUserId))) {
        return res.status(403).json({ error: 'У вас не было общего звонка с этим пользователем' });
    }
    if (await areUsersBlocked(uid, targetUserId)) {
        return res.status(403).json({ error: 'Нельзя добавить в друзья — пользователь заблокирован' });
    }
    try {
        const result = await addFriendPairInstant(uid, targetUserId);
        res.status(result.already ? 200 : 201).json({ ok: true, already: result.already });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
module.exports = router;
//# sourceMappingURL=friends.js.map
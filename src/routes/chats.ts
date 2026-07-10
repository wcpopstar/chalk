import type { Request, Response } from 'express';
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { uuidParam } = require('../validation/common');
const { createDirectSchema, createGroupSchema, messagesQuerySchema } = require('../validation/chatSchemas');
const { userLimiter } = require('../middleware/rateLimit');
import { supabaseAdmin } from '../services/supabase';

// "Message" buttons get-or-create a DM, so this is hit a lot legitimately —
// keep it loose. Group creation actually writes new rows, so keep it tighter.
const dmLimiter    = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Слишком много запросов, подожди немного.' });
const groupLimiter = userLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: 'Слишком много групп создано, подожди немного.' });
// Reads (conversation list, message history, members) — loose since normal
// chat use polls these, but still capped against a scripted scrape.
const readLimiter  = userLimiter({ windowMs: 60 * 1000, max: 90, message: 'Слишком много запросов, подожди немного.' });

/**
 * @openapi
 * /api/chats:
 *   get:
 *     tags: [Chats]
 *     summary: List all conversations for the current user
 *     description: Direct and group conversations, each with its last message and (for direct chats) the other participant's profile.
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 conversations: { type: array, items: { $ref: '#/components/schemas/Conversation' } }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
// All conversations for current user
router.get('/', requireAuth, readLimiter, async (req: Request, res: Response) => {
  const uid = req.user.id;

  const { data, error } = await supabaseAdmin
    .from('conversation_members')
    .select(`
      conversation_id,
      conversations (
        id, type, name, created_at,
        messages ( id, text, type, deleted_at, sender_id, created_at )
      )
    `)
    .eq('user_id', uid)
    .order('created_at', { referencedTable: 'conversations', ascending: false })
    // Only the LAST message of each conversation is ever used (the list
    // preview) — without this order+limit the embed shipped the ENTIRE
    // message history of every chat on every open of the Chats tab, so the
    // endpoint got slower as histories grew. messages_conv_idx
    // (conversation_id, created_at DESC) serves this exactly.
    .order('created_at', { referencedTable: 'conversations.messages', ascending: false })
    .limit(1, { referencedTable: 'conversations.messages' });

  if (error) return res.status(500).json({ error: error.message });

  // For direct (1:1) conversations the client needs to know *who* the other
  // person is — both to show a real name and to be able to call them.
  const directConvIds = (data || [])
    .filter((row) => row.conversations?.type === 'direct')
    .map((row) => row.conversation_id);

  const otherUserByConv: Record<string, any> = {};
  if (directConvIds.length) {
    const { data: memberRows } = await supabaseAdmin
      .from('conversation_members')
      .select('conversation_id, users ( id, username, avatar_emoji, avatar_url, status )')
      .in('conversation_id', directConvIds)
      .neq('user_id', uid);

    (memberRows || []).forEach((row) => {
      otherUserByConv[row.conversation_id] = row.users;
    });
  }

  // Attach last message and the other participant (for direct chats)
  const conversations = (data || []).map((row) => {
    const conv  = row.conversations;
    const msgs  = conv?.messages || [];
    const last  = msgs[0] || null; // newest-first + limit 1 in the query above
    const otherUser = conv?.type === 'direct' ? (otherUserByConv[conv.id] || null) : null;
    return {
      id: conv.id,
      type: conv.type,
      name: conv.type === 'direct' ? (otherUser?.username || conv.name) : conv.name,
      other_user: otherUser,
      last_message: last,
      created_at: conv.created_at,
    };
  });

  return res.json({ conversations });
});

/**
 * @openapi
 * /api/chats/direct:
 *   post:
 *     tags: [Chats]
 *     summary: Get or create a direct (1:1) conversation
 *     description: Idempotent — if a DM already exists with this user, returns the existing conversation instead of creating a duplicate.
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
 *         description: Existing conversation returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { conversation: { type: object, properties: { id: { type: string, format: uuid } } } }
 *       201:
 *         description: New conversation created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { conversation: { type: object, properties: { id: { type: string, format: uuid }, type: { type: string }, created_at: { type: string, format: date-time } } } }
 *       400:
 *         description: targetUserId missing
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
// Get or create a DM conversation with another user
router.post('/direct', requireAuth, dmLimiter, validate({ body: createDirectSchema }), async (req: Request, res: Response) => {
  const { targetUserId } = req.body;
  const uid = req.user.id;

  // Check if DM already exists between these two
  const { data: existing } = await supabaseAdmin.rpc('find_direct_conversation', {
    user_a: uid,
    user_b: targetUserId,
  });

  if (existing && existing.length) {
    return res.json({ conversation: existing[0] });
  }

  // Create new conversation
  const convId = uuid();
  const { data: conv, error: convErr } = await supabaseAdmin
    .from('conversations')
    .insert({ id: convId, type: 'direct', created_at: new Date().toISOString() })
    .select()
    .single();

  if (convErr) return res.status(500).json({ error: convErr.message });

  // Add both members
  await supabaseAdmin.from('conversation_members').insert([
    { conversation_id: convId, user_id: uid },
    { conversation_id: convId, user_id: targetUserId },
  ]);

  return res.status(201).json({ conversation: conv });
});

/**
 * @openapi
 * /api/chats/group:
 *   post:
 *     tags: [Chats]
 *     summary: Create a group conversation
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [memberIds]
 *             properties:
 *               name: { type: string, default: Group }
 *               memberIds: { type: array, items: { type: string, format: uuid }, description: 'The current user is added automatically if not included.' }
 *     responses:
 *       201:
 *         description: Group created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { conversation: { type: object, properties: { id: { type: string, format: uuid }, type: { type: string }, name: { type: string } } } }
 *       400:
 *         description: memberIds missing or empty
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/group', requireAuth, groupLimiter, validate({ body: createGroupSchema }), async (req: Request, res: Response) => {
  const { name, memberIds } = req.body;
  const uid = req.user.id;

  const convId = uuid();
  const { data: conv, error } = await supabaseAdmin
    .from('conversations')
    .insert({ id: convId, type: 'group', name: name || 'Group', created_at: new Date().toISOString() })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const allMembers = [...new Set([uid, ...memberIds])];
  await supabaseAdmin.from('conversation_members').insert(
    allMembers.map(user_id => ({ conversation_id: convId, user_id }))
  );

  return res.status(201).json({ conversation: conv });
});

/**
 * @openapi
 * /api/chats/global/messages:
 *   get:
 *     tags: [Chats]
 *     summary: Get global (platform-wide) chat history
 *     description: Readable by every authenticated user — no membership check, unlike direct/group conversations.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: before
 *         schema: { type: string, format: date-time }
 *         description: Return messages created before this timestamp (pagination cursor).
 *     responses:
 *       200:
 *         description: OK, oldest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { messages: { type: array, items: { $ref: '#/components/schemas/Message' } } }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/global/messages', requireAuth, readLimiter, validate({ query: messagesQuerySchema }), async (req: Request, res: Response) => {
  const { limit, before } = req.query as unknown as { limit: number; before?: string };

  let query = supabaseAdmin
    .from('global_messages')
    .select(`
      id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
      preview_title, preview_url, preview_thumbnail, preview_video_id,
      sender:users!global_messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )
    `)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  return res.json({ messages: (data || []).reverse() });
});

/**
 * @openapi
 * /api/chats/{id}/messages:
 *   get:
 *     tags: [Chats]
 *     summary: Get message history for a direct or group conversation
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: before
 *         schema: { type: string, format: date-time }
 *         description: Return messages created before this timestamp (pagination cursor).
 *     responses:
 *       200:
 *         description: OK, oldest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { messages: { type: array, items: { $ref: '#/components/schemas/Message' } } }
 *       403:
 *         description: Not a member of this conversation
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:id/messages', requireAuth, readLimiter, validate({ params: uuidParam(), query: messagesQuerySchema }), async (req: Request, res: Response) => {
  const { limit, before } = req.query as unknown as { limit: number; before?: string };
  const uid  = req.user.id;
  const convId = req.params.id!; // validated by uuidParam()

  // Verify membership
  const { data: member } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', convId)
    .eq('user_id', uid)
    .maybeSingle();

  if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

  let query = supabaseAdmin
    .from('messages')
    .select(`
      id, sender_id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
      preview_title, preview_url, preview_thumbnail, preview_video_id, reply_to_id,
      sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url ),
      reply_to:messages!messages_reply_to_id_fkey ( id, text, type, deleted_at, sender_id, sender:users!messages_sender_id_fkey ( username ) )
    `)
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Per-member read watermarks, so the client can render ✓/✓✓ on its own
  // messages from the initial load (live updates arrive via the chat:read
  // socket event).
  const { data: reads } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id, last_read_at')
    .eq('conversation_id', convId);

  return res.json({ messages: (data || []).reverse(), reads: reads || [] });
});

/**
 * @openapi
 * /api/chats/{id}/members:
 *   get:
 *     tags: [Chats]
 *     summary: List members of a conversation
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
 *             schema:
 *               type: object
 *               properties: { members: { type: array, items: { $ref: '#/components/schemas/UserSummary' } } }
 *       403:
 *         description: Not a member of this conversation
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:id/members', requireAuth, readLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  const { data: member } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', req.params.id!)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

  const { data, error } = await supabaseAdmin
    .from('conversation_members')
    .select('users ( id, username, avatar_emoji, avatar_url, status )')
    .eq('conversation_id', req.params.id!);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ members: (data || []).map((r) => r.users) });
});

export = router;

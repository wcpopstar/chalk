import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uuidParam } from '../validation/common';
import { createDirectSchema, createGroupSchema, messagesQuerySchema, muteSchema, deleteConvQuerySchema } from '../validation/chatSchemas';
import { userLimiter } from '../middleware/rateLimit';
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
      muted,
      cleared_at,
      conversations (
        id, type, name, created_at, e2ee_enabled,
        messages!messages_conversation_id_fkey ( id, text, type, deleted_at, sender_id, created_at, is_encrypted )
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
      .select('conversation_id, users ( id, username, avatar_emoji, avatar_url, status, last_seen, public_key, is_bot )')
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
      e2ee_enabled: Boolean(conv.e2ee_enabled),
      muted: Boolean(row.muted),
      created_at: conv.created_at,
      _clearedAt: row.cleared_at,
    };
  })
    // "Delete for me": hide a cleared conversation until something newer than
    // the clear point arrives (then it reappears with only the new history).
    .filter((c) => {
      if (!c._clearedAt) return true;
      return c.last_message && c.last_message.created_at > c._clearedAt;
    })
    .map(({ _clearedAt, ...c }) => c); // drop the internal field from the response

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
 * /api/chats/saved:
 *   post:
 *     tags: [Chats]
 *     summary: Get or create the current user's "Saved Messages" conversation
 *     description: A single-member conversation each user has with themselves (Telegram-style Saved Messages), for forwarding messages to yourself or jotting notes. Idempotent.
 *     responses:
 *       200:
 *         description: Existing saved conversation returned
 *       201:
 *         description: New saved conversation created
 */
// Get or create the "Saved Messages" self-conversation (type='saved', a
// single member). Reuses the whole existing message pipeline — sending,
// forwarding, voice/video notes, pins all work unchanged because the sender
// is a member and there's no partner to block or encrypt for.
router.post('/saved', requireAuth, dmLimiter, async (req: Request, res: Response) => {
  const uid = req.user.id;

  const { data: existing } = await supabaseAdmin
    .from('conversation_members')
    .select('conversation_id, conversations!inner ( id, type )')
    .eq('user_id', uid)
    .eq('conversations.type', 'saved')
    .limit(1)
    .maybeSingle();

  if (existing) return res.json({ conversation: { id: existing.conversation_id, type: 'saved' } });

  const convId = uuid();
  const { data: conv, error: convErr } = await supabaseAdmin
    .from('conversations')
    .insert({ id: convId, type: 'saved', name: 'Saved Messages', created_at: new Date().toISOString() })
    .select()
    .single();
  if (convErr) return res.status(500).json({ error: convErr.message });

  await supabaseAdmin.from('conversation_members').insert({ conversation_id: convId, user_id: uid });

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
/**
 * @openapi
 * /api/chats/search:
 *   get:
 *     tags: [Chats]
 *     summary: Full-text search across the current user's message history
 *     description: Searches non-encrypted message text in every conversation the user belongs to. Encrypted messages are ciphertext server-side and are therefore not searchable here (the client filters chat names/groups locally).
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, minLength: 2 }
 *     responses:
 *       200:
 *         description: OK
 */
// Search inside message bodies across all of the user's conversations. Name /
// group filtering stays client-side (chats-list.js) since that data is already
// loaded; this endpoint is only for message *content*, which the client
// doesn't hold in full.
router.get('/search', requireAuth, readLimiter, async (req: Request, res: Response) => {
  const uid = req.user.id;
  const q = String((req.query as any).q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  // Which conversations is the user in?
  const { data: memberships } = await supabaseAdmin
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', uid);
  const convIds = (memberships || []).map((m) => m.conversation_id);
  if (!convIds.length) return res.json({ results: [] });

  // Escape LIKE wildcards in the user's query so "50%" searches literally.
  const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;

  const { data, error } = await supabaseAdmin
    .from('messages')
    .select(`
      id, conversation_id, text, type, created_at,
      sender:users!messages_sender_id_fkey ( id, username )
    `)
    .in('conversation_id', convIds)
    .eq('is_encrypted', false)
    .is('deleted_at', null)
    .eq('type', 'text')
    .ilike('text', pattern)
    .order('created_at', { ascending: false })
    .limit(40);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ results: data || [] });
});

router.get('/:id/messages', requireAuth, readLimiter, validate({ params: uuidParam(), query: messagesQuerySchema }), async (req: Request, res: Response) => {
  const { limit, before } = req.query as unknown as { limit: number; before?: string };
  const uid  = req.user.id;
  const convId = req.params.id!; // validated by uuidParam()

  // Verify membership. chat_background (this member's wallpaper) lives in the
  // same row — piggyback it here instead of a separate query at the end.
  const { data: member } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id, cleared_at, chat_background')
    .eq('conversation_id', convId)
    .eq('user_id', uid)
    .maybeSingle();

  if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

  let query = supabaseAdmin
    .from('messages')
    .select(`
      id, sender_id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
      preview_title, preview_url, preview_thumbnail, preview_video_id, reply_to_id, forwarded_from,
      is_encrypted, nonce, sender_public_key,
      sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url, is_bot ),
      reply_to:reply_to_id ( id, text, type, deleted_at, sender_id, sender:users!messages_sender_id_fkey ( username ) ),
      reactions:message_reactions ( emoji, user_id )
    `)
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) query = query.lt('created_at', before);
  // "Delete for me" cleared the history up to this point — never return those
  // messages to this member (they stay visible to the other participant).
  if (member.cleared_at) query = query.gt('created_at', member.cleared_at);

  // Messages, read watermarks (✓/✓✓) and the conversation row (E2EE flag +
  // pinned id) are independent — fetch them in parallel: one Supabase round
  // trip of latency instead of three.
  const [
    { data, error },
    { data: reads },
    { data: conv },
  ] = await Promise.all([
    query,
    supabaseAdmin
      .from('conversation_members')
      .select('user_id, last_read_at')
      .eq('conversation_id', convId),
    supabaseAdmin
      .from('conversations')
      .select('e2ee_enabled, pinned_message_id')
      .eq('id', convId)
      .maybeSingle(),
  ]);
  if (error) return res.status(500).json({ error: error.message });

  // Hydrate the pinned message (if any and not since deleted) so the client
  // can render the banner without a second round trip.
  let pinned = null;
  const pinnedId = conv && (conv as any).pinned_message_id;
  if (pinnedId) {
    const { data: pinnedRow } = await supabaseAdmin
      .from('messages')
      .select(`
        id, sender_id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
        preview_title, preview_url, preview_thumbnail, preview_video_id, reply_to_id, forwarded_from,
        is_encrypted, nonce, sender_public_key,
        sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )
      `)
      .eq('id', pinnedId)
      .is('deleted_at', null)
      .maybeSingle();
    pinned = pinnedRow || null;
  }

  return res.json({
    messages: (data || []).reverse(),
    reads: reads || [],
    e2ee_enabled: Boolean(conv && conv.e2ee_enabled),
    pinned,
    chat_background: (member as any).chat_background || null,
  });
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
    .select('users ( id, username, avatar_emoji, avatar_url, status, last_seen, public_key )')
    .eq('conversation_id', req.params.id!);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ members: (data || []).map((r) => r.users) });
});

/**
 * @openapi
 * /api/chats/{id}/background:
 *   patch:
 *     tags: [Chats]
 *     summary: Set (or clear) the current user's chat background for this conversation
 *     description: Per-member wallpaper, synced across the user's devices. Send an empty/null background to reset to the default.
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
 *             properties: { background: { type: string, nullable: true } }
 *     responses:
 *       200: { description: Saved }
 *       403: { description: Not a member of this conversation }
 */
router.patch('/:id/background', requireAuth, readLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  const uid = req.user.id;
  const convId = req.params.id!;

  const { data: member } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', convId)
    .eq('user_id', uid)
    .maybeSingle();
  if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

  // A background is a short preset id / CSS value the client picks from a
  // fixed palette — cap the length so a client can't stash arbitrary blobs
  // here, and normalise "" to null (reset to default).
  const raw = typeof req.body?.background === 'string' ? req.body.background.trim() : '';
  const background = raw && raw.length <= 200 ? raw : null;

  const { error } = await supabaseAdmin
    .from('conversation_members')
    .update({ chat_background: background })
    .eq('conversation_id', convId)
    .eq('user_id', uid);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, background });
});

/**
 * @openapi
 * /api/chats/{id}/mute:
 *   patch:
 *     tags: [Chats]
 *     summary: Mute or unmute new-message notifications for a conversation
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
 *             required: [muted]
 *             properties: { muted: { type: boolean } }
 *     responses:
 *       200: { description: Saved }
 *       403: { description: Not a member of this conversation }
 */
router.patch('/:id/mute', requireAuth, readLimiter, validate({ params: uuidParam(), body: muteSchema }), async (req: Request, res: Response) => {
  const uid = req.user.id;
  const convId = req.params.id!;
  const { muted } = req.body;

  const { data: member } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', convId)
    .eq('user_id', uid)
    .maybeSingle();
  if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

  const { error } = await supabaseAdmin
    .from('conversation_members')
    .update({ muted })
    .eq('conversation_id', convId)
    .eq('user_id', uid);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, muted });
});

/**
 * @openapi
 * /api/chats/{id}:
 *   delete:
 *     tags: [Chats]
 *     summary: Delete a conversation for me, or for everyone
 *     description: mode=self hides the chat and clears my copy of the history (the other participant still sees it). mode=both hard-deletes the whole conversation for everyone — direct chats only.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: mode
 *         schema: { type: string, enum: [self, both], default: self }
 *     responses:
 *       200: { description: Deleted }
 *       403: { description: Not a member of this conversation }
 *       400: { description: mode=both is not allowed on group chats }
 */
router.delete('/:id', requireAuth, readLimiter, validate({ params: uuidParam(), query: deleteConvQuerySchema }), async (req: Request, res: Response) => {
  const uid = req.user.id;
  const convId = req.params.id!;
  const { mode } = req.query as unknown as { mode: 'self' | 'both' };

  const { data: member } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', convId)
    .eq('user_id', uid)
    .maybeSingle();
  if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

  if (mode === 'both') {
    // Hard delete for everyone — only for 1:1 chats (a group would need every
    // member's consent). Cascades to messages + all members via FK.
    const { data: conv } = await supabaseAdmin
      .from('conversations')
      .select('type')
      .eq('id', convId)
      .maybeSingle();
    if (conv?.type !== 'direct') return res.status(400).json({ error: 'Only direct chats can be deleted for everyone' });

    const { error } = await supabaseAdmin.from('conversations').delete().eq('id', convId);
    if (error) return res.status(500).json({ error: error.message });

    // Tell anyone currently viewing this chat to drop it (their list also
    // refreshes on next load if they weren't in the room).
    try {
      const { getIO } = require('../socket/registry');
      getIO()?.to(`chat:${convId}`).emit('chat:deleted', { conversationId: convId });
    } catch (_) { /* best-effort realtime */ }
    return res.json({ ok: true, mode });
  }

  // Delete for me: hide from my list + clear my copy of the history.
  const { error } = await supabaseAdmin
    .from('conversation_members')
    .update({ cleared_at: new Date().toISOString() })
    .eq('conversation_id', convId)
    .eq('user_id', uid);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, mode });
});

export = router;

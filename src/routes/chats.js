const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabase');

// ── GET /api/chats ─────────────────────────────────────────────────────────
// All conversations for current user
router.get('/', requireAuth, async (req, res) => {
  const uid = req.user.id;

  const { data, error } = await supabaseAdmin
    .from('conversation_members')
    .select(`
      conversation_id,
      conversations (
        id, type, name, created_at,
        messages ( id, text, sender_id, created_at )
      )
    `)
    .eq('user_id', uid)
    .order('created_at', { referencedTable: 'conversations', ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Attach last message and unread count per conversation
  const conversations = (data || []).map(row => {
    const conv  = row.conversations;
    const msgs  = conv?.messages || [];
    const last  = msgs[msgs.length - 1] || null;
    return {
      id: conv.id,
      type: conv.type,
      name: conv.name,
      last_message: last,
      created_at: conv.created_at,
    };
  });

  res.json({ conversations });
});

// ── POST /api/chats/direct ─────────────────────────────────────────────────
// Get or create a DM conversation with another user
router.post('/direct', requireAuth, async (req, res) => {
  const { targetUserId } = req.body;
  const uid = req.user.id;

  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });

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

  res.status(201).json({ conversation: conv });
});

// ── POST /api/chats/group ──────────────────────────────────────────────────
router.post('/group', requireAuth, async (req, res) => {
  const { name, memberIds } = req.body;
  const uid = req.user.id;

  if (!Array.isArray(memberIds) || !memberIds.length) {
    return res.status(400).json({ error: 'memberIds array required' });
  }

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

  res.status(201).json({ conversation: conv });
});

// ── GET /api/chats/:id/messages ────────────────────────────────────────────
router.get('/:id/messages', requireAuth, async (req, res) => {
  const { limit = 50, before } = req.query;
  const uid  = req.user.id;
  const convId = req.params.id;

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
      id, text, created_at,
      sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )
    `)
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ messages: (data || []).reverse() });
});

// ── GET /api/chats/:id/members ─────────────────────────────────────────────
router.get('/:id/members', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('conversation_members')
    .select('users ( id, username, avatar_emoji, avatar_url, status )')
    .eq('conversation_id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ members: (data || []).map(r => r.users) });
});

module.exports = router;

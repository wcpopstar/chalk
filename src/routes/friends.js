const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { userLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../services/supabase');
const { addFriendPairInstant } = require('../services/friendsHelper');
const { areUsersBlocked } = require('../services/blockHelper');

// Sending friend requests is a one-click action — cap it so someone can't
// script-spam requests at every user id on the platform.
const friendRequestLimiter = userLimiter({ windowMs: 60 * 1000, max: 15, message: 'Слишком много заявок в друзья, подожди немного.' });

// ── GET /api/friends ───────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
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

  if (error) return res.status(500).json({ error: error.message });

  // Normalise so "friend" is always the other person
  const friends = (data || []).map(row => {
    const isA   = row.user_a_profile.id === uid;
    const other = isA ? row.user_b_profile : row.user_a_profile;
    // For pending requests: incoming = true means *this* user is the recipient (user_b)
    return { id: row.id, status: row.status, friend: other, incoming: !isA, created_at: row.created_at };
  });

  res.json({ friends });
});

// ── POST /api/friends/request ──────────────────────────────────────────────
router.post('/request', requireAuth, friendRequestLimiter, async (req, res) => {
  const { targetUserId } = req.body;
  const uid = req.user.id;

  if (targetUserId === uid) return res.status(400).json({ error: 'Cannot add yourself' });

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

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ request: data });
});

// ── PATCH /api/friends/:id/accept ─────────────────────────────────────────
router.patch('/:id/accept', requireAuth, async (req, res) => {
  const { data: row } = await supabaseAdmin
    .from('friends')
    .select('id, user_a, user_b, status')
    .eq('id', req.params.id)
    .eq('user_b', req.user.id) // only the recipient can accept
    .eq('status', 'pending')
    .single();

  if (!row) return res.status(404).json({ error: 'Request not found or already handled' });

  const { error } = await supabaseAdmin
    .from('friends')
    .update({ status: 'accepted' })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── DELETE /api/friends/:id ────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const { error } = await supabaseAdmin
    .from('friends')
    .delete()
    .eq('id', req.params.id)
    .or(`user_a.eq.${uid},user_b.eq.${uid}`);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /api/friends/add-after-call ──────────────────────────────────────
// Quick add after a call (no pending state needed)
router.post('/add-after-call', requireAuth, friendRequestLimiter, async (req, res) => {
  const { targetUserId } = req.body;
  const uid = req.user.id;

  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
  if (targetUserId === uid) return res.status(400).json({ error: 'Cannot add yourself' });

  if (await areUsersBlocked(uid, targetUserId)) {
    return res.status(403).json({ error: 'Нельзя добавить в друзья — пользователь заблокирован' });
  }

  try {
    const result = await addFriendPairInstant(uid, targetUserId);
    res.status(result.already ? 200 : 201).json({ ok: true, already: result.already });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabase');

// ── GET /api/friends ───────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const { data, error } = await supabaseAdmin
    .from('friends')
    .select(`
      id, status, created_at,
      user_a_profile:users!friends_user_a_fkey ( id, username, avatar_emoji, avatar_url, status, last_seen ),
      user_b_profile:users!friends_user_b_fkey ( id, username, avatar_emoji, avatar_url, status, last_seen )
    `)
    .or(`user_a.eq.${uid},user_b.eq.${uid}`)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Normalise so "friend" is always the other person
  const friends = (data || []).map(row => {
    const isA   = row.user_a_profile.id === uid;
    const other = isA ? row.user_b_profile : row.user_a_profile;
    return { id: row.id, status: row.status, friend: other, created_at: row.created_at };
  });

  res.json({ friends });
});

// ── POST /api/friends/request ──────────────────────────────────────────────
router.post('/request', requireAuth, async (req, res) => {
  const { targetUserId } = req.body;
  const uid = req.user.id;

  if (targetUserId === uid) return res.status(400).json({ error: 'Cannot add yourself' });

  // Check if already exists
  const { data: existing } = await supabaseAdmin
    .from('friends')
    .select('id, status')
    .or(`and(user_a.eq.${uid},user_b.eq.${targetUserId}),and(user_a.eq.${targetUserId},user_b.eq.${uid})`)
    .maybeSingle();

  if (existing) {
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
// Quick add after a promoted call (no pending state needed)
router.post('/add-after-call', requireAuth, async (req, res) => {
  const { targetUserId } = req.body;
  const uid = req.user.id;

  if (targetUserId === uid) return res.status(400).json({ error: 'Cannot add yourself' });

  const { data: existing } = await supabaseAdmin
    .from('friends')
    .select('id')
    .or(`and(user_a.eq.${uid},user_b.eq.${targetUserId}),and(user_a.eq.${targetUserId},user_b.eq.${uid})`)
    .maybeSingle();

  if (existing) return res.json({ ok: true, already: true });

  const { error } = await supabaseAdmin.from('friends').insert({
    id: uuid(),
    user_a: uid,
    user_b: targetUserId,
    status: 'accepted', // instant after-call add
    created_at: new Date().toISOString(),
  });

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ok: true });
});

module.exports = router;

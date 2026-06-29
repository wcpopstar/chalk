const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabase');

// ── GET /api/users/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select(`
      id, username, country, languages, avatar_emoji, bio, status, last_seen,
      user_games ( game_id, rank, hours_played, games ( name, emoji ) )
    `)
    .eq('id', req.params.id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ── PATCH /api/users/me ────────────────────────────────────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  const allowed = ['username', 'country', 'languages', 'avatar_emoji', 'bio'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.user.id)
    .select('id, username, country, languages, avatar_emoji, bio')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

// ── PUT /api/users/me/games ────────────────────────────────────────────────
// Body: [{ game_id, rank, hours_played }]
router.put('/me/games', requireAuth, async (req, res) => {
  const { games } = req.body; // array
  if (!Array.isArray(games)) return res.status(400).json({ error: 'games must be an array' });

  // Delete existing then re-insert
  await supabaseAdmin.from('user_games').delete().eq('user_id', req.user.id);

  if (games.length) {
    const rows = games.map(g => ({
      user_id: req.user.id,
      game_id: g.game_id,
      rank: g.rank || null,
      hours_played: g.hours_played || 0,
    }));
    const { error } = await supabaseAdmin.from('user_games').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
});

// ── GET /api/users/me/stats ────────────────────────────────────────────────
router.get('/me/stats', requireAuth, async (req, res) => {
  const uid = req.user.id;

  const [{ count: matchCount }, { data: ratingRow }, { count: friendCount }] = await Promise.all([
    supabaseAdmin.from('match_history').select('*', { count: 'exact', head: true }).or(`user_a.eq.${uid},user_b.eq.${uid}`),
    supabaseAdmin.from('ratings').select('avg_rating').eq('rated_user_id', uid).maybeSingle(),
    supabaseAdmin.from('friends').select('*', { count: 'exact', head: true }).or(`user_a.eq.${uid},user_b.eq.${uid}`).eq('status', 'accepted'),
  ]);

  res.json({
    matches_found: matchCount || 0,
    avg_rating: ratingRow?.avg_rating || null,
    friends_count: friendCount || 0,
  });
});

// ── GET /api/users/discover ────────────────────────────────────────────────
// Tinder-style: users I haven't swiped yet, filtered by game/region
router.get('/discover', requireAuth, async (req, res) => {
  const { game_id, limit = 20 } = req.query;
  const uid = req.user.id;

  // IDs already swiped
  const { data: swipes } = await supabaseAdmin
    .from('swipes')
    .select('target_user_id')
    .eq('user_id', uid);
  const swipedIds = (swipes || []).map(s => s.target_user_id);
  swipedIds.push(uid); // exclude self

  let query = supabaseAdmin
    .from('users')
    .select(`id, username, country, languages, avatar_emoji, bio, status,
             user_games ( rank, games ( id, name, emoji ) )`)
    .eq('status', 'online')
    .not('id', 'in', `(${swipedIds.join(',')})`)
    .limit(parseInt(limit));

  if (game_id) {
    // Only users who play this game
    const { data: gameUsers } = await supabaseAdmin
      .from('user_games')
      .select('user_id')
      .eq('game_id', game_id);
    const ids = (gameUsers || []).map(r => r.user_id).filter(id => !swipedIds.includes(id));
    if (!ids.length) return res.json({ users: [] });
    query = query.in('id', ids);
  }

  const { data: users, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: users || [] });
});

module.exports = router;

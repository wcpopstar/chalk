const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabase');

// ── IMPORTANT: specific routes MUST be declared before /:id ───────────────
// Otherwise Express matches "me", "me/stats", "discover" as :id

const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];

function validateProfileFields(body) {
  const errors = [];
  if (body.age !== undefined && body.age !== null) {
    const age = Number(body.age);
    if (!Number.isInteger(age) || age < 13 || age > 100) {
      errors.push('age must be an integer between 13 and 100');
    }
  }
  if (body.gender !== undefined && body.gender !== null && !GENDERS.includes(body.gender)) {
    errors.push('gender must be one of: ' + GENDERS.join(', '));
  }
  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages) || !body.languages.length || !body.languages.every(l => typeof l === 'string')) {
      errors.push('languages must be a non-empty array of strings');
    }
  }
  if (body.username !== undefined) {
    if (typeof body.username !== 'string' || body.username.trim().length < 3 || body.username.trim().length > 24) {
      errors.push('username must be 3-24 characters');
    }
  }
  if (body.avatar_url !== undefined && body.avatar_url !== null) {
    if (typeof body.avatar_url !== 'string' || body.avatar_url.length > 1_500_000) {
      errors.push('avatar_url is invalid or too large');
    }
  }
  return errors;
}

async function replaceUserGames(userId, games) {
  await supabaseAdmin.from('user_games').delete().eq('user_id', userId);
  if (games && games.length) {
    const rows = games.map(g => ({
      user_id: userId,
      game_id: g.game_id,
      rank: g.rank || null,
      hours_played: g.hours_played || 0,
    }));
    const { error } = await supabaseAdmin.from('user_games').insert(rows);
    if (error) throw error;
  }
}

// ── PATCH /api/users/me ────────────────────────────────────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  const allowed = ['username', 'country', 'languages', 'avatar_emoji', 'avatar_url', 'bio', 'age', 'gender'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const validationErrors = validateProfileFields(updates);
  if (validationErrors.length) {
    return res.status(400).json({ error: validationErrors.join('; ') });
  }

  if (typeof updates.username === 'string') updates.username = updates.username.trim();

  // Nickname must stay unique
  if (updates.username) {
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('username', updates.username)
      .neq('id', req.user.id)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'Username already taken' });
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.user.id)
    .select('id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

// ── POST /api/users/me/onboarding ──────────────────────────────────────────
// One-shot setup completed right after registration: nickname, photo, age,
// gender, languages, favourite games. Marks onboarding_completed = true.
router.post('/me/onboarding', requireAuth, async (req, res) => {
  const { username, avatar_url, age, gender, languages, games } = req.body;

  if (age === undefined || age === null) return res.status(400).json({ error: 'age is required' });
  if (!gender) return res.status(400).json({ error: 'gender is required' });
  if (!Array.isArray(languages) || !languages.length) {
    return res.status(400).json({ error: 'Pick at least one language' });
  }

  const updates = { age, gender, languages, onboarding_completed: true };
  if (avatar_url !== undefined) updates.avatar_url = avatar_url;
  if (username !== undefined) updates.username = String(username).trim();

  const validationErrors = validateProfileFields(updates);
  if (validationErrors.length) {
    return res.status(400).json({ error: validationErrors.join('; ') });
  }

  if (updates.username) {
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('username', updates.username)
      .neq('id', req.user.id)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'Username already taken' });
  }

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.user.id)
    .select('id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, bio')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (Array.isArray(games)) {
    try {
      await replaceUserGames(req.user.id, games);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.json({ user });
});

// ── PUT /api/users/me/games ────────────────────────────────────────────────
router.put('/me/games', requireAuth, async (req, res) => {
  const { games } = req.body;
  if (!Array.isArray(games)) return res.status(400).json({ error: 'games must be an array' });

  try {
    await replaceUserGames(req.user.id, games);
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
router.get('/discover', requireAuth, async (req, res) => {
  const { game_id, limit = 20 } = req.query;
  const uid = req.user.id;

  const { data: swipes } = await supabaseAdmin
    .from('swipes')
    .select('target_user_id')
    .eq('user_id', uid);
  const swipedIds = (swipes || []).map(s => s.target_user_id);
  swipedIds.push(uid); // exclude self

  let query = supabaseAdmin
    .from('users')
    .select(`id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, status,
             user_games ( rank, games ( id, name, emoji ) )`)
    .eq('status', 'online')
    .not('id', 'in', `(${swipedIds.join(',')})`)
    .limit(parseInt(limit));

  if (game_id) {
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

// ── GET /api/users/:id ─────────────────────────────────────────────────────
// Must be LAST so it doesn't swallow /me, /me/stats, /discover
router.get('/:id', requireAuth, async (req, res) => {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select(`
      id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, status, last_seen,
      user_games ( game_id, rank, hours_played, games ( name, emoji ) )
    `)
    .eq('id', req.params.id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

module.exports = router;

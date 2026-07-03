const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { userLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../services/supabase');
const { blockUser, unblockUser } = require('../services/blockHelper');

// Live nickname search fires on nearly every keystroke — generous but capped,
// so someone can't script a flood of substring queries against the DB.
const searchLimiter = userLimiter({ windowMs: 10 * 1000, max: 40, message: 'Слишком много запросов поиска, подожди немного.' });
// Block/report are one-click actions on someone else's profile — cap hard so
// a mash-click (or script) can't hammer the DB or spam report rows.
const moderationLimiter = userLimiter({ windowMs: 60 * 1000, max: 20, message: 'Слишком много действий, подожди немного.' });

// ── IMPORTANT: specific routes MUST be declared before /:id ───────────────
// Otherwise Express matches "me", "me/stats", "discover" as :id

const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];
const PRESENCE_STATES = ['online', 'away', 'busy'];

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
  if (body.presence !== undefined && !PRESENCE_STATES.includes(body.presence)) {
    errors.push('presence must be one of: ' + PRESENCE_STATES.join(', '));
  }
  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages) || !body.languages.length || !body.languages.every(l => typeof l === 'string')) {
      errors.push('languages must be a non-empty array of strings');
    }
  }
  if (body.username !== undefined) {
    if (typeof body.username !== 'string' || body.username.trim().length < 3 || body.username.trim().length > 24) {
      errors.push('username must be 3-24 characters');
    } else if (!/^[a-zA-Z0-9 _-]+$/.test(body.username.trim())) {
      errors.push('username may only contain letters, numbers, spaces, underscores and hyphens');
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
  const allowed = ['username', 'country', 'languages', 'avatar_emoji', 'avatar_url', 'bio', 'age', 'gender', 'presence'];
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
    .select('id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, presence')
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
    .select('id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, bio, presence')
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

  const { data: blockRows } = await supabaseAdmin
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${uid},blocked_id.eq.${uid}`);
  (blockRows || []).forEach(r => {
    swipedIds.push(r.blocker_id === uid ? r.blocked_id : r.blocker_id);
  });

  let query = supabaseAdmin
    .from('users')
    .select(`id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, status, presence,
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

// ── GET /api/users/search?username=xxx ─────────────────────────────────────
// Used by the "add friend" flow to resolve a nickname to a user id.
// Must stay above /:id so it isn't swallowed by that route.
//
// Two modes:
//   ?username=xxx&exact=1  -> exact (case-insensitive) match, returns { user }
//                             404 if nothing matches (used by "send request").
//   ?username=xxx          -> live/partial match as the person types, returns
//                             { users: [...] } sorted by relevance (best match first).
router.get('/search', requireAuth, searchLimiter, async (req, res) => {
  const raw = (req.query.username || '').trim();
  if (!raw) return res.status(400).json({ error: 'username is required' });

  if (req.query.exact) {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_emoji, avatar_url, status, presence')
      .ilike('username', raw)
      .neq('id', req.user.id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    return res.json({ user });
  }

  // Escape % and _ so they aren't treated as SQL wildcards by the user's input.
  const escaped = raw.replace(/[%_]/g, ch => '\\' + ch);
  const limit = Math.min(parseInt(req.query.limit) || 8, 20);

  const { data: users, error } = await supabaseAdmin
    .from('users')
    .select('id, username, avatar_emoji, avatar_url, status, presence')
    .ilike('username', `%${escaped}%`)
    .neq('id', req.user.id)
    .limit(30);

  if (error) return res.status(500).json({ error: error.message });

  const q = raw.toLowerCase();
  const ranked = (users || [])
    .map(u => {
      const name = (u.username || '').toLowerCase();
      let rank = 3; // plain substring match
      if (name === q) rank = 0;            // exact
      else if (name.startsWith(q)) rank = 1; // prefix match
      else if (name.includes(q)) rank = 2;   // word-ish/other substring
      return { u, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.u.username.length - b.u.username.length)
    .slice(0, limit)
    .map(r => r.u);

  res.json({ users: ranked });
});

// ── GET /api/users/me/blocked ──────────────────────────────────────────────
// Must stay above /:id.
router.get('/me/blocked', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('blocks')
    .select('id, created_at, blocked:users!blocks_blocked_id_fkey ( id, username, avatar_emoji, avatar_url )')
    .eq('blocker_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ blocked: (data || []).filter(r => r.blocked) });
});

// ── POST /api/users/:id/block ──────────────────────────────────────────────
router.post('/:id/block', requireAuth, moderationLimiter, async (req, res) => {
  const targetId = req.params.id;
  const uid = req.user.id;
  if (targetId === uid) return res.status(400).json({ error: 'Cannot block yourself' });

  try {
    await blockUser(uid, targetId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/users/:id/block ────────────────────────────────────────────
router.delete('/:id/block', requireAuth, moderationLimiter, async (req, res) => {
  try {
    await unblockUser(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/users/:id/report ─────────────────────────────────────────────
const REPORT_REASONS = ['harassment', 'hate_speech', 'spam', 'inappropriate_content', 'scam', 'underage', 'other'];

router.post('/:id/report', requireAuth, moderationLimiter, async (req, res) => {
  const targetId = req.params.id;
  const uid = req.user.id;
  const { reason, details, context } = req.body;

  if (targetId === uid) return res.status(400).json({ error: 'Cannot report yourself' });
  if (!reason || !REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ error: 'reason must be one of: ' + REPORT_REASONS.join(', ') });
  }
  if (details !== undefined && details !== null && String(details).length > 1000) {
    return res.status(400).json({ error: 'details too long (max 1000 chars)' });
  }

  const { error } = await supabaseAdmin
    .from('reports')
    .insert({
      id: uuid(),
      reporter_id: uid,
      reported_id: targetId,
      reason,
      details: details ? String(details).trim().slice(0, 1000) : null,
      context: context ? String(context).slice(0, 50) : null,
      created_at: new Date().toISOString(),
    });

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ok: true });
});

// ── GET /api/users/:id ─────────────────────────────────────────────────────
// Must be LAST so it doesn't swallow /me, /me/stats, /discover
router.get('/:id', requireAuth, async (req, res) => {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select(`
      id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, status, presence, last_seen,
      user_games ( game_id, rank, hours_played, games ( name, emoji ) )
    `)
    .eq('id', req.params.id)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  const { data: blockRows } = await supabaseAdmin
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`and(blocker_id.eq.${req.user.id},blocked_id.eq.${req.params.id}),and(blocker_id.eq.${req.params.id},blocked_id.eq.${req.user.id})`);

  user.blocked_by_me = !!(blockRows || []).find(r => r.blocker_id === req.user.id);
  user.has_blocked_me = !!(blockRows || []).find(r => r.blocker_id === req.params.id);

  res.json({ user });
});

module.exports = router;

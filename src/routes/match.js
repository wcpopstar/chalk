const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabase');

// ── GET /api/match/history ─────────────────────────────────────────────────
router.get('/history', requireAuth, async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  const uid = req.user.id;

  const { data, error } = await supabaseAdmin
    .from('match_history')
    .select(`
      id, mode, created_at,
      games ( name, emoji ),
      user_a_profile:users!match_history_user_a_fkey ( id, username, avatar_emoji ),
      user_b_profile:users!match_history_user_b_fkey ( id, username, avatar_emoji )
    `)
    .or(`user_a.eq.${uid},user_b.eq.${uid}`)
    .order('created_at', { ascending: false })
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ matches: data || [] });
});

// ── POST /api/match/:id/rate ───────────────────────────────────────────────
router.post('/:matchId/rate', requireAuth, async (req, res) => {
  const { rating, comment } = req.body; // rating 1-5
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  // Find who to rate (the other person in this match)
  const { data: match } = await supabaseAdmin
    .from('match_history')
    .select('user_a, user_b')
    .eq('id', req.params.matchId)
    .or(`user_a.eq.${req.user.id},user_b.eq.${req.user.id}`)
    .single();

  if (!match) return res.status(404).json({ error: 'Match not found' });

  const ratedUserId = match.user_a === req.user.id ? match.user_b : match.user_a;

  const { error } = await supabaseAdmin.from('ratings').upsert({
    match_id:       req.params.matchId,
    rater_user_id:  req.user.id,
    rated_user_id:  ratedUserId,
    rating,
    comment: comment || null,
    created_at: new Date().toISOString(),
  });

  if (error) return res.status(500).json({ error: error.message });

  // Recalculate avg rating for the rated user
  const { data: avgRow } = await supabaseAdmin
    .from('ratings')
    .select('rating')
    .eq('rated_user_id', ratedUserId);

  if (avgRow && avgRow.length) {
    const avg = avgRow.reduce((s, r) => s + r.rating, 0) / avgRow.length;
    await supabaseAdmin.from('users').update({ avg_rating: parseFloat(avg.toFixed(2)) }).eq('id', ratedUserId);
  }

  res.json({ ok: true });
});

module.exports = router;

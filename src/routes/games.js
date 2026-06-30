const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabase');

// ── POST /api/games/tetris/score ───────────────────────────────────────────
// Submit a score from a finished tetris run. Only the best score is kept.
router.post('/tetris/score', requireAuth, async (req, res) => {
  const score = Number(req.body.score);
  if (!Number.isFinite(score) || score < 0 || score > 1_000_000) {
    return res.status(400).json({ error: 'score must be a non-negative number' });
  }

  const uid = req.user.id;

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('tetris_scores')
    .select('best_score, games_played')
    .eq('user_id', uid)
    .maybeSingle();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const bestScore = Math.max(score, existing?.best_score || 0);
  const gamesPlayed = (existing?.games_played || 0) + 1;

  const { error: upsertErr } = await supabaseAdmin
    .from('tetris_scores')
    .upsert({ user_id: uid, best_score: bestScore, games_played: gamesPlayed, updated_at: new Date().toISOString() });

  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  // Compute rank: how many players have a strictly higher best_score.
  const { count, error: rankErr } = await supabaseAdmin
    .from('tetris_scores')
    .select('user_id', { count: 'exact', head: true })
    .gt('best_score', bestScore);

  if (rankErr) return res.status(500).json({ error: rankErr.message });

  const { count: totalCount } = await supabaseAdmin
    .from('tetris_scores')
    .select('user_id', { count: 'exact', head: true });

  res.json({
    score,
    bestScore,
    gamesPlayed,
    rank: (count || 0) + 1,
    totalPlayers: totalCount || 1,
  });
});

// ── GET /api/games/tetris/leaderboard ──────────────────────────────────────
// Top scores plus the current user's own rank (even if outside the top list).
router.get('/tetris/leaderboard', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);

  const { data: top, error: topErr } = await supabaseAdmin
    .from('tetris_scores')
    .select('user_id, best_score, games_played, users(username, avatar_emoji)')
    .order('best_score', { ascending: false })
    .limit(limit);

  if (topErr) return res.status(500).json({ error: topErr.message });

  const uid = req.user.id;
  const { data: mine } = await supabaseAdmin
    .from('tetris_scores')
    .select('best_score, games_played')
    .eq('user_id', uid)
    .maybeSingle();

  let myRank = null;
  let totalPlayers = 0;
  if (mine) {
    const { count } = await supabaseAdmin
      .from('tetris_scores')
      .select('user_id', { count: 'exact', head: true })
      .gt('best_score', mine.best_score);
    myRank = (count || 0) + 1;
  }
  const { count: total } = await supabaseAdmin
    .from('tetris_scores')
    .select('user_id', { count: 'exact', head: true });
  totalPlayers = total || 0;

  res.json({
    top: (top || []).map((row, i) => ({
      rank: i + 1,
      userId: row.user_id,
      username: row.users?.username || 'Игрок',
      avatarEmoji: row.users?.avatar_emoji || '🎮',
      bestScore: row.best_score,
      gamesPlayed: row.games_played,
    })),
    me: mine ? { bestScore: mine.best_score, gamesPlayed: mine.games_played, rank: myRank } : null,
    totalPlayers,
  });
});

module.exports = router;

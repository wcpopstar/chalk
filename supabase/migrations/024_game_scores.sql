-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — generic arcade mini-game best scores
-- ═══════════════════════════════════════════════════════════════════════════
-- Tetris keeps its own dedicated table (tetris_scores, migration 007) since it
-- predates this. Every NEW arcade game (F1 racing, 2048, battleship, typing
-- speed, the chalk platformer, …) shares this one table keyed by (user_id,
-- game) so a new game is just a frontend module — no schema/route churn.

CREATE TABLE IF NOT EXISTS game_scores (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game         TEXT NOT NULL,
  best_score   INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game)
);

-- Leaderboard is "top best_score for one game" — index by (game, best_score)
-- so the per-game ranking query is a plain index range scan.
CREATE INDEX IF NOT EXISTS idx_game_scores_game_best ON game_scores (game, best_score DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — missing indexes audit
-- ═══════════════════════════════════════════════════════════════════════════
-- email / username were already covered:
--   users.email    -> UNIQUE NOT NULL gives an implicit btree index, and
--                     every query lowercases first (auth.js), so no
--                     case-insensitivity gap.
--   users.username -> UNIQUE NOT NULL (exact .eq() lookups) PLUS
--                     users_username_trgm, a GIN pg_trgm index that also
--                     accelerates the ILIKE '%term%' partial search used by
--                     GET /api/users/search.
--
-- The gaps found are all cases where a table's PRIMARY KEY is composite and
-- the app queries it by the *second* column alone — Postgres can't use a
-- composite btree efficiently for that, so these degrade to a full index/
-- table scan today.

-- conversation_members(conversation_id, user_id) already serves membership
-- checks (WHERE conversation_id = X AND user_id = Y — leading column
-- matches). But GET /api/chats — the "list my conversations" endpoint hit
-- on every chat-list page load — queries WHERE user_id = X alone
-- (src/routes/chats.js), which is the non-leading column. This is the
-- highest-traffic query of the three below.
CREATE INDEX IF NOT EXISTS conversation_members_user_idx
  ON conversation_members (user_id);

-- user_games(user_id, game_id) serves "get this user's games" fine, but
-- GET /api/users/discover?game_id=X (src/routes/users.js) queries
-- WHERE game_id = X alone — the non-leading column.
CREATE INDEX IF NOT EXISTS user_games_game_id_idx
  ON user_games (game_id);

-- ratings had no index at all besides its PK/UNIQUE(match_id, rater_user_id).
-- POST /api/match/:matchId/rate (src/routes/match.js) recomputes the rated
-- user's average via WHERE rated_user_id = X on every single rating.
CREATE INDEX IF NOT EXISTS ratings_rated_user_idx
  ON ratings (rated_user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — call-activity counters for the "most active users" leaderboard
-- ═══════════════════════════════════════════════════════════════════════════
-- The existing `calls` table isn't populated by the live call flow (the client
-- records matches via /api/match/record-call, not /api/calls), so instead of
-- aggregating it we keep two lightweight running counters on the user row,
-- bumped when a call ends:
--
--   total_call_seconds — cumulative time the user has spent in calls.
--   total_calls        — how many calls they've completed.
--
-- Each participant's own client reports the duration it measured when the call
-- ends (POST /api/calls/activity), so every participant's counter advances.
-- increment_call_activity() does it in a single atomic UPDATE (no read-modify-
-- write race), clamping negatives to 0.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS total_call_seconds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_calls        INT    NOT NULL DEFAULT 0;

-- The leaderboard orders by cumulative call time, newest-active first.
CREATE INDEX IF NOT EXISTS users_total_call_seconds_idx ON users (total_call_seconds DESC);

CREATE OR REPLACE FUNCTION increment_call_activity(p_user_id UUID, p_seconds INT)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE users
     SET total_call_seconds = total_call_seconds + GREATEST(COALESCE(p_seconds, 0), 0),
         total_calls        = total_calls + 1
   WHERE id = p_user_id;
$$;

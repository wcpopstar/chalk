-- Marks match_history rows whose participants were confirmed (via the Redis
-- call-partner check in POST /api/match/record-call) to have actually shared
-- a call room. Rows created before this column existed stay FALSE — they
-- predate the verification and can't be confirmed retroactively.
ALTER TABLE match_history
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;

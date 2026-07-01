-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — block users & report users
-- ═══════════════════════════════════════════════════════════════════════════

-- ── BLOCKS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocks (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS blocks_blocker_idx ON blocks (blocker_id);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_id);

ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Blocks visible to blocker" ON blocks;
CREATE POLICY "Blocks visible to blocker" ON blocks
  FOR SELECT USING (auth.uid()::text = blocker_id::text);

-- ── REPORTS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  details     TEXT,
  context     TEXT,                          -- e.g. 'profile' | 'chat' | 'global_chat' | 'call'
  status      TEXT NOT NULL DEFAULT 'open',   -- open | reviewed | dismissed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (reporter_id <> reported_id)
);

CREATE INDEX IF NOT EXISTS reports_reported_idx ON reports (reported_id);
CREATE INDEX IF NOT EXISTS reports_reporter_idx ON reports (reporter_id);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Reports visible to reporter" ON reports;
CREATE POLICY "Reports visible to reporter" ON reports
  FOR SELECT USING (auth.uid()::text = reporter_id::text);

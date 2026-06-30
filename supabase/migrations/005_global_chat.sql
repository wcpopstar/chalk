-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — global (platform-wide) chat
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS global_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS global_messages_created_idx ON global_messages (created_at);

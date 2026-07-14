-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — per-user chat mute + "delete for me"
-- ═══════════════════════════════════════════════════════════════════════════
-- Both are per-(user, conversation) state, so they live on conversation_members
-- (same place as last_read_at / chat_background):
--   • muted      — suppress new-message notifications & sound for this chat.
--   • cleared_at — "delete for me": hide the chat from my list and hide every
--                  message at/older than this timestamp from my history. A
--                  newer incoming message makes the chat reappear (its history
--                  before cleared_at stays hidden for me only).
-- "Delete for everyone" is a hard DELETE of the conversation row (cascades to
-- messages + members) and needs no column.

ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS muted      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;

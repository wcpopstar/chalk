-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — read receipts + message replies
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Read receipts ────────────────────────────────────────────────────────────
-- One timestamp per member per conversation: "I have read everything up to
-- this moment". The client sends chat:read when a conversation is open and
-- visible; a sender's message counts as read by a member when
-- member.last_read_at >= message.created_at. Storing a watermark instead of
-- a per-message read table keeps this O(members) per conversation instead
-- of O(messages x members).
ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

-- ── Replies ──────────────────────────────────────────────────────────────────
-- A message may quote one earlier message from the SAME conversation
-- (enforced server-side in socket/chat.ts — a FK alone can't express the
-- same-conversation rule). ON DELETE SET NULL: hard-deleting the quoted
-- message must not take the replies down with it (soft-deleted quotes are
-- handled in the UI as "deleted message").
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_reply_idx ON messages (reply_to_id);

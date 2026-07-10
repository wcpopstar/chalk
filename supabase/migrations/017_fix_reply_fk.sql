-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — hotfix: restore the reply FK that PostgREST embeds depend on
--
-- Observed in production: messages.reply_to_id EXISTS but the foreign key
-- messages_reply_to_id_fkey does NOT, so every select embedding
--   reply_to:messages!messages_reply_to_id_fkey ( ... )
-- fails with PGRST200 "Could not find a relationship between 'messages'
-- and 'messages'" — which 500s GET /api/chats/:id/messages and breaks
-- opening any conversation.
--
-- How that state happens: 014_read_receipts_replies.sql adds the column as
--   ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ...
-- If the column already existed (added by hand at some point without
-- REFERENCES), IF NOT EXISTS skips the whole definition — constraint
-- included. This migration adds the FK explicitly and idempotently.
-- ═══════════════════════════════════════════════════════════════════════════

-- Defensive: a reply pointing at a hard-deleted message would make ADD
-- CONSTRAINT fail validation; null such orphans first (same semantics the
-- FK's ON DELETE SET NULL would have produced had it existed all along).
UPDATE messages m SET reply_to_id = NULL
WHERE m.reply_to_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM messages q WHERE q.id = m.reply_to_id);

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_reply_to_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_reply_to_id_fkey
  FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_reply_idx ON messages (reply_to_id);

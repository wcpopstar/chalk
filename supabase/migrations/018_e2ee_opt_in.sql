-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — E2EE becomes opt-in per conversation
-- ═══════════════════════════════════════════════════════════════════════════
-- Previously a direct chat auto-encrypted as soon as the partner had a key
-- (see 015_e2ee.sql). Now every conversation starts in plaintext and either
-- member of a direct chat can flip encryption on/off with the lock button in
-- the chat header (socket event chat:e2ee). The flag is the server-side
-- source of truth: plaintext sends into an e2ee_enabled conversation are
-- rejected (socket/chat.ts), so one stale client can't silently downgrade a
-- conversation both sides chose to encrypt.
--
-- Deliberately defaulted to FALSE for existing conversations too — chats
-- that auto-encrypted under the old scheme go back to plaintext for NEW
-- messages until someone presses the lock button. Old encrypted rows keep
-- is_encrypted=true per message and stay decryptable client-side (the UI
-- already handles mixed-mode history).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS e2ee_enabled BOOLEAN NOT NULL DEFAULT false;

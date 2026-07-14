-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — pinned messages, forwarding, and per-member chat backgrounds
-- ═══════════════════════════════════════════════════════════════════════════
-- Three independent, additive columns for three new chat features:
--
--  1. conversations.pinned_message_id — the single message currently pinned in
--     a conversation (Telegram-style banner above the thread). Pinning a new
--     message replaces the old one; unpinning sets it back to NULL. ON DELETE
--     SET NULL so deleting the underlying message just clears the pin instead
--     of orphaning a dangling reference.
--
--  2. messages.forwarded_from — when a message is forwarded into a conversation
--     (socket event chat:forward), this stores the ORIGINAL author's display
--     name so the copy can render a "Forwarded from X" label. NULL for normal,
--     non-forwarded messages. Only non-encrypted messages can be forwarded
--     (the server can't re-key ciphertext), so this never touches E2EE rows.
--
--  3. conversation_members.chat_background — a per-(user, conversation) chat
--     wallpaper preset id / CSS value, chosen by each member for themselves
--     and synced across their devices (PATCH /api/chats/:id/background). It's
--     on conversation_members, not conversations, precisely because "a new
--     background per person" means each side picks their own — one member's
--     choice never changes what the other sees.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pinned_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS forwarded_from TEXT;

ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS chat_background TEXT;

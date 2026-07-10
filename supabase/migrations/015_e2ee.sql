-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — end-to-end encryption for direct (1:1) chat messages
--
-- Design: pairwise NaCl `box` (X25519-XSalsa20-Poly1305). Each user has a
-- long-term X25519 keypair generated client-side; only the public half ever
-- reaches the server. Direct-chat text messages are encrypted client-side
-- before they're sent, so `messages.text` holds base64 ciphertext for those
-- rows instead of plaintext — the server (and DB) never see the plaintext.
--
-- NOT covered by this migration / out of scope for v1:
--  - global_messages (public room — plaintext by design)
--  - group conversations (no group-key/sender-key scheme yet — group
--    messages keep using plaintext `text`, distinguished by is_encrypted=false)
--  - gif / voice / video_note message types (media stays unencrypted for now)
-- ═══════════════════════════════════════════════════════════════════════════

-- Long-term public key (base64-encoded 32-byte X25519 public key). Nullable —
-- older accounts / users who haven't opened the app since this shipped won't
-- have one yet, so any code path reading it must handle NULL.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS public_key TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_public_key_len_check;
ALTER TABLE users ADD CONSTRAINT users_public_key_len_check
  CHECK (public_key IS NULL OR length(public_key) BETWEEN 40 AND 64);

-- Per-message encryption metadata. `text` is reused to hold ciphertext
-- (base64) for encrypted rows — it was already nullable TEXT, so no type
-- change needed, just a widened length cap (base64 ciphertext runs ~1.4x
-- the size of the original plaintext + a 16-byte auth tag).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS nonce             TEXT,
  ADD COLUMN IF NOT EXISTS sender_public_key TEXT,
  ADD COLUMN IF NOT EXISTS is_encrypted      BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_text_check;
ALTER TABLE messages ADD CONSTRAINT messages_text_check
  CHECK (text IS NULL OR length(text) <= 12000);

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_nonce_len_check;
ALTER TABLE messages ADD CONSTRAINT messages_nonce_len_check
  CHECK (nonce IS NULL OR length(nonce) = 32);

-- Encrypted rows must carry both a nonce and the sender's public key at
-- time-of-send (used for decryption); plaintext rows must carry neither.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_encryption_consistency_check;
ALTER TABLE messages ADD CONSTRAINT messages_encryption_consistency_check
  CHECK (
    (is_encrypted = true  AND nonce IS NOT NULL AND sender_public_key IS NOT NULL)
    OR
    (is_encrypted = false AND nonce IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_messages_is_encrypted ON messages(is_encrypted) WHERE is_encrypted = true;

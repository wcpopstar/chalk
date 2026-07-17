-- ── Bots ─────────────────────────────────────────────────────────────────────
-- A bot is a regular row in `users` (so messages, conversation membership,
-- avatars and the whole existing message pipeline work unchanged), flagged
-- with is_bot and owned by a human account. Bots authenticate to the HTTP API
-- with a long-lived token ("Authorization: Bot chalk_bot_…"); only the SHA-256
-- of the token is stored.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_bot         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bot_owner_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS bot_token_hash TEXT;

-- A bot must have an owner; a human must not.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_bot_owner_consistency;
ALTER TABLE users ADD CONSTRAINT users_bot_owner_consistency
  CHECK ((is_bot AND bot_owner_id IS NOT NULL) OR (NOT is_bot AND bot_owner_id IS NULL));

CREATE INDEX IF NOT EXISTS users_bot_owner_idx
  ON users (bot_owner_id) WHERE bot_owner_id IS NOT NULL;

-- Token lookup on every bot API request; unique so a token maps to one bot.
CREATE UNIQUE INDEX IF NOT EXISTS users_bot_token_hash_idx
  ON users (bot_token_hash) WHERE bot_token_hash IS NOT NULL;

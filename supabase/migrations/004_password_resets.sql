-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — password reset tokens
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,        -- sha256 hash of the raw token (raw token only ever sent by email)
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx  ON password_resets (user_id);
CREATE INDEX IF NOT EXISTS password_resets_token_idx ON password_resets (token_hash);

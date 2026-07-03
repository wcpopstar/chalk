-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — refresh tokens (rotation + reuse detection)
-- ═══════════════════════════════════════════════════════════════════════════
-- Refresh tokens are opaque random strings (never JWTs) — the raw value is
-- only ever returned to the client once, at issuance/rotation time. We only
-- ever store its SHA-256 hash, same pattern as password_resets.
--
-- `family_id` links a refresh token to every token it gets rotated into.
-- On rotation the old row is marked revoked and `replaced_by` points at the
-- new token's hash. If a revoked token is ever presented again, that's a
-- signal the token was stolen — the whole family gets revoked, forcing a
-- fresh login on every device sharing that session lineage.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,   -- sha256 hash of the raw opaque token
  family_id    UUID NOT NULL,          -- shared across a token's rotation chain
  replaced_by  TEXT,                   -- token_hash of the token this was rotated into
  user_agent   TEXT,
  ip           TEXT,
  revoked_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx    ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_hash_idx    ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx  ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);

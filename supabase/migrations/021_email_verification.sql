-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — email verification + emailed login codes
-- ═══════════════════════════════════════════════════════════════════════════
-- Two related additions:
--
--  1. users.email_verified — whether the account's email has been confirmed
--     by entering a code we mailed to it. Existing accounts default to TRUE
--     (they predate this feature and shouldn't be locked out); brand-new
--     sign-ups explicitly insert FALSE and must confirm a code before they
--     can log in (register.ts / routes/auth/emailCodes.ts).
--
--  2. email_codes — short-lived 6-digit codes mailed to a user, for two
--     purposes:
--       'verify_email' — confirm the address at registration.
--       'login'        — passwordless login: enter your nickname/email, we
--                        mail a code, entering it signs you in (login stays
--                        available with a password too — this is an
--                        alternative, not a replacement).
--     Only the SHA-256 hash of the code is stored (same as password_resets),
--     never the code itself. `attempts` caps brute-forcing a code; `used_at`
--     makes a code single-use; issuing a new code supersedes older
--     outstanding ones by marking them used.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS email_codes (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email', 'login')),
  code_hash  TEXT NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The active code for a (user, purpose) is fetched as the newest unused row.
CREATE INDEX IF NOT EXISTS email_codes_user_purpose_idx
  ON email_codes (user_id, purpose, created_at DESC);

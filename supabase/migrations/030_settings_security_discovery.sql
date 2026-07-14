-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — settings hub: security (email 2FA, privacy), devices (login journal),
--         discovery rework (likes with messages, per-game анкета stats)
-- ═══════════════════════════════════════════════════════════════════════════

-- Email-based two-factor auth: when enabled, a correct password alone doesn't
-- issue a session — the server mails a 6-digit code (reusing the existing
-- email_codes 'login' purpose) and the client finishes via /api/auth/login-code.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS twofa_email_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Advanced privacy settings, flat jsonb of booleans. Absent key = default true:
--   discoverable  — show me in the "Найти" swipe feed
--   show_age      — show my age on the public profile / cards
--   show_country  — show my country
--   show_online   — show my online status / last seen to non-friends
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS privacy JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Анкета: per-game win count next to the existing rank/hours_played, so a
-- profile card can show different stats per game (Valorant vs LoL etc.).
ALTER TABLE user_games
  ADD COLUMN IF NOT EXISTS wins INT NOT NULL DEFAULT 0;

-- Likes rework: direction 'super' is now "письмо" — a like that carries a
-- short message shown to the target in their likes inbox.
ALTER TABLE swipes
  ADD COLUMN IF NOT EXISTS message TEXT;

-- The likes inbox reads "who liked me and I haven't answered yet".
CREATE INDEX IF NOT EXISTS swipes_target_idx ON swipes (target_user_id, created_at DESC);

-- Журнал входов: every sign-in attempt (successful or not) with device info.
CREATE TABLE IF NOT EXISTS login_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method     TEXT NOT NULL,                 -- password | code | passkey | 2fa
  success    BOOLEAN NOT NULL DEFAULT TRUE,
  ip         TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS login_events_user_idx ON login_events (user_id, created_at DESC);

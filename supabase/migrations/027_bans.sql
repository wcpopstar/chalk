-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — user bans (admin moderation)
-- ═══════════════════════════════════════════════════════════════════════════
-- A ban is a timestamp, not a boolean: banned_until in the future = banned
-- (permanent bans use a far-future date), in the past/null = fine. This gives
-- timed bans for free and needs no cron to "expire" them.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ban_reason   TEXT;

-- The admin panel lists currently-banned users; partial index keeps that
-- query cheap without indexing the (overwhelmingly null) rest of the table.
CREATE INDEX IF NOT EXISTS users_banned_until_idx ON users (banned_until)
  WHERE banned_until IS NOT NULL;

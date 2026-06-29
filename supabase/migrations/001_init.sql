-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — Supabase SQL migrations
-- Run once in the Supabase SQL Editor (or via migrate.js script below)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── EXTENSIONS ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for username search

-- ── GAMES (seed data) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
  id      TEXT PRIMARY KEY,            -- e.g. 'valorant'
  name    TEXT NOT NULL,
  emoji   TEXT NOT NULL DEFAULT '🎮',
  active  BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO games (id, name, emoji) VALUES
  ('valorant',  'Valorant',          '🎯'),
  ('cs2',       'CS2',               '💥'),
  ('apex',      'Apex Legends',      '🏆'),
  ('lol',       'League of Legends', '⚔️'),
  ('fortnite',  'Fortnite',          '🏗️'),
  ('dota2',     'Dota 2',            '🛡️'),
  ('overwatch', 'Overwatch 2',       '🦸'),
  ('pubg',      'PUBG',              '🪖')
ON CONFLICT (id) DO NOTHING;

-- ── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_emoji  TEXT NOT NULL DEFAULT '🎮',
  bio           TEXT,
  country       TEXT,
  languages     TEXT[] NOT NULL DEFAULT '{en}',
  status        TEXT NOT NULL DEFAULT 'offline',  -- online | offline | in_game
  avg_rating    NUMERIC(3,2),
  last_seen     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_username_trgm ON users USING gin (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_status_idx    ON users (status);
-- Add profile personalization fields if this migration is run against an existing schema.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS age INT,
  ADD COLUMN IF NOT EXISTS gender TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_age_check;
ALTER TABLE users ADD CONSTRAINT users_age_check CHECK (age IS NULL OR (age BETWEEN 13 AND 100));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gender_check;
ALTER TABLE users ADD CONSTRAINT users_gender_check
  CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to_say'));

UPDATE users SET onboarding_completed = TRUE WHERE onboarding_completed IS DISTINCT FROM TRUE;
-- ── USER GAMES ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_games (
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  game_id      TEXT REFERENCES games(id) ON DELETE CASCADE,
  rank         TEXT,
  hours_played INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game_id)
);

-- ── FRIENDS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friends (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | blocked
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_a, user_b),
  CHECK (user_a <> user_b)
);

CREATE INDEX IF NOT EXISTS friends_user_a_idx ON friends (user_a);
CREATE INDEX IF NOT EXISTS friends_user_b_idx ON friends (user_b);

-- ── SWIPES (Tinder mode) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS swipes (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction      TEXT NOT NULL,  -- left | right | super
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, target_user_id)
);

-- ── MATCH HISTORY ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS match_history (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    TEXT REFERENCES games(id),
  mode       TEXT NOT NULL DEFAULT 'solo',  -- solo | group
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS match_history_user_a_idx ON match_history (user_a);
CREATE INDEX IF NOT EXISTS match_history_user_b_idx ON match_history (user_b);

-- ── RATINGS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ratings (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id       UUID NOT NULL REFERENCES match_history(id) ON DELETE CASCADE,
  rater_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rated_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating         SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, rater_user_id)
);

-- ── CALLS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  initiated_by     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participants     UUID[] NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'solo',
  status           TEXT NOT NULL DEFAULT 'active',  -- active | ended
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  duration_seconds INT
);

-- ── CONVERSATIONS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type       TEXT NOT NULL DEFAULT 'direct',  -- direct | group
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── CONVERSATION MEMBERS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

-- ── MESSAGES ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT NOT NULL CHECK (length(text) <= 2000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conv_idx  ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender_id);

-- ── RPC: find_direct_conversation ────────────────────────────────────────────
-- Returns existing DM conversation ID between two users
CREATE OR REPLACE FUNCTION find_direct_conversation(user_a UUID, user_b UUID)
RETURNS TABLE(id UUID, type TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.type, c.created_at
  FROM conversations c
  WHERE c.type = 'direct'
    AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = user_a)
    AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = user_b);
$$;

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────
-- Enable RLS on sensitive tables. Service role key bypasses these.

ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends              ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public profiles readable" ON users;
DROP POLICY IF EXISTS "Own row writable" ON users;
DROP POLICY IF EXISTS "Friends visible to members" ON friends;
DROP POLICY IF EXISTS "Messages readable by members" ON messages;

-- Users can read public profiles (no email/password_hash)
CREATE POLICY "Public profiles readable" ON users
  FOR SELECT USING (true);

-- Users can update only their own row
CREATE POLICY "Own row writable" ON users
  FOR UPDATE USING (auth.uid()::text = id::text);

-- Friends visible to both parties
CREATE POLICY "Friends visible to members" ON friends
  FOR SELECT USING (
    auth.uid()::text = user_a::text OR
    auth.uid()::text = user_b::text
  );

-- Messages readable by conversation members
CREATE POLICY "Messages readable by members" ON messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM conversation_members
      WHERE conversation_id = messages.conversation_id
        AND user_id::text = auth.uid()::text
    )
  );

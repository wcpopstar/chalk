-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — message reactions, stories, saved messages, custom status
-- ═══════════════════════════════════════════════════════════════════════════
-- Four independent, additive features:
--
--  1. message_reactions — Telegram-style emoji reactions on a message. A user
--     may react with several different emoji to the same message but only once
--     per (message, emoji) pair, hence the composite PK. Reacting again with an
--     emoji you already used removes it (toggle), handled in socket/chat.ts.
--     ON DELETE CASCADE so deleting a message or a user cleans up their
--     reactions automatically.
--
--  2. stories — Instagram/Telegram-style stories: a photo a user posts that is
--     visible to their friends for 24h, then expires. The image rides as a
--     resized-JPEG data URL in image_url (same approach as users.avatar_url —
--     no separate storage bucket to provision), so length is bounded by the
--     column check. story_views records who has already seen a story so the
--     viewer can render a "seen" ring, and so the poster can count views.
--
--  3. conversations.type gains a third value, 'saved' — a single-member
--     conversation each user has with themselves ("Saved Messages"), reusing
--     the entire existing message pipeline. No schema change is needed for it
--     (conversations.type has no CHECK constraint) beyond documenting it here.
--
--  4. users.status_text — a short free-text status the user writes themselves
--     ("го играть"), shown under their name. Distinct from `status`
--     (connection state) and `presence` (online/away/busy picker).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Message reactions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  emoji      TEXT NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- All reactions of a message are read together when hydrating it for render.
CREATE INDEX IF NOT EXISTS message_reactions_msg_idx ON message_reactions (message_id);

-- ── 2. Stories ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stories (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_url  TEXT NOT NULL CHECK (length(image_url) <= 2000000), -- resized JPEG data URL
  caption    TEXT CHECK (caption IS NULL OR length(caption) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- The stories feed fetches every non-expired story for a set of user ids
-- (self + friends), newest first.
CREATE INDEX IF NOT EXISTS stories_user_active_idx ON stories (user_id, expires_at);
CREATE INDEX IF NOT EXISTS stories_expires_idx     ON stories (expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id  UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, viewer_id)
);

-- ── 4. Custom free-text status ───────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status_text TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_text_check;
ALTER TABLE users ADD CONSTRAINT users_status_text_check
  CHECK (status_text IS NULL OR length(status_text) <= 100);

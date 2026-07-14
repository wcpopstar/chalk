-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — Discord-style servers (guilds) with channels, roles & anti-spam
-- ═══════════════════════════════════════════════════════════════════════════
-- MVP scope: TEXT channels + roles/permissions + invites + spam protection.
-- Voice channels come in a later pass (server_channels.type already allows
-- 'voice' so the schema doesn't need to change for them — they'll reuse the
-- existing Agora layer with a channel name of `server-{serverId}-{channelId}`).
--
-- Permission model: each role carries a BIGINT bitmask (see
-- src/services/serverPermissions.ts for the bit constants). A member's
-- effective permissions are the OR of all their roles' masks; the ADMINISTRATOR
-- bit (and server ownership) grants everything. Roles are ordered by `position`
-- (higher = more senior) which also decides who can moderate whom.
--
-- Anti-spam is enforced in the app layer (routes/socket) on top of these
-- columns: per-channel slow-mode, the existing per-event socket rate limiter,
-- invite-creation limits, and role-gated posting. is_banned blocks a member
-- outright. Nothing here is security-by-schema — every write path re-checks
-- permissions server-side.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Servers ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS servers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  icon_emoji  TEXT CHECK (icon_emoji IS NULL OR length(icon_emoji) <= 8),
  icon_url    TEXT CHECK (icon_url IS NULL OR length(icon_url) <= 2000000), -- resized-JPEG data URL, like users.avatar_url
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS servers_owner_idx ON servers (owner_id);

-- ── Roles ────────────────────────────────────────────────────────────────────
-- Every server has exactly one is_default role (@everyone) that all members
-- implicitly have. permissions is a bitmask; position orders the hierarchy.
CREATE TABLE IF NOT EXISTS server_roles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color       TEXT CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  permissions BIGINT NOT NULL DEFAULT 0,
  position    INT NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS server_roles_server_idx ON server_roles (server_id, position DESC);
-- At most one @everyone role per server.
CREATE UNIQUE INDEX IF NOT EXISTS server_roles_one_default_idx
  ON server_roles (server_id) WHERE is_default;

-- ── Channels ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS server_channels (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  server_id         UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  type              TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'voice')),
  topic             TEXT CHECK (topic IS NULL OR length(topic) <= 300),
  position          INT NOT NULL DEFAULT 0,
  slow_mode_seconds INT NOT NULL DEFAULT 0 CHECK (slow_mode_seconds BETWEEN 0 AND 21600), -- anti-spam, max 6h
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS server_channels_server_idx ON server_channels (server_id, position);

-- ── Members ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS server_members (
  server_id  UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  nickname   TEXT CHECK (nickname IS NULL OR length(nickname) <= 40),
  is_banned  BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS server_members_user_idx ON server_members (user_id);

-- ── Member ↔ role assignments ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS server_member_roles (
  server_id  UUID NOT NULL,
  user_id    UUID NOT NULL,
  role_id    UUID NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  -- Assignments disappear automatically when the membership is removed.
  FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS server_member_roles_role_idx ON server_member_roles (role_id);

-- ── Channel messages ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS server_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id  UUID NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT CHECK (content IS NULL OR length(content) <= 4000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at   TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ
);
-- Channel history is read newest-first; slow-mode checks read a sender's most
-- recent message in a channel — both served by this composite index.
CREATE INDEX IF NOT EXISTS server_messages_channel_idx ON server_messages (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS server_messages_sender_recent_idx ON server_messages (channel_id, sender_id, created_at DESC);

-- ── Invites ──────────────────────────────────────────────────────────────────
-- code is a short random string used in an invite link. max_uses / expires_at
-- NULL mean "unlimited" / "never". uses is bumped on each successful join.
CREATE TABLE IF NOT EXISTS server_invites (
  code        TEXT PRIMARY KEY CHECK (length(code) BETWEEN 4 AND 32),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_uses    INT CHECK (max_uses IS NULL OR max_uses > 0),
  uses        INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS server_invites_server_idx ON server_invites (server_id);

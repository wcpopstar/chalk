-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — Voice channels + per-channel permission overrides
-- ═══════════════════════════════════════════════════════════════════════════
-- Two additions to the servers feature:
--
--  1. A new CONNECT_VOICE permission bit (1 << 10 = 1024). Voice channels reuse
--     the Agora layer (channel name `sc-<channelId>`); joining one requires this
--     bit. Back-fill it onto every existing @everyone role so members of servers
--     created before this migration keep the "everyone can talk" default.
--
--  2. server_channel_overrides — Discord-style per-channel permission overrides
--     keyed by (channel, role). `allow`/`deny` are bitmasks OR'd across the
--     roles a member holds and applied on top of their server-wide mask:
--         effective = (base & ~deny) | allow
--     This is what powers "who can write in #announcements" and "who can join
--     this voice channel". Owner / ADMINISTRATOR bypass overrides entirely.
--
-- Like every table in this schema, RLS is enabled with no policies: the backend
-- uses the service_role key (BYPASSRLS) and does its own authorization; the
-- anon key can touch nothing. See migration 031 for the full rationale.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Back-fill CONNECT_VOICE (1024) onto existing default (@everyone) roles.
UPDATE server_roles SET permissions = permissions | 1024 WHERE is_default = TRUE;

-- 2. Per-channel permission overrides.
CREATE TABLE IF NOT EXISTS server_channel_overrides (
  channel_id UUID   NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
  role_id    UUID   NOT NULL REFERENCES server_roles(id)    ON DELETE CASCADE,
  allow      BIGINT NOT NULL DEFAULT 0,
  deny       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, role_id)
);
CREATE INDEX IF NOT EXISTS server_channel_overrides_channel_idx
  ON server_channel_overrides (channel_id);

ALTER TABLE IF EXISTS public.server_channel_overrides ENABLE ROW LEVEL SECURITY;

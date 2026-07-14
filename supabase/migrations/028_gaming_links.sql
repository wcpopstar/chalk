-- Gaming platform handles shown as links on the public profile
-- (Steam vanity/id64, PSN id, Xbox gamertag, Riot id, FACEIT nick, Twitch login).
-- Stored as a flat jsonb object { steam: "...", psn: "...", ... } — the client
-- builds the actual profile URLs from these handles, so no arbitrary URLs are
-- ever stored or rendered.
alter table users add column if not exists gaming_links jsonb not null default '{}'::jsonb;

-- ── Close the RLS hole flagged by the Supabase security linter ──────────────
--
-- Every table in `public` is reachable over PostgREST with the project's anon
-- key. Without RLS, that means anyone holding that key (it is designed to be
-- publishable) can read, edit and delete the table's contents directly —
-- bypassing the API entirely. The linter reported 15 such tables; this
-- migration covers every table in the schema so none can be missed again.
--
-- Why enabling RLS with NO policies is safe here, and does not break the app:
--
--   * The backend talks to Postgres exclusively through `supabaseAdmin`, which
--     is built with the service_role key (src/services/supabase.ts). service_role
--     has the BYPASSRLS attribute — RLS is not evaluated for it at all.
--   * The anon client is exported from that same module but is never actually
--     used to query anything (`supabase.from(...)` appears nowhere in src/).
--   * The frontend in public/ never talks to Supabase directly; it goes through
--     this backend's REST + Socket.IO API, which does its own authorization.
--
-- So a table with RLS on and zero policies becomes: fully usable by the backend,
-- completely inaccessible to anon/authenticated. That is exactly what we want —
-- authorization for this project lives in the API layer, not in Postgres.
--
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY is idempotent, so the tables that
-- already had RLS (some enabled by hand in the dashboard, never recorded in a
-- migration — which is why the live database had drifted from this folder) are
-- simply reaffirmed here. Existing policies are left untouched.
--
-- NOTE: the table owner (the `postgres` role this migration runner connects as)
-- also bypasses RLS, so enabling it on schema_migrations cannot lock the runner
-- out of its own bookkeeping table.

ALTER TABLE IF EXISTS public.schema_migrations    ENABLE ROW LEVEL SECURITY;

-- Servers / guilds (migrations 022+) — the whole feature shipped without RLS.
ALTER TABLE IF EXISTS public.servers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.server_roles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.server_channels      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.server_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.server_member_roles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.server_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.server_invites       ENABLE ROW LEVEL SECURITY;

-- Credentials and auth material — the most damaging of the lot if reachable.
ALTER TABLE IF EXISTS public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.email_codes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.login_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.refresh_tokens       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.password_resets      ENABLE ROW LEVEL SECURITY;

-- Stories, reactions, scores.
ALTER TABLE IF EXISTS public.stories              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.story_views          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.message_reactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.game_scores          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.tetris_scores        ENABLE ROW LEVEL SECURITY;

-- Already enabled in the live database (by hand, outside this folder) — declared
-- here so migrations are once again the source of truth for the schema.
ALTER TABLE IF EXISTS public.users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.friends              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.conversations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.global_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.blocks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.reports              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.calls                ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.match_history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ratings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.swipes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_games           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.games                ENABLE ROW LEVEL SECURITY;

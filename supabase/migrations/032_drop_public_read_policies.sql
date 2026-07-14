-- ── Remove the policies that made RLS on `users` decorative ─────────────────
--
-- 031 turned RLS on everywhere, but a table with RLS enabled and a permissive
-- policy is still wide open. `users` had exactly that:
--
--   CREATE POLICY "Public profiles readable" ON users FOR SELECT USING (true);
--
-- USING (true) for the `public` role means "any caller may read every row".
-- With the anon key — which Supabase intends to be publishable — that exposed
-- all 24 rows of `users` in full: email, password_hash, and the e2ee_backup_*
-- secrets. Supabase's own linter never flagged it: rls_disabled_in_public only
-- checks whether RLS is *enabled*, not whether a policy hands everything away.
--
-- The remaining policies (blocks / friends / messages / reports, and the
-- "Own row writable" UPDATE on users) are all written against auth.uid().
-- This project does not use Supabase Auth at all — accounts live in our own
-- `users` table with bcrypt hashes, and sessions are our own JWTs (utils/jwt.ts).
-- auth.uid() is therefore always NULL here, so those policies grant nothing.
-- They are dead code that reads like a security model, which is worse than
-- having none: the next person to touch this will assume it's load-bearing.
--
-- After this migration every table is RLS-on with zero policies: unreachable
-- for anon/authenticated, fully available to the service_role key the backend
-- uses. Authorization for this app lives in the API layer (routes + socket
-- handlers), which is where it is actually tested.
--
-- If a table ever genuinely needs to be read straight from the browser, add a
-- narrow policy for that specific case — never USING (true) on a table that
-- holds credentials.

DROP POLICY IF EXISTS "Public profiles readable"  ON public.users;
DROP POLICY IF EXISTS "Own row writable"          ON public.users;
DROP POLICY IF EXISTS "Blocks visible to blocker" ON public.blocks;
DROP POLICY IF EXISTS "Friends visible to members" ON public.friends;
DROP POLICY IF EXISTS "Messages readable by members" ON public.messages;
DROP POLICY IF EXISTS "Reports visible to reporter" ON public.reports;

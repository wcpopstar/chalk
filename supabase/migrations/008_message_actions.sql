-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — message actions: edit, delete, voice notes, gifs
-- ═══════════════════════════════════════════════════════════════════════════

-- ── conversation messages ────────────────────────────────────────────────────
ALTER TABLE messages
  ALTER COLUMN text DROP NOT NULL;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_text_check;
ALTER TABLE messages ADD CONSTRAINT messages_text_check
  CHECK (text IS NULL OR length(text) <= 2000);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS type             TEXT NOT NULL DEFAULT 'text', -- text | voice | gif
  ADD COLUMN IF NOT EXISTS media_url        TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds INT,
  ADD COLUMN IF NOT EXISTS edited_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMPTZ;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text', 'voice', 'gif'));

-- ── global (platform-wide) messages ──────────────────────────────────────────
ALTER TABLE global_messages
  ALTER COLUMN text DROP NOT NULL;

ALTER TABLE global_messages
  ADD COLUMN IF NOT EXISTS type             TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_url        TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds INT,
  ADD COLUMN IF NOT EXISTS edited_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMPTZ;

ALTER TABLE global_messages DROP CONSTRAINT IF EXISTS global_messages_type_check;
ALTER TABLE global_messages ADD CONSTRAINT global_messages_type_check
  CHECK (type IN ('text', 'voice', 'gif'));

-- ── storage bucket for voice notes ───────────────────────────────────────────
-- Public bucket so playback works via a plain <audio src> URL.
-- (If your Supabase project has RLS on storage.objects, service-role writes
--  still bypass it — this policy is only needed for public reads.)
INSERT INTO storage.buckets (id, name, public)
VALUES ('voice-notes', 'voice-notes', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Voice notes publicly readable" ON storage.objects;
CREATE POLICY "Voice notes publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'voice-notes');

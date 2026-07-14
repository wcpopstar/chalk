-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — chat attachments: photos, videos and arbitrary files
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds three new message types (image / video / file) and a public storage
-- bucket for them, mirroring the voice-notes / video-notes setup (migration
-- 010). Uploads go through the service-role key (server-side, see
-- socket/media.ts) so only a public-read policy is needed here.

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text', 'voice', 'gif', 'video_note', 'youtube', 'image', 'video', 'file'));

ALTER TABLE global_messages DROP CONSTRAINT IF EXISTS global_messages_type_check;
ALTER TABLE global_messages ADD CONSTRAINT global_messages_type_check
  CHECK (type IN ('text', 'voice', 'gif', 'video_note', 'youtube', 'image', 'video', 'file'));

-- ── storage bucket for chat attachments ──────────────────────────────────────
-- Public bucket so <img>/<video src> and file download links work with a plain
-- URL. Files are stored with Content-Type application/octet-stream (see
-- socket/media.ts) so an uploaded .html/.svg can't be rendered inline.
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-media', 'chat-media', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Chat media publicly readable" ON storage.objects;
CREATE POLICY "Chat media publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'chat-media');

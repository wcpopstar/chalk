-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — video notes ("video kruzhki"): circular video messages
-- ═══════════════════════════════════════════════════════════════════════════

-- ── conversation messages: allow the new type ────────────────────────────────
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text', 'voice', 'gif', 'video_note', 'youtube'));

-- ── global (platform-wide) messages: allow the new type ──────────────────────
ALTER TABLE global_messages DROP CONSTRAINT IF EXISTS global_messages_type_check;
ALTER TABLE global_messages ADD CONSTRAINT global_messages_type_check
  CHECK (type IN ('text', 'voice', 'gif', 'video_note', 'youtube'));

-- ── storage bucket for video notes ───────────────────────────────────────────
-- Public bucket so playback works via a plain <video src> URL.
INSERT INTO storage.buckets (id, name, public)
VALUES ('video-notes', 'video-notes', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Video notes publicly readable" ON storage.objects;
CREATE POLICY "Video notes publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'video-notes');

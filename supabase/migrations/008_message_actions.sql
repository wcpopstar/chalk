-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — message actions: edit, delete, voice notes, gifs, youtube
-- ═══════════════════════════════════════════════════════════════════════════

-- ── conversation messages ────────────────────────────────────────────────────
ALTER TABLE messages
  ALTER COLUMN text DROP NOT NULL;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_text_check;
ALTER TABLE messages ADD CONSTRAINT messages_text_check
  CHECK (text IS NULL OR length(text) <= 2000);

-- Добавляем/обновляем поля для rich-сообщений
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS type            TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_url       TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds INT,
  ADD COLUMN IF NOT EXISTS edited_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

-- Главный constraint
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text', 'youtube', 'gif', 'voice', 'video', 'image'));

-- Индексы (рекомендуется)
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(deleted_at) WHERE deleted_at IS NULL;

-- ── global messages (если используешь глобальный чат) ───────────────────────
ALTER TABLE global_messages
  ALTER COLUMN text DROP NOT NULL;

ALTER TABLE global_messages
  ADD COLUMN IF NOT EXISTS type            TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_url       TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds INT,
  ADD COLUMN IF NOT EXISTS edited_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

ALTER TABLE global_messages DROP CONSTRAINT IF EXISTS global_messages_type_check;
ALTER TABLE global_messages ADD CONSTRAINT global_messages_type_check
  CHECK (type IN ('text', 'youtube', 'gif', 'voice', 'video', 'image'));

-- ── Storage bucket for voice/video notes ─────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('voice-notes', 'voice-notes', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('video-notes', 'video-notes', true)
ON CONFLICT (id) DO NOTHING;

-- Политики для публичного чтения
DROP POLICY IF EXISTS "Voice notes publicly readable" ON storage.objects;
CREATE POLICY "Voice notes publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'voice-notes');

DROP POLICY IF EXISTS "Video notes publicly readable" ON storage.objects;
CREATE POLICY "Video notes publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'video-notes');
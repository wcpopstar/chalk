-- ── YouTube link previews: persist so they survive a page reload ─────────────
-- Previously the preview (title/thumbnail/videoId) was only attached to the
-- in-memory message object right before the socket emit, never written to
-- the DB — so history loaded from the API had nothing to render.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS preview_title     TEXT,
  ADD COLUMN IF NOT EXISTS preview_url       TEXT,
  ADD COLUMN IF NOT EXISTS preview_thumbnail TEXT,
  ADD COLUMN IF NOT EXISTS preview_video_id  TEXT;

ALTER TABLE global_messages
  ADD COLUMN IF NOT EXISTS preview_title     TEXT,
  ADD COLUMN IF NOT EXISTS preview_url       TEXT,
  ADD COLUMN IF NOT EXISTS preview_thumbnail TEXT,
  ADD COLUMN IF NOT EXISTS preview_video_id  TEXT;

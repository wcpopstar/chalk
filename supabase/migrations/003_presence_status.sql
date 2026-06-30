-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — User-selectable presence status (online / away / busy)
-- Run once in the Supabase SQL Editor (or via migrate.js script)
--
-- NOTE: this is separate from the existing `status` column, which tracks
-- connection state (online/offline) and is managed automatically by the
-- socket server. `presence` is the status the user picks themselves and
-- persists across sessions; it only matters visually while `status='online'`.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS presence TEXT NOT NULL DEFAULT 'online';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_presence_check;
ALTER TABLE users ADD CONSTRAINT users_presence_check
  CHECK (presence IN ('online', 'away', 'busy'));

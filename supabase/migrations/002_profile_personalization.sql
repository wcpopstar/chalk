-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — Profile personalization (age, gender, avatar photo, onboarding flag)
-- Run once in the Supabase SQL Editor (or via migrate.js script)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS age        INT,
  ADD COLUMN IF NOT EXISTS gender     TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;

-- Keep data sane
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_age_check;
ALTER TABLE users ADD CONSTRAINT users_age_check CHECK (age IS NULL OR (age BETWEEN 13 AND 100));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gender_check;
ALTER TABLE users ADD CONSTRAINT users_gender_check
  CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to_say'));

-- Accounts created before this migration already "finished" signing up —
-- don't force them through the new onboarding wizard.
UPDATE users SET onboarding_completed = TRUE WHERE onboarding_completed IS DISTINCT FROM TRUE;

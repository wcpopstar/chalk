-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — E2EE key backup (cross-device sync + localStorage-loss recovery)
--
-- Problem this solves (v1 limitation of 015_e2ee.sql): the X25519 secret key
-- lived ONLY in one browser's localStorage. A new device generated a fresh
-- keypair (old messages unreadable there), and clearing site data destroyed
-- the key entirely.
--
-- Design: the client encrypts its secret key with a key derived from the
-- user's LOGIN PASSWORD (PBKDF2-SHA256 -> nacl.secretbox) and uploads the
-- resulting blob here. The server only ever sees ciphertext — it stores the
-- bcrypt hash of the password, not the password, so it cannot derive the
-- backup key. On login from any device the client re-derives the key from
-- the typed password and restores the same keypair, so all devices share one
-- identity and old messages stay readable.
--
-- Trade-off (inherent to password-wrapped backups): a password RESET (forgot
-- password — old password unknown) makes the backup undecryptable; the
-- client then falls back to generating a fresh keypair and re-uploads a new
-- backup encrypted with the new password. A normal re-login with a known
-- password — including right after a password change — re-wraps the backup
-- transparently.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  -- nacl.secretbox(secretKey[32], nonce, PBKDF2(password, salt, iters)):
  -- 32 + 16-byte auth tag = 48 raw bytes -> 64 base64 chars.
  ADD COLUMN IF NOT EXISTS e2ee_backup_secret TEXT,
  -- 24 raw bytes -> exactly 32 base64 chars.
  ADD COLUMN IF NOT EXISTS e2ee_backup_nonce  TEXT,
  -- PBKDF2 salt, 16 raw bytes -> 24 base64 chars.
  ADD COLUMN IF NOT EXISTS e2ee_backup_salt   TEXT,
  -- PBKDF2 iteration count stored per-row so it can be raised later without
  -- breaking existing backups.
  ADD COLUMN IF NOT EXISTS e2ee_backup_iters  INTEGER;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2ee_backup_secret_len_check;
ALTER TABLE users ADD CONSTRAINT users_e2ee_backup_secret_len_check
  CHECK (e2ee_backup_secret IS NULL OR length(e2ee_backup_secret) BETWEEN 44 AND 128);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2ee_backup_nonce_len_check;
ALTER TABLE users ADD CONSTRAINT users_e2ee_backup_nonce_len_check
  CHECK (e2ee_backup_nonce IS NULL OR length(e2ee_backup_nonce) = 32);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2ee_backup_salt_len_check;
ALTER TABLE users ADD CONSTRAINT users_e2ee_backup_salt_len_check
  CHECK (e2ee_backup_salt IS NULL OR length(e2ee_backup_salt) BETWEEN 16 AND 44);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2ee_backup_iters_check;
ALTER TABLE users ADD CONSTRAINT users_e2ee_backup_iters_check
  CHECK (e2ee_backup_iters IS NULL OR e2ee_backup_iters BETWEEN 100000 AND 10000000);

-- All four travel together: a backup is either fully present or fully absent.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2ee_backup_consistency_check;
ALTER TABLE users ADD CONSTRAINT users_e2ee_backup_consistency_check
  CHECK (
    (e2ee_backup_secret IS NOT NULL AND e2ee_backup_nonce IS NOT NULL AND e2ee_backup_salt IS NOT NULL AND e2ee_backup_iters IS NOT NULL)
    OR
    (e2ee_backup_secret IS NULL AND e2ee_backup_nonce IS NULL AND e2ee_backup_salt IS NULL AND e2ee_backup_iters IS NULL)
  );

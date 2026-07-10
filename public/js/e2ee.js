// ── E2EE for direct (1:1) chats ──────────────────────────────────────────────
// NaCl `box` (X25519-XSalsa20-Poly1305, via the vendored tweetnacl <script>
// loaded in index.html). Every user has ONE long-term keypair shared across
// their devices; only the public half is ever sent to the server as-is
// (users.public_key). The server stores and relays ciphertext without being
// able to read it.
//
// Cross-device sync / recovery: the secret key is also uploaded to the
// server, but wrapped client-side with a key derived from the user's LOGIN
// PASSWORD (PBKDF2-SHA256 -> nacl.secretbox) — see users.e2ee_backup_* and
// supabase/migrations/016_e2ee_key_backup.sql. The server only stores the
// bcrypt hash of the password, so it can't derive the wrapping key. Logging
// in on a new device (password typed -> captured below) restores the same
// keypair, so old messages stay readable, and clearing localStorage is
// recoverable on the next password login.
//
// Remaining limits:
//  - direct conversations only — group chats still send plaintext `text`
//  - text messages only — gif/voice/video_note stay unencrypted
//  - a password RESET (forgot password) makes the backup undecryptable —
//    the client falls back to a fresh keypair; messages encrypted to the
//    old key are unreadable. A normal login with a known password (incl.
//    right after a password change) transparently re-wraps the backup.
//
// Why "sender_public_key" matters for decrypting your OWN sent messages:
// nacl.box's shared secret is symmetric — ECDH(mySecret, theirPublic) ==
// ECDH(theirSecret, myPublic) — so decrypting always needs "the other
// party's public key at the time the message was encrypted" + your own
// current secret key. For a message someone else sent *to* you, that's the
// sender's key, which is exactly what the server stamped onto the row
// (m.sender_public_key). For a message *you* sent, "the other party" is
// your conversation partner, so we use currentConvPartner.public_key
// instead. See e2eeDecryptMessage() below.

const E2EE_STORAGE_PREFIX = 'chalk_e2ee_sk_'; // + userId -> base64 secret key
const E2EE_PBKDF2_ITERS = 310000; // OWASP 2023+ floor for PBKDF2-SHA256

function e2eeStorageKey(userId) {
  return E2EE_STORAGE_PREFIX + userId;
}

// ---- base64 <-> bytes (browser-native, no extra dependency) ----
function e2eeBytesToB64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function e2eeB64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

var _e2eeKeyPair = null; // { publicKey: Uint8Array, secretKey: Uint8Array }

// The login/register form hands the typed password to this module (memory
// only, never persisted) so ensureE2eeKeypair() can wrap/unwrap the key
// backup. Cleared as soon as the keypair sync finishes. On a token-only
// session restore (F5) there's no password — that's fine, the local key is
// still in localStorage in that case.
var _e2eePassword = null;
function e2eeCapturePassword(password) {
  _e2eePassword = password || null;
}

// PBKDF2-SHA256 -> 32-byte key for nacl.secretbox. WebCrypto needs a secure
// context (https/localhost) — callers handle the null fallback.
async function e2eeDeriveWrapKey(password, saltBytes, iterations) {
  if (!window.crypto || !crypto.subtle) return null;
  try {
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
      baseKey, 256
    );
    return new Uint8Array(bits);
  } catch (e) {
    console.error('Не удалось вывести ключ из пароля', e);
    return null;
  }
}

// Wraps the secret key with the password for server-side storage. Returns
// the four users.e2ee_backup_* fields, or null if WebCrypto is unavailable.
async function e2eeBuildBackup(secretKey, password) {
  const salt = nacl.randomBytes(16);
  const wrapKey = await e2eeDeriveWrapKey(password, salt, E2EE_PBKDF2_ITERS);
  if (!wrapKey) return null;
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const boxed = nacl.secretbox(secretKey, nonce, wrapKey);
  return {
    e2ee_backup_secret: e2eeBytesToB64(boxed),
    e2ee_backup_nonce: e2eeBytesToB64(nonce),
    e2ee_backup_salt: e2eeBytesToB64(salt),
    e2ee_backup_iters: E2EE_PBKDF2_ITERS,
  };
}

// Tries to unwrap the server-stored backup with the password. Returns the
// 32-byte secret key, or null (no backup / wrong password / tampered blob —
// secretbox authenticates, so a wrong password can't yield garbage).
async function e2eeOpenBackup(user, password) {
  if (!user || !user.e2ee_backup_secret || !user.e2ee_backup_nonce || !user.e2ee_backup_salt || !user.e2ee_backup_iters) return null;
  try {
    const wrapKey = await e2eeDeriveWrapKey(password, e2eeB64ToBytes(user.e2ee_backup_salt), user.e2ee_backup_iters);
    if (!wrapKey) return null;
    const opened = nacl.secretbox.open(
      e2eeB64ToBytes(user.e2ee_backup_secret),
      e2eeB64ToBytes(user.e2ee_backup_nonce),
      wrapKey
    );
    return opened || null;
  } catch (e) {
    console.error('Не удалось расшифровать резервную копию ключа', e);
    return null;
  }
}

function e2eeSecretToKeyPair(secretKey) {
  const { publicKey } = nacl.box.keyPair.fromSecretKey(secretKey);
  return { secretKey, publicKey };
}

function e2eeSaveLocalKey(secretKey) {
  localStorage.setItem(e2eeStorageKey(currentUser.id), e2eeBytesToB64(secretKey));
}

// Step 1: this browser already has a key in localStorage.
function e2eeLoadLocalKey() {
  const stored = localStorage.getItem(e2eeStorageKey(currentUser.id));
  if (!stored) return null;
  try {
    return e2eeSecretToKeyPair(e2eeB64ToBytes(stored));
  } catch (e) {
    console.error('Повреждённый локальный ключ шифрования', e);
    return null;
  }
}

// Step 2 (split-brain reconciliation): if the local key does NOT match the
// server's current public_key, but the server backup unwraps to the key
// that DOES, adopt the server identity — that's the key other people are
// encrypting to, and the one this account's other devices share.
async function e2eeReconcileWithServer(localPair, password) {
  if (!localPair || !password || !currentUser.public_key) return localPair;
  if (e2eeBytesToB64(localPair.publicKey) === currentUser.public_key) return localPair;
  const backupSecret = await e2eeOpenBackup(currentUser, password);
  if (!backupSecret) return localPair;
  const backupPair = e2eeSecretToKeyPair(backupSecret);
  if (e2eeBytesToB64(backupPair.publicKey) !== currentUser.public_key) return localPair;
  e2eeSaveLocalKey(backupSecret);
  return backupPair;
}

// Step 5: public key on the server must match this keypair, and — when we
// have the password in hand — the backup must unwrap to this exact secret
// key (re-wraps automatically after a password change/reset).
async function e2eeSyncToServer(password) {
  const updates = {};
  const myPublicB64 = e2eeBytesToB64(_e2eeKeyPair.publicKey);
  if (currentUser.public_key !== myPublicB64) updates.public_key = myPublicB64;

  if (password) {
    const backupSecret = await e2eeOpenBackup(currentUser, password);
    const backupCurrent = backupSecret && e2eeBytesToB64(backupSecret) === e2eeBytesToB64(_e2eeKeyPair.secretKey);
    if (!backupCurrent) {
      const backup = await e2eeBuildBackup(_e2eeKeyPair.secretKey, password);
      if (backup) Object.assign(updates, backup);
    }
  }

  if (!Object.keys(updates).length) return;
  try {
    const data = await api('/api/users/me', { method: 'PATCH', body: JSON.stringify(updates) });
    if (data && data.user) {
      currentUser.public_key = data.user.public_key;
      currentUser.e2ee_backup_secret = data.user.e2ee_backup_secret;
      currentUser.e2ee_backup_nonce = data.user.e2ee_backup_nonce;
      currentUser.e2ee_backup_salt = data.user.e2ee_backup_salt;
      currentUser.e2ee_backup_iters = data.user.e2ee_backup_iters;
    }
  } catch (e) {
    console.error('Не удалось синхронизировать ключ шифрования с сервером', e);
  }
}

// Loads (localStorage) or restores (server backup + password) or generates
// this user's keypair, then makes sure the server has the matching public
// key and an up-to-date password-wrapped backup. Call once per session,
// after currentUser is populated — see auth.js `afterAuth()`.
async function ensureE2eeKeypair() {
  if (!currentUser || !currentUser.id) return null;
  if (typeof nacl === 'undefined') { console.error('tweetnacl не загружен — шифрование недоступно'); return null; }

  const password = _e2eePassword;
  _e2eePassword = null; // single use — never keep the password around

  _e2eeKeyPair = await e2eeReconcileWithServer(e2eeLoadLocalKey(), password);

  // No local key — restore from the server backup (new device or cleared
  // localStorage; the password was just typed at login).
  if (!_e2eeKeyPair && password) {
    const backupSecret = await e2eeOpenBackup(currentUser, password);
    if (backupSecret) {
      _e2eeKeyPair = e2eeSecretToKeyPair(backupSecret);
      e2eeSaveLocalKey(backupSecret);
    }
  }

  // Still nothing (first ever login, or password-reset made the backup
  // undecryptable) — generate a fresh keypair.
  if (!_e2eeKeyPair) {
    _e2eeKeyPair = nacl.box.keyPair();
    e2eeSaveLocalKey(_e2eeKeyPair.secretKey);
  }

  await e2eeSyncToServer(password);
  return _e2eeKeyPair;
}

function e2eeReady() {
  return Boolean(_e2eeKeyPair);
}

// Encrypts `plaintext` for `recipientPublicKeyB64`. Returns { ciphertext,
// nonce } (both base64) or null if we're not ready / the key is bad.
function e2eeEncrypt(plaintext, recipientPublicKeyB64) {
  if (!_e2eeKeyPair || !recipientPublicKeyB64) return null;
  try {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const messageBytes = new TextEncoder().encode(plaintext);
    const recipientPublicKey = e2eeB64ToBytes(recipientPublicKeyB64);
    const box = nacl.box(messageBytes, nonce, recipientPublicKey, _e2eeKeyPair.secretKey);
    return { ciphertext: e2eeBytesToB64(box), nonce: e2eeBytesToB64(nonce) };
  } catch (e) {
    console.error('Ошибка шифрования сообщения', e);
    return null;
  }
}

// Guarded encrypt shared by the send and edit paths (chat-send.js /
// message-edit.js): checks the partner key and local readiness, encrypts,
// and toasts the matching error itself. Returns { ciphertext, nonce } or
// null — the caller just aborts on null.
function e2eeEncryptOrToast(plaintext, recipientPublicKeyB64) {
  if (!recipientPublicKeyB64) { showToast('❌ Нет ключа собеседника — не получится зашифровать'); return null; }
  if (!e2eeReady()) { showToast('❌ Шифрование ещё не готово, подожди секунду и попробуй снова'); return null; }
  const enc = e2eeEncrypt(plaintext, recipientPublicKeyB64);
  if (!enc) showToast('❌ Не удалось зашифровать сообщение');
  return enc;
}

// Low-level decrypt: returns plaintext string, or null if it can't be
// opened (wrong/missing key, corrupted data, tampering).
function e2eeDecrypt(ciphertextB64, nonceB64, theirPublicKeyB64) {
  if (!_e2eeKeyPair || !ciphertextB64 || !nonceB64 || !theirPublicKeyB64) return null;
  try {
    const cipherBytes = e2eeB64ToBytes(ciphertextB64);
    const nonceBytes = e2eeB64ToBytes(nonceB64);
    const theirPublicKey = e2eeB64ToBytes(theirPublicKeyB64);
    const opened = nacl.box.open(cipherBytes, nonceBytes, theirPublicKey, _e2eeKeyPair.secretKey);
    if (!opened) return null;
    return new TextDecoder().decode(opened);
  } catch (e) {
    console.error('Ошибка расшифровки сообщения', e);
    return null;
  }
}

// Message-aware decrypt: picks the right "other party" key depending on
// whether the current user sent this particular message or received it (see
// the file header comment for why these differ). Returns plaintext, or null
// if it can't be decrypted (message-render.js shows a placeholder for that).
function e2eeDecryptMessage(m) {
  if (!m || !m.is_encrypted) return m ? (m.text || '') : '';
  const isMe = m.sender_id === (currentUser && currentUser.id);
  const theirPublicKey = isMe
    ? (currentConvPartner && currentConvPartner.public_key)
    : m.sender_public_key;
  return e2eeDecrypt(m.text, m.nonce, theirPublicKey);
}

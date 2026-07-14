// ── PASSKEYS (WebAuthn) ──────────────────────────────────────────────────────
// Passwordless login + credential management. Server side: routes/auth/passkeys.ts.
// The WebAuthn API speaks ArrayBuffers while the server speaks base64url, so
// everything below is mostly encode/decode glue around navigator.credentials.

function pkB64uToBuf(s) {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(norm + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function pkBufToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function passkeysSupported() {
  return Boolean(window.PublicKeyCredential && navigator.credentials);
}

// ── Login with a passkey (auth screen) ──────────────────────────────────────
async function passkeyLogin() {
  if (!passkeysSupported()) return showAuthError(T('passkeys_unsupported', 'Этот браузер не поддерживает ключи доступа'));
  const btn = document.getElementById('passkeyLoginBtn');
  if (btn) btn.disabled = true;
  try {
    const { options, sessionId } = await api('/api/auth/passkey/login-options', { method: 'POST' });
    const publicKey = Object.assign({}, options, {
      challenge: pkB64uToBuf(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => Object.assign({}, c, { id: pkB64uToBuf(c.id) })),
    });
    const cred = await navigator.credentials.get({ publicKey });
    const response = {
      id: cred.id,
      rawId: pkBufToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: pkBufToB64u(cred.response.clientDataJSON),
        authenticatorData: pkBufToB64u(cred.response.authenticatorData),
        signature: pkBufToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? pkBufToB64u(cred.response.userHandle) : undefined,
      },
    };
    const data = await api('/api/auth/passkey/login-verify', { method: 'POST', body: JSON.stringify({ response, sessionId }) });
    setSession(data);
    // No password typed → E2EE has nothing to capture; the keypair comes from
    // localStorage or stays locked until the user next logs in with a password.
    afterAuth();
  } catch (e) {
    // NotAllowedError = user dismissed the browser prompt — not an error worth shouting about.
    if (e && e.name === 'NotAllowedError') return;
    if (e && e.data && e.data.banned) showAuthError(banMessage(e.data));
    else showAuthError((e && e.message) || T('passkeys_failed', 'Не удалось войти по ключу доступа'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Register a new passkey (profile page, logged in) ────────────────────────
async function addPasskey() {
  if (!passkeysSupported()) return showToast(T('passkeys_unsupported', 'Этот браузер не поддерживает ключи доступа'));
  try {
    const { options } = await api('/api/auth/passkey/register-options', { method: 'POST' });
    const publicKey = Object.assign({}, options, {
      challenge: pkB64uToBuf(options.challenge),
      user: Object.assign({}, options.user, { id: pkB64uToBuf(options.user.id) }),
      excludeCredentials: (options.excludeCredentials || []).map((c) => Object.assign({}, c, { id: pkB64uToBuf(c.id) })),
    });
    const cred = await navigator.credentials.create({ publicKey });
    const response = {
      id: cred.id,
      rawId: pkBufToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: pkBufToB64u(cred.response.clientDataJSON),
        attestationObject: pkBufToB64u(cred.response.attestationObject),
        transports: (cred.response.getTransports && cred.response.getTransports()) || [],
      },
    };
    const deviceName = navigator.platform || 'Устройство';
    await api('/api/auth/passkey/register-verify', { method: 'POST', body: JSON.stringify({ response, deviceName }) });
    showToast(`${T('passkeys_added', 'Ключ доступа добавлен')} ✓`);
    loadPasskeys();
  } catch (e) {
    if (e && e.name === 'NotAllowedError') return;
    showToast((e && e.message) || T('passkeys_failed_add', 'Не удалось добавить ключ доступа'));
  }
}

// ── List + delete own passkeys on the profile page ──────────────────────────
async function loadPasskeys() {
  const box = document.getElementById('passkeyList');
  if (!box || !currentUser) return;
  try {
    const data = await api('/api/auth/passkey/list');
    const keys = data.passkeys || [];
    if (!keys.length) {
      box.innerHTML = `<div style="font-size:11.5px;color:var(--muted)">${T('passkeys_empty', 'Пока нет ни одного ключа')}</div>`;
      return;
    }
    box.innerHTML = keys.map((k) => {
      const created = k.created_at ? new Date(k.created_at).toLocaleDateString() : '';
      return `<div class="settings-row"><span class="settings-label">🔑 ${escHtml(k.device_name || T('passkeys_key', 'Ключ'))}</span>` +
        `<span class="settings-value" style="display:flex;align-items:center;gap:10px">${created}` +
        `<button class="blocked-unblock-btn" onclick="deletePasskey('${escHtml(k.id)}')" title="Удалить">✕</button></span></div>`;
    }).join('');
  } catch (_) {
    box.innerHTML = '';
  }
}

async function deletePasskey(id) {
  try {
    await api(`/api/auth/passkey/${encodeURIComponent(id)}`, { method: 'DELETE' });
    loadPasskeys();
  } catch (e) {
    showToast((e && e.message) || 'Ошибка');
  }
}

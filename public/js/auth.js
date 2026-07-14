// ── AUTH ─────────────────────────────────────────────────────────────────────
function switchAuthTab(tab, btn) {
  document.querySelectorAll('.auth-tab').forEach((b) =>{ b.classList.remove('active') });
  if (btn) btn.classList.add('active');
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('forgotForm').style.display = tab === 'forgot' ? 'block' : 'none';
  document.getElementById('resetForm').style.display = tab === 'reset' ? 'block' : 'none';
  const codeForm = document.getElementById('codeForm');
  if (codeForm) codeForm.style.display = tab === 'code' ? 'block' : 'none';
  const tabsRow = document.querySelector('.auth-tabs');
  if (tabsRow) tabsRow.style.display = (tab === 'login' || tab === 'register') ? 'flex' : 'none';
  document.getElementById('authError').classList.remove('show');
}

// ── EMAIL CODES (verification + passwordless login) ──────────────────────────
// Shared state for the code screen. mode is 'verify_email' or 'login'; it
// decides which endpoint submitCode() hits. __pendingPassword is the password
// typed on the register/login form, kept in memory so the E2EE key backup can
// still be created once verification finishes (see e2eeCapturePassword).
window.__codeMode = null;
window.__codeIdentifier = null;
window.__pendingPassword = null;

function maskEmail(email) {
  if (!email || email.indexOf('@') < 0) return email || '';
  const [name, domain] = email.split('@');
  const shown = name.length <= 2 ? name[0] : `${name.slice(0, 2)}***`;
  return `${shown}@${domain}`;
}

// Opens the code-entry screen for the given mode/identifier. `email` (may be
// masked already) is shown in the hint so the user knows where to look.
function showCodeForm(mode, identifier, email) {
  window.__codeMode = mode;
  window.__codeIdentifier = identifier;
  switchAuthTab('code');
  const hint = document.getElementById('codeHint');
  if (hint) {
    const where = email ? maskEmail(email) : T('auth_your_email');
    hint.textContent = mode === 'login'
      ? T('auth_code_hint_login').replace('{email}', where)
      : T('auth_code_hint_verify').replace('{email}', where);
  }
  const input = document.getElementById('codeInput');
  if (input) { input.value = ''; setTimeout(() =>{ input.focus(); }, 50); }
}

async function submitCode() {
  const btn = document.getElementById('codeBtn');
  const code = (document.getElementById('codeInput').value || '').trim();
  if (!/^\d{6}$/.test(code)) return showAuthError(T('auth_err_code_6digits'));
  const identifier = window.__codeIdentifier;
  const endpoint = window.__codeMode === 'login' ? '/api/auth/login-code' : '/api/auth/verify-email';
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span>${  T('auth_checking')}`;
  try {
    const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ identifier, code }) });
    setSession(data);
    // Now that we're in, hand the remembered password (if any) to E2EE so the
    // key backup can be (re)wrapped. Passwordless login has none — E2EE falls
    // back to its own device-key handling in that case.
    if (window.__pendingPassword) { e2eeCapturePassword(window.__pendingPassword); window.__pendingPassword = null; }
    afterAuth();
  } catch(e) {
    showAuthError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = T('auth_confirm_code_btn');
  }
}

async function resendCode() {
  const identifier = window.__codeIdentifier;
  const purpose = window.__codeMode === 'login' ? 'login' : 'verify_email';
  if (!identifier) return;
  try {
    const data = await api('/api/auth/resend-code', { method: 'POST', body: JSON.stringify({ identifier, purpose }) });
    showAuthError(data.message || T('auth_code_resent'), true);
  } catch(e) {
    showAuthError(e.message);
  }
}

// Passwordless login: uses whatever is typed in the login identifier field.
async function requestLoginCode() {
  const identifier = document.getElementById('loginEmail').value.trim();
  if (!identifier) return showAuthError(T('placeholder_login_identifier'));
  try {
    const data = await api('/api/auth/request-login-code', { method: 'POST', body: JSON.stringify({ identifier }) });
    window.__pendingPassword = null;
    showCodeForm('login', identifier, null);
    showAuthError(data.message || T('auth_code_sent'), true);
  } catch(e) {
    showAuthError(e.message);
  }
}

async function forgotPassword() {
  const btn = document.getElementById('forgotBtn');
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) return showAuthError(T('err_specify_email'));
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span>${  T('auth_sending')}`;
  try {
    const data = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    showAuthError(data.message || T('auth_msg_if_registered_link_sent'), true);
  } catch(e) {
    showAuthError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = T('btn_send_link');
  }
}

async function resetPassword() {
  const btn = document.getElementById('resetBtn');
  const password = document.getElementById('resetPassword').value;
  const password2 = document.getElementById('resetPassword2').value;
  const resetToken = window.__resetToken;
  if (!resetToken) return showAuthError(T('auth_err_invalid_link'));
  if (!password || password.length < 6) return showAuthError(T('auth_err_password_min6'));
  if (password !== password2) return showAuthError(T('auth_err_passwords_mismatch'));
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span>${  T('profile_saving')}`;
  try {
    await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: resetToken, password }) });
    showAuthError(T('auth_msg_password_updated'), true);
    window.__resetToken = null;
    const url = new URL(window.location.href);
    url.searchParams.delete('reset');
    window.history.replaceState({}, '', url);
    setTimeout(() =>{ switchAuthTab('login', document.querySelector('.auth-tab')); }, 1200);
  } catch(e) {
    showAuthError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = T('auth_save_password_btn');
  }
}

// Human-readable ban notice from the 403 payload the server sends when a
// banned account tries to sign in (see routes/auth/shared.ts bannedResponse).
function banMessage(data) {
  const until = data.bannedUntil ? new Date(data.bannedUntil) : null;
  const permanent = !until || until.getFullYear() > 2500;
  let msg = permanent ? T('auth_banned_forever') : T('auth_banned_until').replace('{date}', until.toLocaleString());
  if (data.reason) msg += ` ${T('auth_ban_reason')}: ${data.reason}`;
  return msg;
}

async function login() {
  const btn = document.getElementById('loginBtn');
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) return showAuthError(T('auth_err_fill_all_fields'));
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span>${  T('auth_logging_in')}`;
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setSession(data);
    // Hand the typed password to the E2EE module (memory only) so
    // ensureE2eeKeypair() can unwrap/re-wrap the server-side key backup —
    // this is what makes the same keypair follow the account onto new
    // devices. See js/e2ee.js.
    e2eeCapturePassword(password);
    afterAuth();
  } catch(e) {
    // Unverified account: the server mailed a fresh verification code and
    // asks us to confirm it before signing in.
    if (e.data && e.data.needsVerification) {
      window.__pendingPassword = password;
      showCodeForm('verify_email', e.data.identifier || email, e.data.email);
      showAuthError(T('auth_verify_needed'), true);
    } else if (e.data && e.data.banned) {
      showAuthError(banMessage(e.data));
    } else {
      showAuthError(e.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = T('auth_login_tab');
  }
}

function generateRegUsername() {
  const input = document.getElementById('regUsername');
  if (!input) return;
  input.value = `Player${  Math.floor(1000 + Math.random() * 9000)}`;
}

async function register() {
  const btn = document.getElementById('registerBtn');
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const country = document.getElementById('regCountry').value;
  if (!email || !password) return showAuthError(T('auth_err_fill_all_fields'));
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span>${  T('auth_creating')}`;
  try {
    const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email, password, country, languages: ['ru'] }) });
    // Registration no longer returns a session: the account must confirm the
    // emailed code first. Remember the password so E2EE can wrap its backup
    // once verification completes (submitCode()).
    if (data.pendingVerification) {
      window.__pendingPassword = password;
      showCodeForm('verify_email', data.identifier || username || email, data.email || email);
      showAuthError(T('auth_verify_needed'), true);
    } else {
      // Backward-compat: if a server still returns a session, use it.
      setSession(data);
      e2eeCapturePassword(password);
      afterAuth();
    }
  } catch(e) {
    showAuthError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = T('auth_create_account_btn');
  }
}

function showAuthError(msg, isSuccess) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.classList.add('show');
  el.classList.toggle('auth-error-success', Boolean(isSuccess));
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  } catch(_) {}
  if (socket) socket.disconnect();
  clearSession();
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('onboardingOverlay').classList.remove('show');
  document.getElementById('mainNav').style.display = 'none';
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('globalChatBubble').style.display = 'none';
  document.getElementById('globalChatPanel').style.display = 'none';
}

// Signs the account out on every device/session (all refresh tokens
// revoked server-side), not just this one. Useful for "log out everywhere" /
// suspected account compromise flows.
async function logoutAllDevices() {
  try { await api('/api/auth/logout-all', { method: 'POST' }); } catch(_) {}
  if (socket) socket.disconnect();
  clearSession();
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('onboardingOverlay').classList.remove('show');
  document.getElementById('mainNav').style.display = 'none';
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('globalChatBubble').style.display = 'none';
  document.getElementById('globalChatPanel').style.display = 'none';
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
// Called right after login/register/checkAuth succeed. New accounts (or ones
// that never finished setup) get routed into the onboarding wizard first;
// everyone else goes straight into the app.
function afterAuth() {
  document.getElementById('authScreen').classList.add('hidden');
  // Fire-and-forget: generates/loads this browser's E2EE keypair and makes
  // sure the server has our current public key on file (see js/e2ee.js).
  // chat-send.js / message-render.js check e2eeReady() themselves before
  // encrypting or decrypting, so this doesn't need to block the UI.
  ensureE2eeKeypair();
  if (!currentUser.onboarding_completed) {
    startOnboarding();
  } else {
    bootApp();
  }
}

function bootApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('onboardingOverlay').classList.remove('show');
  document.getElementById('mainNav').style.display = 'flex';
  document.getElementById('mainApp').style.display = 'flex';
  document.getElementById('globalChatBubble').style.display = 'flex';
  loadGlobalChatHistory();

  // Update sidebar avatar/name
  document.getElementById('sidebarName').textContent = currentUser.username;
  document.getElementById('sidebarAvatar').innerHTML = avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url) + onlineDotHtml();
  updatePresenceUI();

  // Connect socket
  connectSocket();

  // Feature flags gate a couple of nav items (see feature-flags.js) — fetch
  // once per session, not blocking the rest of boot on it.
  loadFeatureFlags();

  // Load friends
  loadFriends();
  if (!friendsPollInterval) friendsPollInterval = setInterval(loadFriends, 15000);

  // Stories strip (own + friends' active stories) and the custom status line.
  if (typeof loadStories === 'function') loadStories();
  if (typeof renderMyStatusText === 'function') renderMyStatusText();
}

async function checkAuth() {
  // Access token may have been cleared (e.g. a previous tab lost the race
  // on a logout) while a still-valid refresh token remains — try to renew
  // before giving up.
  if (!token && refreshToken) {
    const renewed = await refreshSession();
    if (!renewed) { clearSession(); showAuthScreen(); return; }
  }
  if (!token) { showAuthScreen(); return; }

  try {
    // api() itself transparently refreshes on an expired/revoked access
    // token, so a page reload after the 15-minute access-token TTL just
    // works without the user noticing.
    const data = await api('/api/auth/me');
    currentUser = data.user;
    afterAuth();
  } catch(_) {
    clearSession();
    showAuthScreen();
  }
}

// Reveals the login/register screen. Called only once we actually know the
// user isn't authenticated — kept hidden by default in index.html so a
// still-logged-in user never sees a flash of the auth form while checkAuth()
// is in flight (previously it was visible-by-default and only hidden after
// afterAuth() ran, causing a visible flicker on every page load/F5).
function showAuthScreen() {
  const authScreen = document.getElementById('authScreen');
  if (authScreen) authScreen.classList.remove('hidden');
}


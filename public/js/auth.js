// ── AUTH ─────────────────────────────────────────────────────────────────────
function switchAuthTab(tab, btn) {
  document.querySelectorAll('.auth-tab').forEach((b) =>{ b.classList.remove('active') });
  if (btn) btn.classList.add('active');
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('forgotForm').style.display = tab === 'forgot' ? 'block' : 'none';
  document.getElementById('resetForm').style.display = tab === 'reset' ? 'block' : 'none';
  const tabsRow = document.querySelector('.auth-tabs');
  if (tabsRow) tabsRow.style.display = (tab === 'login' || tab === 'register') ? 'flex' : 'none';
  document.getElementById('authError').classList.remove('show');
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
    afterAuth();
  } catch(e) {
    showAuthError(e.message);
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
    setSession(data);
    afterAuth();
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
  if (!currentUser.onboarding_completed) {
    startOnboarding();
  } else {
    bootApp();
  }
}

async function bootApp() {
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


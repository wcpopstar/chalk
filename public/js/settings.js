// ── SETTINGS HUB ─────────────────────────────────────────────────────────────
// The old "Профиль" page is now a settings hub with sections: Профиль, Анкета,
// Безопасность, Устройства, Звук. This file drives section switching and the
// Анкета / Безопасность / Устройства sections; sound-settings.js owns Звук.

// Game catalog (id → emoji + name). Shared with discover-swipe.js so the game
// icons on a discovery card match the анкета editor. Kept here (not fetched)
// because the same fixed list already lives in the onboarding/edit chips.
var GAME_CATALOG = [
  { id: 'valorant', emoji: '🎯', name: 'Valorant' },
  { id: 'cs2', emoji: '💥', name: 'CS2' },
  { id: 'apex', emoji: '🏆', name: 'Apex Legends' },
  { id: 'lol', emoji: '⚔️', name: 'League of Legends' },
  { id: 'fortnite', emoji: '🏗️', name: 'Fortnite' },
  { id: 'dota2', emoji: '🛡️', name: 'Dota 2' },
  { id: 'overwatch', emoji: '🦸', name: 'Overwatch 2' },
  { id: 'pubg', emoji: '🪖', name: 'PUBG' },
  { id: 'minecraft', emoji: '🧱', name: 'Minecraft' },
  { id: 'genshin', emoji: '⚡', name: 'Genshin Impact' },
  { id: 'roblox', emoji: '🟩', name: 'Roblox' },
  { id: 'gta5', emoji: '🚗', name: 'GTA V' },
  { id: 'amongus', emoji: '🚀', name: 'Among Us' },
  { id: 'r6siege', emoji: '🌈', name: 'Rainbow Six Siege' },
  { id: 'wow', emoji: '🐉', name: 'World of Warcraft' },
  { id: 'mlbb', emoji: '🔥', name: 'Mobile Legends' },
  { id: 'chat', emoji: '💬', name: 'Общение' },
];
window.GAME_CATALOG = GAME_CATALOG;
function gameById(id) { return GAME_CATALOG.find((g) => g.id === id) || { id, emoji: '🎮', name: id }; }
window.gameById = gameById;

function showSettingsSection(sect, btn) {
  document.querySelectorAll('.settings-section').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
  const el = document.getElementById(`settings-${sect}`);
  if (el) el.classList.add('active');
  if (btn) btn.classList.add('active');

  if (sect === 'card') loadCardSection();
  if (sect === 'security') loadSecuritySection();
}
window.showSettingsSection = showSettingsSection;

// ── АНКЕТА (discovery card) ──────────────────────────────────────────────────
var cardData = { avatar_url: null };
var cardGames = []; // [{ game_id, rank, wins }]

async function loadCardSection() {
  if (!currentUser) return;
  cardData = { avatar_url: currentUser.avatar_url || null };
  document.getElementById('cardAvatarPreview').innerHTML = avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url);
  document.getElementById('cardBio').value = currentUser.bio || '';
  document.getElementById('cardBioCount').textContent = `${(currentUser.bio || '').length}/200`;
  const gl = currentUser.gaming_links || {};
  ['Steam', 'Psn', 'Xbox', 'Valorant', 'Faceit', 'Twitch'].forEach((k) => {
    const input = document.getElementById(`cardLink${k}`);
    if (input) input.value = gl[k.toLowerCase()] || '';
  });
  document.getElementById('cardError').classList.remove('show');

  // Build the "add game" dropdown once.
  const sel = document.getElementById('cardAddGameSelect');
  if (sel && sel.options.length <= 1) {
    GAME_CATALOG.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id; o.textContent = `${g.emoji} ${g.name}`;
      sel.appendChild(o);
    });
  }

  // Load current per-game rank/wins.
  cardGames = [];
  try {
    const data = await api(`/api/users/${currentUser.id}`);
    cardGames = (data.user.user_games || []).map((g) => ({
      game_id: g.game_id || (g.games && g.games.id),
      rank: g.rank || '',
      wins: g.wins || 0,
    })).filter((g) => g.game_id);
  } catch (_) {}
  renderCardGames();
}
window.loadCardSection = loadCardSection;

function renderCardGames() {
  const list = document.getElementById('cardGamesList');
  if (!list) return;
  if (!cardGames.length) {
    list.innerHTML = `<div class="section-sub" style="padding:6px 0">${T('settings_card_no_games', 'Игры не добавлены')}</div>`;
    return;
  }
  list.innerHTML = cardGames.map((g, i) => {
    const info = gameById(g.game_id);
    return `<div class="card-game-row">
      <div class="card-game-head"><span class="card-game-emoji">${info.emoji}</span><span class="card-game-name">${escHtml(info.name)}</span>
        <button class="card-game-del" title="Убрать" onclick="cardRemoveGame(${i})">✕</button></div>
      <div class="card-game-fields">
        <label>${T('settings_card_rank', 'Ранг')}<input class="auth-input" type="text" maxlength="50" value="${escHtml(g.rank)}" placeholder="напр. Immortal 2" oninput="cardUpdateGame(${i},'rank',this.value)"></label>
        <label>${T('settings_card_wins', 'Побед')}<input class="auth-input" type="number" min="0" max="1000000" value="${g.wins}" oninput="cardUpdateGame(${i},'wins',this.value)"></label>
      </div>
    </div>`;
  }).join('');
}

function cardUpdateGame(i, field, value) {
  if (!cardGames[i]) return;
  cardGames[i][field] = field === 'wins' ? Math.max(0, parseInt(value, 10) || 0) : value;
}
window.cardUpdateGame = cardUpdateGame;

function cardRemoveGame(i) { cardGames.splice(i, 1); renderCardGames(); }
window.cardRemoveGame = cardRemoveGame;

function cardAddGame() {
  const sel = document.getElementById('cardAddGameSelect');
  const id = sel.value;
  if (!id) return;
  if (cardGames.some((g) => g.game_id === id)) { showToast(T('settings_card_game_exists', 'Игра уже добавлена')); return; }
  cardGames.push({ game_id: id, rank: '', wins: 0 });
  sel.value = '';
  renderCardGames();
}
window.cardAddGame = cardAddGame;

async function saveCard() {
  const btn = document.getElementById('cardSaveBtn');
  const bio = document.getElementById('cardBio').value.trim();
  btn.disabled = true;
  try {
    const gamingLinks = {};
    ['steam', 'psn', 'xbox', 'valorant', 'faceit', 'twitch'].forEach((k) => {
      const input = document.getElementById(`cardLink${k.charAt(0).toUpperCase()}${k.slice(1)}`);
      gamingLinks[k] = input ? input.value.trim() : '';
    });
    const profileUpdate = { bio, gaming_links: gamingLinks };
    if (cardData.avatar_url) profileUpdate.avatar_url = cardData.avatar_url;

    const data = await api('/api/users/me', { method: 'PATCH', body: JSON.stringify(profileUpdate) });
    await api('/api/users/me/games', {
      method: 'PUT',
      body: JSON.stringify({ games: cardGames.map((g) => ({ game_id: g.game_id, rank: g.rank || null, wins: g.wins || 0 })) }),
    });
    currentUser = Object.assign({}, currentUser, data.user);
    // Reflect avatar changes in the sidebar.
    const sb = document.getElementById('sidebarAvatar');
    if (sb) { sb.innerHTML = avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url); if (typeof updateSidebarStoryUI === 'function') updateSidebarStoryUI(); }
    showToast(`${T('profile_updated', 'Анкета обновлена')} ✓`);
    if (typeof loadProfile === 'function') loadProfile();
  } catch (e) {
    const el = document.getElementById('cardError');
    el.textContent = e.message; el.classList.add('show');
  } finally {
    btn.disabled = false;
  }
}
window.saveCard = saveCard;

// ── БЕЗОПАСНОСТЬ ──────────────────────────────────────────────────────────────
function loadSecuritySection() {
  // 2FA state
  const enabled = Boolean(currentUser && currentUser.twofa_email_enabled);
  const toggle = document.getElementById('twofaToggle');
  const status = document.getElementById('twofaStatus');
  if (toggle) toggle.checked = enabled;
  if (status) status.textContent = enabled ? T('settings_2fa_on_label', 'Включена') : T('settings_2fa_off_label', 'Выключена');
  const codeWrap = document.getElementById('twofaCodeWrap');
  if (codeWrap) codeWrap.style.display = 'none';

  // Privacy (missing key = default visible = checked)
  const p = (currentUser && currentUser.privacy) || {};
  const set = (id, key) => { const el = document.getElementById(id); if (el) el.checked = p[key] !== false; };
  set('privDiscoverable', 'discoverable');
  set('privShowAge', 'show_age');
  set('privShowCountry', 'show_country');
  set('privShowOnline', 'show_online');

  if (typeof loadPasskeys === 'function') loadPasskeys();
}
window.loadSecuritySection = loadSecuritySection;

async function changePassword() {
  const cur = document.getElementById('secCurrentPw').value;
  const nw = document.getElementById('secNewPw').value;
  const nw2 = document.getElementById('secNewPw2').value;
  const err = document.getElementById('secPwError');
  err.classList.remove('show');
  if (!cur || !nw) { err.textContent = T('auth_err_fill_all_fields', 'Заполни все поля'); err.classList.add('show'); return; }
  if (nw.length < 6) { err.textContent = T('auth_err_password_min6', 'Пароль минимум 6 символов'); err.classList.add('show'); return; }
  if (nw !== nw2) { err.textContent = T('auth_err_passwords_mismatch', 'Пароли не совпадают'); err.classList.add('show'); return; }

  const btn = document.getElementById('secPwBtn');
  btn.disabled = true;
  try {
    const data = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
    // Server rotated all sessions and issued a fresh pair for this device.
    if (data.token) setSession(data);
    document.getElementById('secCurrentPw').value = '';
    document.getElementById('secNewPw').value = '';
    document.getElementById('secNewPw2').value = '';
    showToast(`${T('settings_pw_changed', 'Пароль изменён')} ✓`);
    if (typeof e2eeCapturePassword === 'function') e2eeCapturePassword(nw);
  } catch (e) {
    err.textContent = e.message; err.classList.add('show');
  } finally {
    btn.disabled = false;
  }
}
window.changePassword = changePassword;

// 2FA enable/disable both require a mailed code confirmation.
var twofaPendingEnable = false;
async function onTwofaToggle(el) {
  twofaPendingEnable = el.checked;
  const err = document.getElementById('twofaError');
  if (err) err.classList.remove('show');
  try {
    await api('/api/auth/2fa/request', { method: 'POST' });
    document.getElementById('twofaCodeWrap').style.display = 'block';
    document.getElementById('twofaCode').value = '';
    document.getElementById('twofaCode').focus();
    showToast(T('settings_2fa_code_sent', 'Код отправлен на почту'));
  } catch (e) {
    // Revert the toggle — the request failed.
    el.checked = !twofaPendingEnable;
    showToast(`${T('err_generic', 'Ошибка')} ${e.message}`);
  }
}
window.onTwofaToggle = onTwofaToggle;

async function confirmTwofa() {
  const code = (document.getElementById('twofaCode').value || '').trim();
  const err = document.getElementById('twofaError');
  err.classList.remove('show');
  if (!/^\d{6}$/.test(code)) { err.textContent = T('auth_err_code_6digits', 'Код — 6 цифр'); err.classList.add('show'); return; }
  const endpoint = twofaPendingEnable ? '/api/auth/2fa/enable' : '/api/auth/2fa/disable';
  const btn = document.getElementById('twofaConfirmBtn');
  btn.disabled = true;
  try {
    const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ code }) });
    currentUser.twofa_email_enabled = Boolean(data.twofa_email_enabled);
    document.getElementById('twofaCodeWrap').style.display = 'none';
    loadSecuritySection();
    showToast(currentUser.twofa_email_enabled ? T('settings_2fa_enabled', '2FA включена ✓') : T('settings_2fa_disabled', '2FA выключена'));
  } catch (e) {
    err.textContent = e.message; err.classList.add('show');
  } finally {
    btn.disabled = false;
  }
}
window.confirmTwofa = confirmTwofa;

async function savePrivacy() {
  const privacy = {
    discoverable: document.getElementById('privDiscoverable').checked,
    show_age: document.getElementById('privShowAge').checked,
    show_country: document.getElementById('privShowCountry').checked,
    show_online: document.getElementById('privShowOnline').checked,
  };
  try {
    const data = await api('/api/users/me', { method: 'PATCH', body: JSON.stringify({ privacy }) });
    currentUser = Object.assign({}, currentUser, data.user);
    showToast(`${T('settings_privacy_saved', 'Приватность сохранена')} ✓`);
  } catch (e) {
    showToast(`${T('err_generic', 'Ошибка')} ${e.message}`);
  }
}
window.savePrivacy = savePrivacy;

// ── УСТРОЙСТВА ────────────────────────────────────────────────────────────────
function deviceInfoFromUA(ua) {
  ua = ua || '';
  let os = `💻 ${  T('device_unknown', 'Неизвестное устройство')}`;
  if (/Windows/i.test(ua)) os = '🪟 Windows';
  else if (/Android/i.test(ua)) os = '🤖 Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) os = '📱 iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = '🍎 macOS';
  else if (/Linux/i.test(ua)) os = '🐧 Linux';
  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  return browser ? `${os} · ${browser}` : os;
}

// fmtDateTime() moved to public/web/utils/format.js (bridged onto window).

async function loadDevicesSection() {
  const list = document.getElementById('devicesList');
  const hist = document.getElementById('loginHistoryList');
  if (list) list.innerHTML = `<div class="section-sub">${T('status_loading', 'Загрузка...')}</div>`;
  if (hist) hist.innerHTML = `<div class="section-sub">${T('status_loading', 'Загрузка...')}</div>`;

  try {
    const data = await api('/api/auth/sessions', { method: 'POST', body: JSON.stringify({ refreshToken }) });
    const sessions = data.sessions || [];
    if (!sessions.length) {
      list.innerHTML = `<div class="section-sub">${T('settings_no_sessions', 'Нет активных сессий')}</div>`;
    } else {
      list.innerHTML = sessions.map((s) => {
        const cur = s.current ? `<span class="device-current" data-i18n="settings_this_device">это устройство</span>` : '';
        const revoke = s.current ? '' : `<button class="device-revoke" onclick="revokeSession('${s.id}')" data-i18n="settings_revoke">Выйти</button>`;
        return `<div class="device-row">
          <div class="device-info">
            <div class="device-name">${escHtml(deviceInfoFromUA(s.user_agent))} ${cur}</div>
            <div class="device-meta">${s.ip ? `${escHtml(s.ip)  } · ` : ''}${T('settings_last_active', 'активно')}: ${fmtDateTime(s.last_active)}</div>
          </div>${revoke}
        </div>`;
      }).join('');
    }
  } catch (e) {
    if (list) list.innerHTML = `<div class="section-sub">${T('profile_err_load', 'Не удалось загрузить')}</div>`;
  }

  try {
    const data = await api('/api/auth/login-history');
    const events = data.events || [];
    if (!events.length) {
      hist.innerHTML = `<div class="section-sub">${T('settings_no_history', 'Пока нет записей')}</div>`;
    } else {
      const methodLabel = (m) => ({ password: `🔑 ${  T('settings_method_password', 'Пароль')}`, code: `📧 ${  T('settings_method_code', 'Код')}`, passkey: '🔐 Passkey', '2fa': '📧 2FA' }[m] || m);
      hist.innerHTML = events.map((ev) => {
        const ok = ev.success ? '<span class="login-ok">✓</span>' : '<span class="login-fail">✕</span>';
        return `<div class="login-row">
          <div class="login-main">${ok} <span class="login-method">${methodLabel(ev.method)}</span></div>
          <div class="device-meta">${escHtml(deviceInfoFromUA(ev.user_agent))}${ev.ip ? ` · ${  escHtml(ev.ip)}` : ''} · ${fmtDateTime(ev.created_at)}</div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    if (hist) hist.innerHTML = `<div class="section-sub">${T('profile_err_load', 'Не удалось загрузить')}</div>`;
  }
}
window.loadDevicesSection = loadDevicesSection;

async function revokeSession(sessionId) {
  try {
    await api('/api/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId }) });
    showToast(`${T('settings_session_ended', 'Сессия завершена')} ✓`);
    loadDevicesSection();
  } catch (e) {
    showToast(`${T('err_generic', 'Ошибка')} ${e.message}`);
  }
}
window.revokeSession = revokeSession;

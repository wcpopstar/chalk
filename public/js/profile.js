// ── PROFILE PERSONALIZATION HELPERS ─────────────────────────────────────────
// GENDER_LABELS + genderLabel + LANG_LABELS + langLabel moved to
// public/web/utils/labels.js (bridged onto window).
// (GAME_LABELS removed here — it was dead code, referenced nowhere.)

// avatarHtml() moved to public/web/utils/dom.js (bridged onto window).

// participantDisplayName() + participantAvatarHtml() + getParticipantId() moved
// to public/web/utils/participant.js (bridged onto window).

function participantIsAlreadyFriend(p) {
  const pid = getParticipantId(p);
  return Boolean(pid && currentFriendIds.has(String(pid)));
}

// genderLabel() moved to public/web/utils/labels.js (bridged onto window).

// ── THEME (light / dark) ────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.classList.toggle('light-theme', theme === 'light');
  const icon = theme === 'light' ? '🌙' : '☀️';
  const label = theme === 'light' ? `🌙 ${  T('theme_dark')}` : `☀️ ${  T('theme_light')}`;
  const authBtn    = document.getElementById('authThemeToggle');
  const navBtn     = document.getElementById('navThemeToggle');
  const profileBtn = document.getElementById('profileThemeToggle');
  if (authBtn) authBtn.textContent = icon;
  if (navBtn)  navBtn.textContent  = icon;
  if (profileBtn) profileBtn.textContent = label;
  try { localStorage.setItem('chalk_theme', theme); } catch (_) {}
}

function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light-theme');
  applyTheme(isLight ? 'dark' : 'light');
}

// Sync toggle button icons with whatever theme was applied on page load
applyTheme(document.documentElement.classList.contains('light-theme') ? 'light' : 'dark');

// ── PRESENCE STATUS (online / away / busy) ─────────────────────────────────
function PRESENCE_LABELS() { return { online: T('status_online'), away: T('call_away'), busy: T('call_busy') }; }

function updatePresenceUI() {
  const p = (currentUser && currentUser.presence) || 'online';
  const label = document.getElementById('statusLabel');
  if (label) { const __pl = PRESENCE_LABELS(); label.textContent = __pl[p] || __pl.online; }
}

function toggleStatusMenu(event) {
  event.stopPropagation();
  document.getElementById('statusMenu').classList.toggle('show');
}

document.addEventListener('click', () => {
  const menu = document.getElementById('statusMenu');
  if (menu) menu.classList.remove('show');
});

// ── CUSTOM STATUS TEXT (free-text "го играть" line under the name) ──────────
function renderMyStatusText() {
  const el = document.getElementById('sidebarStatusText');
  if (!el) return;
  const txt = currentUser && currentUser.status_text;
  if (txt) { el.textContent = `💬 ${  txt}`; el.classList.remove('empty'); }
  else { el.textContent = T('status_text_set', '+ статус'); el.classList.add('empty'); }
}

function editMyStatusText() {
  const disp = document.getElementById('sidebarStatusText');
  const edit = document.getElementById('sidebarStatusEdit');
  const input = document.getElementById('sidebarStatusInput');
  if (!disp || !edit || !input) return;
  input.value = (currentUser && currentUser.status_text) || '';
  disp.style.display = 'none';
  edit.style.display = 'flex';
  input.focus();
}

function statusTextKeydown(event) {
  if (event.key === 'Enter') { event.preventDefault(); saveMyStatusText(); }
  else if (event.key === 'Escape') { cancelStatusTextEdit(); }
}

function cancelStatusTextEdit() {
  const disp = document.getElementById('sidebarStatusText');
  const edit = document.getElementById('sidebarStatusEdit');
  if (edit) edit.style.display = 'none';
  if (disp) disp.style.display = '';
}

async function saveMyStatusText() {
  const input = document.getElementById('sidebarStatusInput');
  if (!input || !currentUser) return;
  const value = input.value.trim();
  const payload = value ? value : null; // empty clears it
  try {
    const data = await api('/api/users/me', { method: 'PATCH', body: JSON.stringify({ status_text: payload }) });
    currentUser = Object.assign({}, currentUser, data.user);
  } catch (e) {
    showToast(`${T('err_generic', 'Ошибка')  } ${  e.message}`);
  }
  cancelStatusTextEdit();
  renderMyStatusText();
}

function setMyPresence(p) {
  if (!currentUser) return;
  currentUser.presence = p;
  updatePresenceUI();
  document.getElementById('statusMenu').classList.remove('show');
  if (socket && socket.connected) {
    socket.emit('presence:set', { presence: p });
  } else {
    api('/api/users/me', { method: 'PATCH', body: JSON.stringify({ presence: p }) }).catch(() =>{});
  }
}

// Resizes/crops an uploaded image client-side and turns it into a small
// JPEG data URL so it can be stored directly as avatar_url.
// GIFs are the one exception: canvas would flatten them to a single frame,
// so animated GIFs are embedded as-is (still capped in size) to keep the animation.
function handleAvatarFile(event, previewElId) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { showToast(T('profile_choose_image_file')); return; }
  if (file.size > 8 * 1024 * 1024) { showToast(`${T('profile_file_too_large')  } (${  T('unit_max_dot')  } 8 ${  T('unit_mb')  })`); return; }

  if (file.type === 'image/gif') {
    // Base64 inflates size ~33%, and the server caps avatar_url at 1.5M chars —
    // so keep raw GIFs comfortably under that after encoding.
    if (file.size > 1 * 1024 * 1024) {
      showToast('GIF слишком большой для аватарки (макс. 1 МБ)');
      return;
    }
    const gifReader = new FileReader();
    gifReader.onload = function() {
      const dataUrl = gifReader.result;
      const preview = document.getElementById(previewElId);
      preview.innerHTML = `<img src="${  dataUrl  }" alt="">`;
      if (previewElId === 'obAvatarPreview') obData.avatar_url = dataUrl;
      if (previewElId === 'epAvatarPreview') epData.avatar_url = dataUrl;
    };
    gifReader.readAsDataURL(file);
    return;
  }

  const reader = new FileReader();
  reader.onload = function() {
    const img = new Image();
    img.onload = function() {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2; const sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const preview = document.getElementById(previewElId);
      preview.innerHTML = `<img src="${  dataUrl  }" alt="">`;
      if (previewElId === 'obAvatarPreview') obData.avatar_url = dataUrl;
      if (previewElId === 'epAvatarPreview') epData.avatar_url = dataUrl;
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Generic single/multi-select chip toggler shared by onboarding + edit modal
function selectChip(el, groupId, singleSelect) {
  const group = document.getElementById(groupId);
  if (singleSelect) {
    group.querySelectorAll('.chip').forEach((c) =>{ c.classList.remove('selected') });
    el.classList.add('selected');
  } else {
    el.classList.toggle('selected');
  }
}

function getSelectedChipValues(groupId) {
  const group = document.getElementById(groupId);
  return Array.prototype.map.call(group.querySelectorAll('.chip.selected'), (c) =>c.dataset.value);
}

function setSelectedChipValues(groupId, values) {
  values = values || [];
  document.getElementById(groupId).querySelectorAll('.chip').forEach((c) =>{
    c.classList.toggle('selected', values.indexOf(c.dataset.value) !== -1);
  });
}

// ── ONBOARDING WIZARD ───────────────────────────────────────────────────────
var obStep = 1;
var obData = { avatar_url: null };

function startOnboarding() {
  obStep = 1;
  obData = { avatar_url: null };
  document.getElementById('obNickname').value = currentUser.username || '';
  document.getElementById('obAge').value = '';
  document.getElementById('obAvatarPreview').innerHTML = avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url);
  setSelectedChipValues('obGenderChips', []);
  setSelectedChipValues('obLangChips', ['ru']);
  setSelectedChipValues('obGameChips', []);
  document.getElementById('obError').classList.remove('show');
  renderObStep();
  document.getElementById('onboardingOverlay').classList.add('show');
}

function renderObStep() {
  document.querySelectorAll('.ob-step').forEach((s) =>{ s.classList.remove('active') });
  document.getElementById(`obStep${  obStep}`).classList.add('active');
  document.querySelectorAll('.ob-dot').forEach((d) =>{
    const n = parseInt(d.dataset.step, 10);
    d.classList.toggle('active', n === obStep);
    d.classList.toggle('done', n < obStep);
  });
  document.getElementById('obStepNum').textContent = obStep;
  document.getElementById('obBackBtn').style.display = obStep > 1 ? 'block' : 'none';
  document.getElementById('obNextBtn').textContent = obStep < 4 ? T('btn_next') : T('btn_done');
  document.getElementById('obError').classList.remove('show');
}

function obShowError(msg) {
  const el = document.getElementById('obError');
  el.textContent = msg;
  el.classList.add('show');
}

function obBack() {
  if (obStep > 1) { obStep--; renderObStep(); }
}

async function obNext() {
  if (obStep === 1) {
    const nickname = document.getElementById('obNickname').value.trim();
    if (nickname.length < 3) return obShowError(T('auth_err_nickname_min3'));
    obData.username = nickname;
    obStep = 2; renderObStep(); return;
  }
  if (obStep === 2) {
    const age = parseInt(document.getElementById('obAge').value, 10);
    const gender = getSelectedChipValues('obGenderChips')[0];
    if (!age || age < 13 || age > 100) return obShowError(`${T('ob_err_specify_real_age')  } (13\u201300)`);
    if (!gender) return obShowError(T('err_choose_gender'));
    obData.age = age; obData.gender = gender;
    obStep = 3; renderObStep(); return;
  }
  if (obStep === 3) {
    const langs = getSelectedChipValues('obLangChips');
    if (!langs.length) return obShowError(T('ob_choose_at_least_one_lang'));
    obData.languages = langs;
    obStep = 4; renderObStep(); return;
  }
  if (obStep === 4) {
    obData.games = getSelectedChipValues('obGameChips').map((id) =>({ game_id: id }));
    await finishOnboarding();
  }
}

async function obSkip() {
  // Still requires the bare minimum (age + gender + language) so matching
  // makes sense, but lets the player jump straight past games/avatar.
  if (obStep < 2) { obStep = 2; renderObStep(); return; }
  if (obStep === 2) {
    const age = parseInt(document.getElementById('obAge').value, 10);
    const gender = getSelectedChipValues('obGenderChips')[0];
    if (!age || age < 13 || age > 100 || !gender) return obShowError(T('ob_err_age_gender_required'));
    obData.age = age; obData.gender = gender;
  }
  if (!obData.languages) obData.languages = getSelectedChipValues('obLangChips').length ? getSelectedChipValues('obLangChips') : ['ru'];
  obData.games = getSelectedChipValues('obGameChips').map((id) =>({ game_id: id }));
  await finishOnboarding();
}

async function finishOnboarding() {
  const btn = document.getElementById('obNextBtn');
  btn.disabled = true;
  try {
    const data = await api('/api/users/me/onboarding', { method: 'POST', body: JSON.stringify(obData) });
    currentUser = Object.assign({}, currentUser, data.user);
    bootApp();
    showToast(`${T('profile_ready')  } \ud83c\udf89`);
  } catch(e) {
    obShowError(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ── EDIT PROFILE MODAL ───────────────────────────────────────────────────────
var epData = { avatar_url: null };

// Gaming platform handles → external profile links. Shared by the edit modal
// (inputs) and the public-profile popup (buttons, see misc.js). The URL is
// always built client-side from the stored handle — handles are validated
// server-side to never contain URL/HTML metacharacters.
var GAMING_LINK_PLATFORMS = [
  { key: 'steam',    inputId: 'epLinkSteam',    label: 'Steam',    ico: '🎮' },
  { key: 'psn',      inputId: 'epLinkPsn',      label: 'PSN',      ico: '🕹️' },
  { key: 'xbox',     inputId: 'epLinkXbox',     label: 'Xbox',     ico: '❎' },
  { key: 'valorant', inputId: 'epLinkValorant', label: 'Valorant', ico: '🎯' },
  { key: 'faceit',   inputId: 'epLinkFaceit',   label: 'FACEIT',   ico: '🟧' },
  { key: 'twitch',   inputId: 'epLinkTwitch',   label: 'Twitch',   ico: '📺' },
];

// gamingLinkUrl() moved to public/web/utils/links.js (bridged onto window).

async function openEditProfile() {
  epData = { avatar_url: currentUser.avatar_url || null };
  document.getElementById('epNickname').value = currentUser.username || '';
  document.getElementById('epBio').value = currentUser.bio || '';
  document.getElementById('epBioCount').textContent = `${(currentUser.bio || '').length  }/200`;
  document.getElementById('epAge').value = currentUser.age || '';
  document.getElementById('epAvatarPreview').innerHTML = avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url);
  setSelectedChipValues('epGenderChips', currentUser.gender ? [currentUser.gender] : []);
  setSelectedChipValues('epLangChips', currentUser.languages || ['ru']);
  const gl = currentUser.gaming_links || {};
  GAMING_LINK_PLATFORMS.forEach((p) => {
    const input = document.getElementById(p.inputId);
    if (input) input.value = gl[p.key] || '';
  });
  document.getElementById('epError').classList.remove('show');

  // Pre-fill currently selected games
  try {
    const data = await api(`/api/users/${  currentUser.id}`);
    const gameIds = (data.user.user_games || []).map((g) =>g.game_id);
    setSelectedChipValues('epGameChips', gameIds);
  } catch(_) {
    setSelectedChipValues('epGameChips', []);
  }

  document.getElementById('editProfileOverlay').classList.add('show');
}

function closeEditProfile() {
  document.getElementById('editProfileOverlay').classList.remove('show');
}

async function saveEditProfile() {
  const nickname = document.getElementById('epNickname').value.trim();
  const bio = document.getElementById('epBio').value.trim();
  const age = parseInt(document.getElementById('epAge').value, 10);
  const gender = getSelectedChipValues('epGenderChips')[0];
  const langs = getSelectedChipValues('epLangChips');
  const gameIds = getSelectedChipValues('epGameChips');

  if (nickname.length < 3) return epShowError(T('auth_err_nickname_min3'));
  if (!age || age < 13 || age > 100) return epShowError(`${T('ob_err_specify_real_age')  } (13\u201300)`);
  if (!gender) return epShowError(T('err_choose_gender'));
  if (!langs.length) return epShowError(T('ob_choose_at_least_one_lang'));

  const btn = document.getElementById('epSaveBtn');
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span>${  T('profile_saving')}`;
  try {
    const profileUpdate = { username: nickname, age, gender, languages: langs, bio };
    if (epData.avatar_url) profileUpdate.avatar_url = epData.avatar_url;
    profileUpdate.gaming_links = {};
    GAMING_LINK_PLATFORMS.forEach((p) => {
      const input = document.getElementById(p.inputId);
      profileUpdate.gaming_links[p.key] = input ? input.value.trim() : '';
    });

    const data = await api('/api/users/me', { method: 'PATCH', body: JSON.stringify(profileUpdate) });
    await api('/api/users/me/games', { method: 'PUT', body: JSON.stringify({ games: gameIds.map((id) =>({ game_id: id })) }) });

    currentUser = Object.assign({}, currentUser, data.user);
    closeEditProfile();
    document.getElementById('sidebarAvatar').innerHTML = avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url);
    // Re-attach the story ＋ badge / ring the innerHTML reset just dropped.
    if (typeof updateSidebarStoryUI === 'function') updateSidebarStoryUI();
    document.getElementById('sidebarName').textContent = currentUser.username;
    loadProfile();
    showToast(`${T('profile_updated')  } \u2713`);
  } catch(e) {
    epShowError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = T('profile_save');
  }
}

function epShowError(msg) {
  const el = document.getElementById('epError');
  el.textContent = msg;
  el.classList.add('show');
}


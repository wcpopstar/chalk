// ── SERVER SETTINGS MODAL (roles / members / channels / overview) ────────────
// Drives the ⚙️ panel opened from the channel sidebar. Everything here is gated
// on the caller's effective permissions (sHasPerm from servers.js), but the
// backend re-checks every write — this only hides dead-end controls. All server
// mutations reload the open server (openServer) so the sidebar stays in sync.

// Permission rows shown as checkboxes when editing a role. Order/labels only —
// the bit values come from SPERM in servers.js (single source of truth).
var SPERM_ROWS = [
  ['VIEW', 'Видеть каналы'],
  ['SEND', 'Писать сообщения'],
  ['CONNECT_VOICE', 'Заходить в голосовые каналы'],
  ['MANAGE_MESSAGES', 'Управлять сообщениями'],
  ['MANAGE_CHANNELS', 'Управлять каналами'],
  ['MANAGE_ROLES', 'Управлять ролями'],
  ['KICK', 'Кикать участников'],
  ['BAN', 'Банить участников'],
  ['MANAGE_SERVER', 'Изменять сервер'],
  ['CREATE_INVITE', 'Создавать приглашения'],
  ['ADMIN', 'Администратор (все права)'],
];

var svsMembersCache = [];

function svsApi(path, opts) { return api(`/api/servers/${currentServer.server.id}${path}`, opts); }

// Which management permissions the caller has — used to decide which tabs and
// controls to show. The owner and ADMIN implicitly have all of them.
function svsCanAny() {
  return currentServer && (currentServer.isOwner
    || sHasPerm(SPERM.MANAGE_SERVER) || sHasPerm(SPERM.MANAGE_ROLES)
    || sHasPerm(SPERM.MANAGE_CHANNELS) || sHasPerm(SPERM.KICK) || sHasPerm(SPERM.BAN));
}

function openServerSettings() {
  if (!currentServer || !svsCanAny()) return;
  const overlay = document.getElementById('serverSettingsOverlay');
  if (!overlay) return;
  document.getElementById('svsTitle').textContent = `${_svT('server_settings', 'Настройки сервера')} — ${currentServer.server.name}`;
  // Hide tabs the caller can't use.
  const tabPerm = { overview: currentServer.isOwner || sHasPerm(SPERM.MANAGE_SERVER),
    roles: sHasPerm(SPERM.MANAGE_ROLES),
    members: currentServer.isOwner || sHasPerm(SPERM.MANAGE_ROLES) || sHasPerm(SPERM.KICK) || sHasPerm(SPERM.BAN),
    channels: sHasPerm(SPERM.MANAGE_CHANNELS) };
  let firstVisible = null;
  document.querySelectorAll('#svsTabs .svs-tab').forEach((btn) => {
    const key = btn.getAttribute('data-svs');
    const ok = tabPerm[key];
    btn.style.display = ok ? '' : 'none';
    if (ok && !firstVisible) firstVisible = btn;
  });
  overlay.classList.add('show');
  if (firstVisible) svsShowTab(firstVisible.getAttribute('data-svs'), firstVisible);
}

function closeServerSettings() {
  const overlay = document.getElementById('serverSettingsOverlay');
  if (overlay) overlay.classList.remove('show');
}

function svsShowTab(tab, btn) {
  document.querySelectorAll('#svsTabs .svs-tab').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  ['overview', 'roles', 'members', 'channels'].forEach((t) => {
    const pane = document.getElementById(`svsPane-${t}`);
    if (pane) pane.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'overview') renderSvsOverview();
  else if (tab === 'roles') renderSvsRoles();
  else if (tab === 'members') renderSvsMembers();
  else if (tab === 'channels') renderSvsChannels();
}

/* ---------------- OVERVIEW ---------------- */

function renderSvsOverview() {
  const pane = document.getElementById('svsPane-overview');
  const s = currentServer.server;
  pane.innerHTML = `
    <label class="svs-field-label">${_svT('server_name', 'Название сервера')}</label>
    <input class="svs-input" id="svsServerName" maxlength="60" value="${escHtml(s.name)}">
    <label class="svs-field-label">${_svT('server_icon', 'Эмодзи-иконка')}</label>
    <input class="svs-input" id="svsServerIcon" maxlength="8" value="${escHtml(s.icon_emoji || '')}">
    <div class="svs-row-actions">
      <button class="modal-save" onclick="svsSaveOverview()">${_svT('profile_save', 'Сохранить')}</button>
    </div>
    ${currentServer.isOwner ? `<div class="svs-danger">
      <div class="svs-danger-title">${_svT('server_danger_zone', 'Опасная зона')}</div>
      <button class="svs-danger-btn" onclick="svsDeleteServer()">${_svT('server_delete', 'Удалить сервер')}</button>
    </div>` : ''}`;
}

async function svsSaveOverview() {
  const name = document.getElementById('svsServerName').value.trim();
  const iconEmoji = document.getElementById('svsServerIcon').value.trim();
  try {
    await svsApi('', { method: 'PATCH', body: JSON.stringify({ name, iconEmoji }) });
    await loadServers();
    document.getElementById('channelServerName').textContent = name;
    document.getElementById('svsTitle').textContent = `${_svT('server_settings', 'Настройки сервера')} — ${name}`;
    _svToast(_svT('server_saved', 'Сохранено'));
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

async function svsDeleteServer() {
  if (!confirm(_svT('server_delete_confirm', 'Удалить сервер навсегда? Это действие необратимо.'))) return;
  try {
    await svsApi('', { method: 'DELETE' });
    closeServerSettings();
    currentServer = null; currentChannel = null;
    document.getElementById('channelSidebar').style.display = 'none';
    document.getElementById('channelView').style.display = 'none';
    const vv = document.getElementById('channelVoice'); if (vv) vv.style.display = 'none';
    document.getElementById('serversEmpty').style.display = 'flex';
    await loadServers();
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

/* ---------------- ROLES ---------------- */

function roleMaskFromCheckboxes(roleId) {
  let mask = 0;
  SPERM_ROWS.forEach(([name]) => {
    const cb = document.getElementById(`svsPerm-${roleId}-${name}`);
    if (cb && cb.checked) mask |= SPERM[name];
  });
  return mask;
}

function renderSvsRoles() {
  const pane = document.getElementById('svsPane-roles');
  const roles = currentServer.roles || [];
  pane.innerHTML = `
    <div class="svs-row-actions"><button class="modal-save" onclick="svsCreateRole()">${_svT('role_new', '+ Новая роль')}</button></div>
    <div class="svs-role-list">${roles.map(svsRoleCard).join('')}</div>`;
}

function svsRoleCard(r) {
  const perms = Number(r.permissions || 0);
  const checks = SPERM_ROWS.map(([name, label]) => {
    const on = (perms & SPERM[name]) === SPERM[name];
    return `<label class="svs-perm"><input type="checkbox" id="svsPerm-${r.id}-${name}" ${on ? 'checked' : ''}> ${escHtml(label)}</label>`;
  }).join('');
  return `<div class="svs-role-card" data-role="${r.id}">
    <div class="svs-role-head">
      <input class="svs-input svs-role-name" id="svsRoleName-${r.id}" maxlength="40" value="${escHtml(r.name)}" ${r.is_default ? 'disabled' : ''}>
      ${r.is_default ? `<span class="svs-role-badge">${_svT('role_default', 'по умолчанию')}</span>` : ''}
    </div>
    <div class="svs-perm-grid">${checks}</div>
    <div class="svs-role-actions">
      <button class="svs-btn-sm" onclick="svsSaveRole('${r.id}')">${_svT('profile_save', 'Сохранить')}</button>
      ${r.is_default ? '' : `<button class="svs-btn-sm svs-btn-danger" onclick="svsDeleteRole('${r.id}')">${_svT('server_delete_short', 'Удалить')}</button>`}
    </div>
  </div>`;
}

async function svsCreateRole() {
  const name = (prompt(_svT('role_name_prompt', 'Название роли:')) || '').trim();
  if (!name) return;
  try {
    await svsApi('/roles', { method: 'POST', body: JSON.stringify({ name, permissions: SPERM.VIEW | SPERM.SEND }) });
    await openServer(currentServer.server.id);
    renderSvsRoles();
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

async function svsSaveRole(roleId) {
  const nameEl = document.getElementById(`svsRoleName-${roleId}`);
  const body = { permissions: roleMaskFromCheckboxes(roleId) };
  if (nameEl && !nameEl.disabled) body.name = nameEl.value.trim();
  try {
    await svsApi(`/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(body) });
    await openServer(currentServer.server.id);
    renderSvsRoles();
    _svToast(_svT('server_saved', 'Сохранено'));
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

async function svsDeleteRole(roleId) {
  if (!confirm(_svT('role_delete_confirm', 'Удалить роль?'))) return;
  try {
    await svsApi(`/roles/${roleId}`, { method: 'DELETE' });
    await openServer(currentServer.server.id);
    renderSvsRoles();
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

/* ---------------- MEMBERS ---------------- */

async function renderSvsMembers() {
  const pane = document.getElementById('svsPane-members');
  pane.innerHTML = `<div class="svs-loading">${_svT('status_loading', 'Загрузка...')}</div>`;
  try {
    const data = await svsApi('/members');
    svsMembersCache = data.members || [];
  } catch (e) { pane.innerHTML = `<div class="svs-loading">${escHtml(e.message || 'Ошибка')}</div>`; return; }
  const roles = (currentServer.roles || []).filter((r) => !r.is_default);
  pane.innerHTML = svsMembersCache.map((m) => svsMemberCard(m, roles)).join('') || `<div class="svs-loading">${_svT('friends_none_yet', 'Нет участников')}</div>`;
}

function svsMemberCard(m, assignableRoles) {
  const u = m.users || {};
  const roleIds = new Set(m.roleIds || []);
  const canRoles = sHasPerm(SPERM.MANAGE_ROLES);
  const canKick = sHasPerm(SPERM.KICK) && !m.isOwner && m.user_id !== currentUser.id;
  const canBan = sHasPerm(SPERM.BAN) && !m.isOwner && m.user_id !== currentUser.id;
  const roleChips = (currentServer.roles || []).filter((r) => !r.is_default && roleIds.has(r.id))
    .map((r) => `<span class="svs-chip" style="${r.color ? `border-color:${escHtml(r.color)};color:${escHtml(r.color)}` : ''}">${escHtml(r.name)}</span>`).join('');
  const roleToggle = canRoles && assignableRoles.length
    ? `<select class="svs-role-select" onchange="svsToggleMemberRole('${m.user_id}',this)">
        <option value="">${_svT('role_assign', '+ роль…')}</option>
        ${assignableRoles.map((r) => `<option value="${r.id}">${roleIds.has(r.id) ? '✓ ' : ''}${escHtml(r.name)}</option>`).join('')}
      </select>` : '';
  const modBtns = `${canKick ? `<button class="svs-btn-sm" onclick="svsKickMember('${m.user_id}',false)">${_svT('server_kick', 'Кик')}</button>` : ''}${canBan ? `<button class="svs-btn-sm svs-btn-danger" onclick="svsKickMember('${m.user_id}',true)">${_svT('server_ban', 'Бан')}</button>` : ''}`;
  return `<div class="svs-member">
    <div class="svs-member-ava">${avatarHtml(u.avatar_emoji, u.avatar_url)}</div>
    <div class="svs-member-info">
      <div class="svs-member-name">${escHtml(u.username || '?')}${m.isOwner ? ` <span class="svs-owner-badge">👑 ${_svT('server_owner', 'владелец')}</span>` : ''}</div>
      <div class="svs-member-roles">${roleChips || `<span class="svs-muted">${_svT('role_none', 'без ролей')}</span>`}</div>
    </div>
    <div class="svs-member-actions">${roleToggle}${modBtns}</div>
  </div>`;
}

async function svsToggleMemberRole(userId, sel) {
  const roleId = sel.value;
  if (!roleId) return;
  const member = svsMembersCache.find((m) => m.user_id === userId);
  const has = member && (member.roleIds || []).includes(roleId);
  try {
    await svsApi(`/members/${userId}/roles`, { method: 'POST', body: JSON.stringify({ roleId, action: has ? 'remove' : 'add' }) });
    await renderSvsMembers();
  } catch (e) { _svToast(e.message || 'Ошибка'); sel.value = ''; }
}

async function svsKickMember(userId, ban) {
  if (!confirm(ban ? _svT('server_ban_confirm', 'Забанить участника?') : _svT('server_kick_confirm', 'Кикнуть участника?'))) return;
  try {
    await svsApi(`/members/${userId}${ban ? '?ban=true' : ''}`, { method: 'DELETE' });
    await renderSvsMembers();
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

/* ---------------- CHANNELS ---------------- */

function renderSvsChannels() {
  const pane = document.getElementById('svsPane-channels');
  const channels = currentServer.channels || [];
  pane.innerHTML = `
    <div class="svs-row-actions">
      <button class="modal-save" onclick="svsCreateChannel('text')"># ${_svT('channel_new_text', 'Текстовый канал')}</button>
      <button class="modal-save" onclick="svsCreateChannel('voice')">🔊 ${_svT('channel_new_voice', 'Голосовой канал')}</button>
    </div>
    <div class="svs-channel-list">${channels.map(svsChannelCard).join('')}</div>`;
}

function svsChannelCard(c) {
  const icon = c.type === 'voice' ? '🔊' : '#';
  const isVoice = c.type === 'voice';
  const permLabel = isVoice ? _svT('channel_perm_voice', 'кто может заходить') : _svT('channel_perm_text', 'кто может писать');
  return `<div class="svs-channel-card">
    <div class="svs-channel-row">
      <span class="svs-channel-icon">${icon}</span>
      <input class="svs-input svs-channel-name" id="svsChanName-${c.id}" maxlength="60" value="${escHtml(c.name)}">
      <button class="svs-btn-sm svs-btn-danger" onclick="svsDeleteChannel('${c.id}')">${_svT('server_delete_short', 'Удалить')}</button>
    </div>
    ${isVoice ? '' : `<input class="svs-input svs-channel-topic" id="svsChanTopic-${c.id}" maxlength="300" placeholder="${_svT('channel_topic_ph', 'Тема канала (необязательно)')}" value="${escHtml(c.topic || '')}">`}
    <label class="svs-field-label">${_svT('channel_slowmode', 'Медленный режим (секунд, 0 = выкл)')}</label>
    <input class="svs-input svs-channel-slow" id="svsChanSlow-${c.id}" type="number" min="0" max="21600" value="${Number(c.slow_mode_seconds || 0)}">
    <div class="svs-role-actions">
      <button class="svs-btn-sm" onclick="svsSaveChannel('${c.id}','${c.type}')">${_svT('profile_save', 'Сохранить')}</button>
      <button class="svs-btn-sm svs-btn-danger" onclick="svsLoadChannelPerms('${c.id}','${c.type}')">🔒 ${permLabel}</button>
    </div>
    <div class="svs-chan-perms" id="svsChanPerms-${c.id}"></div>
  </div>`;
}

// Per-channel permission overrides. Only the one permission that matters for the
// channel type is exposed: SEND (write) for text, CONNECT_VOICE (join) for voice.
// Each non-default role gets a tri-state: default / allowed / denied.
var svsChanOverrides = {}; // channelId -> { roleId: { allow, deny } }

async function svsLoadChannelPerms(channelId, type) {
  const box = document.getElementById(`svsChanPerms-${channelId}`);
  if (!box) return;
  if (box.dataset.open === '1') { box.dataset.open = '0'; box.innerHTML = ''; return; }
  box.dataset.open = '1';
  box.innerHTML = `<div class="svs-loading">${_svT('status_loading', 'Загрузка...')}</div>`;
  try {
    const data = await svsApi(`/channels/${channelId}/overrides`);
    const map = {};
    (data.overrides || []).forEach((o) => { map[o.role_id] = { allow: Number(o.allow || 0), deny: Number(o.deny || 0) }; });
    svsChanOverrides[channelId] = map;
  } catch (e) { box.innerHTML = `<div class="svs-loading">${escHtml(e.message || 'Ошибка')}</div>`; return; }
  svsRenderChannelPerms(channelId, type);
}

function svsRenderChannelPerms(channelId, type) {
  const box = document.getElementById(`svsChanPerms-${channelId}`);
  if (!box) return;
  const bit = type === 'voice' ? SPERM.CONNECT_VOICE : SPERM.SEND;
  const roles = (currentServer.roles || []); // include @everyone here — overrides on it are valid
  const map = svsChanOverrides[channelId] || {};
  const rows = roles.map((r) => {
    const ov = map[r.id] || { allow: 0, deny: 0 };
    const state = (ov.allow & bit) ? 'allow' : (ov.deny & bit) ? 'deny' : 'default';
    return `<div class="svs-perm-row">
      <span class="svs-perm-role">${escHtml(r.name)}</span>
      <select class="svs-role-select" onchange="svsSetChannelPerm('${channelId}','${r.id}',${bit},this.value)">
        <option value="default"${state === 'default' ? ' selected' : ''}>${_svT('perm_default', 'по умолчанию')}</option>
        <option value="allow"${state === 'allow' ? ' selected' : ''}>${_svT('perm_allow', '✓ разрешено')}</option>
        <option value="deny"${state === 'deny' ? ' selected' : ''}>${_svT('perm_deny', '✕ запрещено')}</option>
      </select>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="svs-field-label">${_svT('channel_perm_title', 'Доступ по ролям')}</div>${rows}`;
}

async function svsSetChannelPerm(channelId, roleId, bit, state) {
  const map = svsChanOverrides[channelId] || (svsChanOverrides[channelId] = {});
  const ov = map[roleId] || { allow: 0, deny: 0 };
  ov.allow &= ~bit; ov.deny &= ~bit;
  if (state === 'allow') ov.allow |= bit;
  else if (state === 'deny') ov.deny |= bit;
  map[roleId] = ov;
  try {
    await svsApi(`/channels/${channelId}/overrides/${roleId}`, { method: 'PUT', body: JSON.stringify({ allow: ov.allow, deny: ov.deny }) });
    _svToast(_svT('server_saved', 'Сохранено'));
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

async function svsCreateChannel(type) {
  const label = type === 'voice' ? _svT('channel_new_voice', 'Голосовой канал') : _svT('channel_new_text', 'Текстовый канал');
  const name = (prompt(`${label}:`) || '').trim();
  if (!name) return;
  try {
    await svsApi('/channels', { method: 'POST', body: JSON.stringify({ name, type }) });
    await openServer(currentServer.server.id);
    renderSvsChannels();
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

async function svsSaveChannel(channelId, type) {
  const body = { name: document.getElementById(`svsChanName-${channelId}`).value.trim(),
    slowModeSeconds: Number(document.getElementById(`svsChanSlow-${channelId}`).value) || 0 };
  const topicEl = document.getElementById(`svsChanTopic-${channelId}`);
  if (topicEl) body.topic = topicEl.value.trim();
  try {
    await svsApi(`/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify(body) });
    await openServer(currentServer.server.id);
    renderSvsChannels();
    _svToast(_svT('server_saved', 'Сохранено'));
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

async function svsDeleteChannel(channelId) {
  if (!confirm(_svT('channel_delete_confirm', 'Удалить канал?'))) return;
  try {
    await svsApi(`/channels/${channelId}`, { method: 'DELETE' });
    if (currentChannel && currentChannel.id === channelId) currentChannel = null;
    await openServer(currentServer.server.id);
    renderSvsChannels();
  } catch (e) { _svToast(e.message || 'Ошибка'); }
}

// Close on backdrop click.
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'serverSettingsOverlay') closeServerSettings();
});

window.openServerSettings = openServerSettings;
window.closeServerSettings = closeServerSettings;
window.svsShowTab = svsShowTab;

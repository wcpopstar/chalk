// ── DISCORD-STYLE SERVERS (guilds) ───────────────────────────────────────────
// REST for CRUD/history (/api/servers/*), Socket for realtime (server:join /
// server:message / server:typing). Permission bits mirror
// src/services/serverPermissions.ts — the server re-checks everything, this
// only hides dead-end UI.

var SPERM = {
  VIEW: 1 << 0, SEND: 1 << 1, MANAGE_MESSAGES: 1 << 2, MANAGE_CHANNELS: 1 << 3,
  MANAGE_ROLES: 1 << 4, KICK: 1 << 5, BAN: 1 << 6, MANAGE_SERVER: 1 << 7,
  CREATE_INVITE: 1 << 8, ADMIN: 1 << 9,
};
function sHasPerm(bit) {
  if (!currentServer) return false;
  if (currentServer.isOwner) return true;
  const mask = currentServer.myPermissions || 0;
  if (mask & SPERM.ADMIN) return true;
  return (mask & bit) === bit;
}

var myServers = [];
var currentServer = null;      // { server, channels, roles, myPermissions, isOwner }
var currentChannel = null;     // channel object currently open
var serverTypingTimers = {};   // userId -> timeout

function _svToast(msg) { if (window.showToast) window.showToast(msg); }

/* ---------------- LOAD + RAIL ---------------- */

async function loadServers() {
  try {
    const data = await api('/api/servers');
    myServers = data.servers || [];
  } catch (e) { myServers = []; }
  renderServerRail();
  // Re-open the previously active server if it still exists, else show empty.
  if (currentServer && myServers.some((s) => s.id === currentServer.server.id)) {
    openServer(currentServer.server.id);
  }
}

function renderServerRail() {
  const list = document.getElementById('serverRailList');
  if (!list) return;
  list.innerHTML = myServers.map((s) => {
    const active = currentServer && currentServer.server.id === s.id ? ' active' : '';
    const icon = s.icon_emoji || (s.name ? s.name.slice(0, 2).toUpperCase() : '🖥️');
    return `<button class="server-icon${active}" title="${escHtml(s.name)}" onclick="openServer('${s.id}')">${escHtml(icon)}</button>`;
  }).join('') || '<div class="server-rail-hint">Нет серверов</div>';
}

/* ---------------- OPEN SERVER ---------------- */

async function openServer(serverId) {
  let data;
  try {
    data = await api(`/api/servers/${  serverId}`);
  } catch (e) {
    _svToast(_svT('server_open_failed', 'Не удалось открыть сервер'));
    return;
  }
  currentServer = data;
  renderServerRail();

  document.getElementById('channelSidebar').style.display = 'flex';
  document.getElementById('channelServerName').textContent = data.server.name;
  document.getElementById('channelAddBtn').style.display = sHasPerm(SPERM.MANAGE_CHANNELS) ? '' : 'none';
  document.getElementById('serverInviteBtn').style.display = sHasPerm(SPERM.CREATE_INVITE) ? '' : 'none';
  document.getElementById('serverLeaveBtn').style.display = data.isOwner ? 'none' : '';

  renderChannelList(data.channels || []);

  // Open the first text channel automatically.
  const firstText = (data.channels || []).find((c) => c.type === 'text');
  if (firstText) openChannel(firstText.id);
  else {
    document.getElementById('channelView').style.display = 'none';
    document.getElementById('serversEmpty').style.display = 'flex';
  }
}

function renderChannelList(channels) {
  const list = document.getElementById('channelList');
  if (!list) return;
  list.innerHTML = channels.map((c) => {
    const active = currentChannel && currentChannel.id === c.id ? ' active' : '';
    const icon = c.type === 'voice' ? '🔊' : '#';
    const canManage = sHasPerm(SPERM.MANAGE_CHANNELS);
    const del = canManage ? `<span class="channel-del" title="Удалить" onclick="event.stopPropagation();deleteChannel('${c.id}')">✕</span>` : '';
    return `<div class="channel-item${active}" onclick="openChannel('${c.id}')"><span class="channel-item-icon">${icon}</span><span class="channel-item-name">${escHtml(c.name)}</span>${del}</div>`;
  }).join('');
}

/* ---------------- OPEN CHANNEL + REALTIME ---------------- */

async function openChannel(channelId) {
  if (!currentServer) return;
  const channel = (currentServer.channels || []).find((c) => c.id === channelId);
  if (!channel) return;

  // Voice channels reuse the Agora call layer (next pass) — placeholder for now.
  if (channel.type === 'voice') {
    _svToast(_svT('server_voice_soon', 'Голосовые каналы скоро'));
    return;
  }

  // Leave the previous channel's realtime room, join the new one.
  if (currentChannel && socket) socket.emit('server:leave', { channelId: currentChannel.id });
  currentChannel = channel;
  renderChannelList(currentServer.channels);

  document.getElementById('serversEmpty').style.display = 'none';
  document.getElementById('channelView').style.display = 'flex';
  document.getElementById('channelViewName').textContent = channel.name;
  document.getElementById('channelTopic').textContent = channel.topic || '';
  document.getElementById('channelTyping').textContent = '';

  const box = document.getElementById('channelMessages');
  box.innerHTML = '<div class="channel-loading">Загрузка…</div>';

  if (socket) {
    socket.emit('server:join', { channelId }, (ack) => {
      if (ack && ack.error) _svToast(ack.error);
    });
  }

  try {
    const data = await api(`/api/servers/${  currentServer.server.id  }/channels/${  channelId  }/messages`);
    renderChannelMessages(data.messages || []);
  } catch (e) {
    box.innerHTML = '<div class="channel-loading">Не удалось загрузить сообщения</div>';
  }
  const input = document.getElementById('channelInput');
  if (input) input.focus();
}

function serverMsgHtml(m) {
  const u = m.users || {};
  const t = m.created_at ? new Date(m.created_at) : new Date();
  const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const canDelete = m.sender_id === currentUser.id || sHasPerm(SPERM.MANAGE_MESSAGES);
  const del = canDelete ? `<span class="ch-msg-del" title="Удалить" onclick="deleteChannelMsg('${m.id}')">✕</span>` : '';
  const body = m.deleted_at
    ? '<div class="ch-msg-text ch-msg-deleted">сообщение удалено</div>'
    : `<div class="ch-msg-text">${escHtml(m.content || '')}</div>`;
  return `<div class="ch-msg" data-id="${m.id}">` +
    `<div class="ch-msg-ava">${avatarHtml(u.avatar_emoji, u.avatar_url)}</div>` +
    `<div class="ch-msg-body"><div class="ch-msg-head"><span class="ch-msg-name">${escHtml(u.username || '?')}</span><span class="ch-msg-time">${time}</span>${del}</div>${body}</div>` +
    `</div>`;
}

function renderChannelMessages(msgs) {
  const box = document.getElementById('channelMessages');
  if (!box) return;
  box.innerHTML = msgs.map(serverMsgHtml).join('') || '<div class="channel-loading">Пока пусто — напиши первым!</div>';
  box.scrollTop = box.scrollHeight;
}

function appendChannelMessage(m) {
  const box = document.getElementById('channelMessages');
  if (!box) return;
  if (box.querySelector(`.ch-msg[data-id="${m.id}"]`)) return; // dedupe
  const loading = box.querySelector('.channel-loading');
  if (loading) loading.remove();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.insertAdjacentHTML('beforeend', serverMsgHtml(m));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

/* ---------------- SEND / TYPING ---------------- */

function channelInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChannelMsg(); }
}

function sendChannelMsg() {
  const input = document.getElementById('channelInput');
  if (!input || !currentChannel || !socket) return;
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  socket.emit('server:message', { channelId: currentChannel.id, content }, (ack) => {
    if (ack && ack.error) {
      _svToast(ack.retryAfter ? `Медленный режим: подожди ${ack.retryAfter}с` : ack.error);
      input.value = content; // restore so the text isn't lost
    }
    // On success the broadcast (server:message) renders it — we're in the room.
  });
}

var _lastTypingSent = 0;
function channelTypingSignal() {
  if (!currentChannel || !socket) return;
  const now = Date.now();
  if (now - _lastTypingSent < 2500) return;
  _lastTypingSent = now;
  socket.emit('server:typing', { channelId: currentChannel.id });
}

function deleteChannelMsg(messageId) {
  if (!currentServer || !socket) return;
  socket.emit('server:delete', { channelId: currentChannel ? currentChannel.id : null, messageId }, (ack) => {
    if (ack && ack.error) _svToast(ack.error);
  });
}

/* ---------------- REALTIME HANDLERS (called from socket.js) ---------------- */

function onServerMessage(msg) {
  if (currentChannel && msg.channel_id === currentChannel.id) {
    appendChannelMessage(msg);
  }
  if (msg.sender_id !== currentUser.id && window.chalkSounds) window.chalkSounds.message();
}

function onServerMessageDeleted(data) {
  if (!currentChannel || data.channelId !== currentChannel.id) return;
  const box = document.getElementById('channelMessages');
  const el = box && box.querySelector(`.ch-msg[data-id="${data.messageId}"]`);
  if (el) {
    const textEl = el.querySelector('.ch-msg-text');
    if (textEl) { textEl.className = 'ch-msg-text ch-msg-deleted'; textEl.textContent = 'сообщение удалено'; }
    const del = el.querySelector('.ch-msg-del'); if (del) del.remove();
  }
}

function onServerTyping(data) {
  if (!currentChannel || data.channelId !== currentChannel.id) return;
  if (data.userId === currentUser.id) return;
  const el = document.getElementById('channelTyping');
  if (el) el.textContent = `${data.username} печатает…`;
  clearTimeout(serverTypingTimers[data.userId]);
  serverTypingTimers[data.userId] = setTimeout(() => { if (el) el.textContent = ''; }, 3500);
}

/* ---------------- CREATE / JOIN / MANAGE ---------------- */

async function promptCreateServer() {
  const name = (prompt('Название сервера:') || '').trim();
  if (!name) return;
  const iconEmoji = (prompt('Эмодзи-иконка (необязательно):') || '').trim();
  try {
    const data = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name, iconEmoji }) });
    await loadServers();
    openServer(data.server.id);
  } catch (e) { _svToast(e.message || 'Не удалось создать сервер'); }
}

async function promptJoinServer() {
  const code = (prompt('Код приглашения:') || '').trim();
  if (!code) return;
  try {
    const data = await api(`/api/servers/join/${  encodeURIComponent(code)}`, { method: 'POST' });
    await loadServers();
    if (data.server) openServer(data.server.id);
  } catch (e) { _svToast(e.message || 'Неверный код'); }
}

async function promptCreateChannel() {
  if (!currentServer) return;
  const name = (prompt('Название канала:') || '').trim();
  if (!name) return;
  try {
    await api(`/api/servers/${  currentServer.server.id  }/channels`, { method: 'POST', body: JSON.stringify({ name }) });
    await openServer(currentServer.server.id);
  } catch (e) { _svToast(e.message || 'Не удалось создать канал'); }
}

async function deleteChannel(channelId) {
  if (!currentServer) return;
  if (!confirm('Удалить канал?')) return;
  try {
    await api(`/api/servers/${  currentServer.server.id  }/channels/${  channelId}`, { method: 'DELETE' });
    if (currentChannel && currentChannel.id === channelId) currentChannel = null;
    await openServer(currentServer.server.id);
  } catch (e) { _svToast(e.message || 'Не удалось удалить'); }
}

async function showServerInvite() {
  if (!currentServer) return;
  try {
    const data = await api(`/api/servers/${  currentServer.server.id  }/invites`, { method: 'POST', body: JSON.stringify({}) });
    const {code} = data.invite;
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    _svToast(`Код приглашения: ${code} (скопирован)`);
  } catch (e) { _svToast(e.message || 'Не удалось создать инвайт'); }
}

async function leaveCurrentServer() {
  if (!currentServer || currentServer.isOwner) return;
  if (!confirm(`Покинуть сервер «${currentServer.server.name}»?`)) return;
  try {
    await api(`/api/servers/${  currentServer.server.id  }/leave`, { method: 'POST' });
    currentServer = null; currentChannel = null;
    document.getElementById('channelSidebar').style.display = 'none';
    document.getElementById('channelView').style.display = 'none';
    document.getElementById('serversEmpty').style.display = 'flex';
    await loadServers();
  } catch (e) { _svToast(e.message || 'Не удалось покинуть'); }
}

function _svT(key, fallback) {
  if (window.T) { const v = window.T(key); if (v && v !== key) return v; }
  return fallback;
}

window.loadServers = loadServers;
window.onServerMessage = onServerMessage;
window.onServerMessageDeleted = onServerMessageDeleted;
window.onServerTyping = onServerTyping;

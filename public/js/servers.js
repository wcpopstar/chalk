// ── DISCORD-STYLE SERVERS (guilds) ───────────────────────────────────────────
// REST for CRUD/history (/api/servers/*), Socket for realtime (server:join /
// server:message / server:typing). Permission bits mirror
// src/services/serverPermissions.ts — the server re-checks everything, this
// only hides dead-end UI.

var SPERM = {
  VIEW: 1 << 0, SEND: 1 << 1, MANAGE_MESSAGES: 1 << 2, MANAGE_CHANNELS: 1 << 3,
  MANAGE_ROLES: 1 << 4, KICK: 1 << 5, BAN: 1 << 6, MANAGE_SERVER: 1 << 7,
  CREATE_INVITE: 1 << 8, ADMIN: 1 << 9, CONNECT_VOICE: 1 << 10,
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
var voiceRosters = {};         // channelId -> [{userId, username, avatar_emoji, avatar_url}]
var activeVoiceChannelId = null; // the voice channel we're currently connected to (audio)

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
  const settingsBtn = document.getElementById('channelSettingsBtn');
  if (settingsBtn) settingsBtn.style.display = (typeof svsCanAny === 'function' && svsCanAny()) ? '' : 'none';

  // Subscribe to this server's room for live voice-channel rosters.
  if (socket) {
    socket.emit('server:sub', { serverId: data.server.id }, (ack) => {
      if (ack && ack.rosters) { voiceRosters = ack.rosters; renderChannelList(currentServer.channels || []); }
    });
  }

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
    const row = `<div class="channel-item${active}" onclick="openChannel('${c.id}')"><span class="channel-item-icon">${icon}</span><span class="channel-item-name">${escHtml(c.name)}</span>${del}</div>`;
    // Under a voice channel, list whoever is currently connected to it.
    if (c.type === 'voice') {
      const roster = voiceRosters[c.id] || [];
      const people = roster.map((m) =>
        `<div class="voice-roster-item"><span class="voice-roster-ava">${avatarHtml(m.avatar_emoji, m.avatar_url)}</span><span class="voice-roster-name">${escHtml(m.username || '?')}</span></div>`
      ).join('');
      return row + (people ? `<div class="voice-roster">${people}</div>` : '');
    }
    return row;
  }).join('');
}

/* ---------------- OPEN CHANNEL + REALTIME ---------------- */

async function openChannel(channelId) {
  if (!currentServer) return;
  const channel = (currentServer.channels || []).find((c) => c.id === channelId);
  if (!channel) return;

  // Voice channels get their own view (join/leave + live roster), separate from
  // the text message layer.
  if (channel.type === 'voice') { openVoiceChannel(channel); return; }

  // Leave the previous *text* channel's realtime room, join the new one.
  if (currentChannel && currentChannel.type !== 'voice' && socket) socket.emit('server:leave', { channelId: currentChannel.id });
  currentChannel = channel;
  renderChannelList(currentServer.channels);

  document.getElementById('serversEmpty').style.display = 'none';
  const voiceView = document.getElementById('channelVoice');
  if (voiceView) voiceView.style.display = 'none';
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

/* ---------------- VOICE CHANNELS ---------------- */
// Voice audio flows through the shared Agora layer (voice.js). The socket only
// tracks presence (who's connected) so the UI can show a live roster. Joining a
// voice channel: register presence via socket, then join the Agora channel it
// hands back (`sc-<channelId>`) with the mic enabled.

function openVoiceChannel(channel) {
  currentChannel = channel;
  renderChannelList(currentServer.channels);
  document.getElementById('serversEmpty').style.display = 'none';
  document.getElementById('channelView').style.display = 'none';
  const view = document.getElementById('channelVoice');
  if (view) view.style.display = 'flex';
  document.getElementById('voiceChannelName').textContent = channel.name;
  renderVoiceStage(channel.id);
  updateVoiceControls();
}

function renderVoiceStage(channelId) {
  const stage = document.getElementById('voiceStage');
  if (!stage) return;
  const roster = voiceRosters[channelId] || [];
  const countEl = document.getElementById('voiceChannelCount');
  if (countEl) countEl.textContent = roster.length ? `${roster.length} ${_svT('unit_online_word', 'в сети')}` : '';
  if (!roster.length) {
    stage.innerHTML = `<div class="voice-empty">${_svT('server_voice_empty', 'Тут пока никого нет — подключись первым!')}</div>`;
    return;
  }
  stage.innerHTML = roster.map((m) => {
    const speaking = String(m.userId) === String(currentUser.id) && activeVoiceChannelId === channelId ? ' voice-tile-self' : '';
    return `<div class="voice-tile${speaking}"><div class="voice-tile-ava">${avatarHtml(m.avatar_emoji, m.avatar_url)}</div><div class="voice-tile-name">${escHtml(m.username || '?')}</div></div>`;
  }).join('');
}

function updateVoiceControls() {
  const joinBtn = document.getElementById('voiceJoinBtn');
  const liveCtl = document.getElementById('voiceLiveControls');
  const here = currentChannel && activeVoiceChannelId === currentChannel.id;
  if (joinBtn) joinBtn.style.display = here ? 'none' : '';
  if (liveCtl) liveCtl.style.display = here ? 'flex' : 'none';
}

async function joinCurrentVoiceChannel() {
  if (!currentChannel || currentChannel.type !== 'voice' || !socket) return;
  const channelId = currentChannel.id;
  // If already connected to another voice channel, leave it first.
  if (activeVoiceChannelId && activeVoiceChannelId !== channelId) await leaveCurrentVoiceChannel();
  const joinBtn = document.getElementById('voiceJoinBtn');
  if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = _svT('status_loading', 'Подключение…'); }
  socket.emit('server:voice:join', { channelId }, async (ack) => {
    if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = _svT('server_voice_join', 'Подключиться'); }
    if (!ack || ack.error) { _svToast((ack && ack.error) || 'Не удалось подключиться'); return; }
    try {
      if (typeof window.joinVoiceAndEnableMic === 'function') {
        await window.joinVoiceAndEnableMic(ack.agoraChannel, currentUser.id);
      }
      activeVoiceChannelId = channelId;
      updateVoiceControls();
      renderVoiceStage(channelId);
    } catch (e) {
      _svToast(_svT('server_voice_mic_failed', 'Микрофон недоступен'));
      // Roll back presence if the audio layer failed to start.
      socket.emit('server:voice:leave', { channelId });
      activeVoiceChannelId = null;
      updateVoiceControls();
    }
  });
}

async function leaveCurrentVoiceChannel() {
  const channelId = activeVoiceChannelId;
  activeVoiceChannelId = null;
  if (typeof window.leaveVoice === 'function') { try { await window.leaveVoice(); } catch (_) {} }
  if (socket && channelId) socket.emit('server:voice:leave', { channelId });
  updateVoiceControls();
  if (currentChannel && currentChannel.type === 'voice') renderVoiceStage(currentChannel.id);
}

function toggleVoiceChannelMute() {
  if (typeof window.toggleVoiceMute !== 'function') return;
  window.toggleVoiceMute();
  // Reflect the new state on the button (voiceState lives in voice.js).
  const btn = document.getElementById('voiceMuteBtn');
  const muted = window.__voiceState && window.__voiceState.muted;
  if (btn) { btn.textContent = muted ? '🔇' : '🎙️'; btn.classList.toggle('voice-ctl-muted', Boolean(muted)); }
}

// Live roster push from the server for any voice channel in the open server.
function onServerVoiceRoster(data) {
  if (!data || !data.channelId) return;
  voiceRosters[data.channelId] = data.members || [];
  if (currentServer) renderChannelList(currentServer.channels);
  if (currentChannel && currentChannel.type === 'voice' && currentChannel.id === data.channelId) {
    renderVoiceStage(data.channelId);
  }
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
  // Ask channel type: OK = text (default), Cancel = voice.
  const type = confirm('Текстовый канал?\n\nОК — текстовый, Отмена — голосовой') ? 'text' : 'voice';
  try {
    await api(`/api/servers/${  currentServer.server.id  }/channels`, { method: 'POST', body: JSON.stringify({ name, type }) });
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
    if (activeVoiceChannelId) await leaveCurrentVoiceChannel();
    currentServer = null; currentChannel = null;
    document.getElementById('channelSidebar').style.display = 'none';
    document.getElementById('channelView').style.display = 'none';
    const vv = document.getElementById('channelVoice'); if (vv) vv.style.display = 'none';
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
window.onServerVoiceRoster = onServerVoiceRoster;
window.joinCurrentVoiceChannel = joinCurrentVoiceChannel;
window.leaveCurrentVoiceChannel = leaveCurrentVoiceChannel;
window.toggleVoiceChannelMute = toggleVoiceChannelMute;

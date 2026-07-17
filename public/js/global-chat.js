// ── GLOBAL CHAT (platform-wide public widget, bottom-right) ────────────────
async function loadGlobalChatHistory() {
  try {
    const data = await api('/api/chats/global/messages');
    const msgs = data.messages || [];
    const el = document.getElementById('globalChatMessages');
    if (!msgs.length) {
      el.innerHTML = '<div class="empty-chat"><div style="font-size:26px">💬</div><span data-i18n="chat_be_first">Будь первым, напиши что-нибудь!</span></div>';
      return;
    }
    el.innerHTML = '';
    msgs.forEach((m) =>{ appendGlobalMessage(m, true); });
    el.scrollTop = el.scrollHeight;
  } catch(e) { console.error(e); }
}

function globalMessageContentHtml(m) {
  if (m.deleted_at) return '<div class="gc-msg-text msg-deleted"><span data-i18n="msg_deleted_label">Сообщение удалено</span></div>';
  if (m.type === 'voice') return `<div class="msg-voice"><audio controls preload="none" src="${  escHtml(m.media_url)  }"></audio></div>`;
  if (m.type === 'gif') return `<img class="msg-gif" src="${  escHtml(giphyProxyUrl(m.media_url))  }" alt="gif" loading="lazy">`;
  if (m.type === 'video_note') return videoNoteHtml(m);
  if (m.type === 'youtube') return youtubePreviewHtml(m);
  const edited = m.edited_at ? `<span class="msg-edited-tag">(${  T('msg_edited_tag')  })</span>` : '';
  return `<div class="gc-msg-text" data-rawtext="${  escHtml(m.text || '')  }">${  escHtml(m.text || '')  }${edited  }</div>`;
}

function globalMessageActionsHtml(m) {
  if (m.deleted_at) return '';
  const isMe = currentUser && ((m.sender && m.sender.id === currentUser.id) || m.sender_id === currentUser.id);
  if (!isMe) return '';
  let btns = '';
  if (m.type === 'text') btns += `<button class="msg-action-btn" title="Редактировать" data-i18n-title="msg_edit_title" onclick="startEditMessage('global','${  m.id  }',this)">✏️</button>`;
  btns += `<button class="msg-action-btn" title="Удалить" data-i18n-title="msg_delete_title" onclick="deleteMessage('global','${  m.id  }')">🗑️</button>`;
  return `<div class="gc-msg-actions">${  btns  }</div>`;
}

function appendGlobalMessage(msg, skipScroll) {
  const el = document.getElementById('globalChatMessages');
  const empty = el.querySelector('.empty-chat');
  if (empty) el.innerHTML = '';
  const isMe = currentUser && msg.sender && msg.sender.id === currentUser.id;
  const sender = isMe ? currentUser : (msg.sender || {});
  const div = document.createElement('div');
  div.className = `gc-msg${  isMe ? ' me' : ''}`;
  div.setAttribute('data-msgid', msg.id);
  div.innerHTML =
    `<div class="gc-msg-ava" onclick="openUserProfilePopup('${  sender.id  }')">${  avatarHtml(sender.avatar_emoji, sender.avatar_url)  }</div>` +
    `<div class="gc-msg-body">${ 
      globalMessageActionsHtml(msg) 
      }<div class="gc-msg-name" onclick="openUserProfilePopup('${  sender.id  }')">${  isMe ? T('status_you') : escHtml(sender.username || '?')  }</div>${ 
      globalMessageContentHtml(msg) 
    }</div>`;
  el.appendChild(div);
  if (!skipScroll) el.scrollTop = el.scrollHeight;
}

function toggleGlobalChat() {
  const panel = document.getElementById('globalChatPanel');
  const open = panel.style.display === 'flex';
  panel.style.display = open ? 'none' : 'flex';
  if (!open) {
    document.getElementById('globalChatBadge').style.display = 'none';
    const el = document.getElementById('globalChatMessages');
    el.scrollTop = el.scrollHeight;
  }
}

var lastGlobalMsgSentAt = 0;
function sendGlobalMsg() {
  const input = document.getElementById('globalChatInput');
  const text = input.value.trim();
  if (!text || !socket) return;
  const now = Date.now();
  if (now - lastGlobalMsgSentAt < 300) return;
  lastGlobalMsgSentAt = now;
  socket.emit('global:message', { text }, (res) => {
    if (res && res.error) showToast(`❌ ${  res.error}`);
  });
  input.value = '';
}

// ── GIF PICKER (shared between the DM/group chat and the global chat) ──────
// Search goes through our own backend (/api/gifs/search), which holds the
// Giphy API key server-side — see src/routes/gifs.ts for why this isn't
// called directly from here anymore.
var gifSearchTimers = {};

// ── RECENTLY USED GIFS ─────────────────────────────────────────────────────
// Every GIF the user actually sends is remembered locally so the picker can
// offer it again without re-searching. Stored newest-first, de-duplicated and
// capped, in localStorage so it survives reloads.
var RECENT_GIFS_KEY = 'chalk_recent_gifs';
var RECENT_GIFS_MAX = 24;

function getRecentGifs() {
  try {
    const raw = localStorage.getItem(RECENT_GIFS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string') : [];
  } catch (_) { return []; }
}

function pushRecentGif(url) {
  if (!url) return;
  try {
    const list = getRecentGifs().filter((u) => u !== url);
    list.unshift(url);
    localStorage.setItem(RECENT_GIFS_KEY, JSON.stringify(list.slice(0, RECENT_GIFS_MAX)));
  } catch (_) {}
}

// Fills the picker grid with either the recent-GIF strip or the "start typing"
// hint when there's no history yet. Used whenever the search box is empty.
function renderGifPickerIdle(scope, grid) {
  const recent = getRecentGifs();
  if (!recent.length) {
    grid.innerHTML = '<div class="gif-picker-hint"><span data-i18n="gif_start_typing_hint">Начни печатать, чтобы найти GIF</span></div>';
    return;
  }
  const label = T('gif_recent', 'Недавние');
  grid.innerHTML = `<div class="gif-picker-recent-label">${  escHtml(label)  }</div>${
    recent.map((u) => `<img src="${  escHtml(giphyProxyUrl(u))  }" onclick="pickGif('${  scope  }','${  u.replace(/'/g, "\\'")  }')" alt="gif" loading="lazy">`).join('')}`;
}

function toggleGifPicker(scope) {
  const picker = document.getElementById(`gifPicker-${  scope}`);
  if (!picker) return;
  const open = picker.style.display === 'block';
  document.querySelectorAll('.gif-picker').forEach((p) =>{ p.style.display = 'none'; });
  if (!open) {
    picker.style.display = 'block';
    const input = picker.querySelector('.gif-picker-input');
    if (input) { input.value = ''; input.focus(); }
    const grid = document.getElementById(`gifGrid-${  scope}`);
    if (grid) renderGifPickerIdle(scope, grid);
  }
}

function searchGifs(scope, query) {
  clearTimeout(gifSearchTimers[scope]);
  const grid = document.getElementById(`gifGrid-${  scope}`);
  if (!grid) return;
  if (!query || !query.trim()) {
    renderGifPickerIdle(scope, grid);
    return;
  }
  gifSearchTimers[scope] = setTimeout(async () => {
    grid.innerHTML = '<div class="gif-picker-hint"><span data-i18n="gif_searching">Ищем...</span></div>';
    try {
      const data = await api(`/api/gifs/search?q=${  encodeURIComponent(query)  }&limit=12`);
      const results = data.results || [];
      if (!results.length) { grid.innerHTML = '<div class="gif-picker-hint"><span data-i18n="gif_nothing_found">Ничего не найдено</span></div>'; return; }
      grid.innerHTML = results.map((g) => `<img src="${  escHtml(giphyProxyUrl(g.thumb))  }" onclick="pickGif('${  scope  }','${  g.full.replace(/'/g, "\\'")  }')" alt="gif">`).join('');
    } catch (e) {
      // Surface the server's own reason verbatim when it sends one — 503 =
      // GIPHY_API_KEY not configured on the server, 429 = beta-key hourly cap,
      // 502 = Giphy unreachable. That's far more actionable than the generic
      // "couldn't load" text, which we keep as the fallback (e.g. network drop).
      const serverMsg = e && e.data && e.data.error;
      const msg = serverMsg
        ? escHtml(serverMsg)
        : `<span data-i18n="gif_couldnt_load">${T('gif_couldnt_load', 'Не удалось загрузить GIF')}</span>`;
      grid.innerHTML = `<div class="gif-picker-hint">${msg}</div>`;
    }
  }, 350);
}

function pickGif(scope, gifUrl) {
  const picker = document.getElementById(`gifPicker-${  scope}`);
  if (picker) picker.style.display = 'none';

  if (scope === 'avatar-ob' || scope === 'avatar-ep') {
    const previewElId = scope === 'avatar-ob' ? 'obAvatarPreview' : 'epAvatarPreview';
    const preview = document.getElementById(previewElId);
    if (preview) preview.innerHTML = `<img src="${  escHtml(giphyProxyUrl(gifUrl))  }" alt="">`;
    if (scope === 'avatar-ob') obData.avatar_url = gifUrl;
    else epData.avatar_url = gifUrl;
    return;
  }

  if (!socket) return;
  function onAck(res) {
    if (res && res.error) showToast(`❌ ${  res.error}`);
  }
  if (scope === 'global') {
    socket.emit('global:gif', { gifUrl }, onAck);
  } else {
    if (!currentConvId) return;
    socket.emit('chat:gif', { conversationId: currentConvId, gifUrl }, onAck);
  }
  // Remember it so the picker can offer it again next time (history).
  pushRecentGif(gifUrl);
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.gif-picker') || e.target.closest('.chat-attach-btn') || e.target.closest('.ob-avatar-link')) return;
  document.querySelectorAll('.gif-picker').forEach((p) =>{ p.style.display = 'none'; });
});


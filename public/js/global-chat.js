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
  if (m.type === 'gif') return `<img class="msg-gif" src="${  escHtml(m.media_url)  }" alt="gif" loading="lazy">`;
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
// Uses Giphy's public "beta" demo key, which works out of the box for
// low-volume/demo traffic. Swap GIPHY_API_KEY for your own key in production
// (https://developers.giphy.com).
var GIPHY_API_KEY = 'lOUcTmMGQOaq9ZNBb2uh0LvQVCOQplVR';
var gifSearchTimers = {};

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
    if (grid) grid.innerHTML = '<div class="gif-picker-hint"><span data-i18n="gif_start_typing_hint">Начни печатать, чтобы найти GIF</span></div>';
  }
}

function searchGifs(scope, query) {
  clearTimeout(gifSearchTimers[scope]);
  const grid = document.getElementById(`gifGrid-${  scope}`);
  if (!grid) return;
  if (!query || !query.trim()) {
    grid.innerHTML = '<div class="gif-picker-hint"><span data-i18n="gif_start_typing_hint">Начни печатать, чтобы найти GIF</span></div>';
    return;
  }
  gifSearchTimers[scope] = setTimeout(async () => {
    grid.innerHTML = '<div class="gif-picker-hint"><span data-i18n="gif_searching">Ищем...</span></div>';
    try {
      const url = `https://api.giphy.com/v1/gifs/search?api_key=${  GIPHY_API_KEY  }&q=${  encodeURIComponent(query)  }&limit=12&rating=pg-13`;
      const r = await fetch(url);
      const data = await r.json();
      const results = data.data || [];
      if (!results.length) { grid.innerHTML = '<div class="gif-picker-hint"><span data-i18n="gif_nothing_found">Ничего не найдено</span></div>'; return; }
      grid.innerHTML = results.map((g) =>{
        const thumb = g.images && g.images.fixed_width_small ? g.images.fixed_width_small.url : (g.images && g.images.preview_gif ? g.images.preview_gif.url : '');
        const full = g.images && g.images.downsized ? g.images.downsized.url : (g.images && g.images.fixed_width ? g.images.fixed_width.url : thumb);
        return `<img src="${  thumb  }" onclick="pickGif('${  scope  }','${  full.replace(/'/g, "\\'")  }')" alt="gif">`;
      }).join('');
    } catch (e) {
      grid.innerHTML = '<div class="gif-picker-hint"><span data-i18n="gif_couldnt_load">Не удалось загрузить GIF</span></div>';
    }
  }, 350);
}

function pickGif(scope, gifUrl) {
  const picker = document.getElementById(`gifPicker-${  scope}`);
  if (picker) picker.style.display = 'none';

  if (scope === 'avatar-ob' || scope === 'avatar-ep') {
    const previewElId = scope === 'avatar-ob' ? 'obAvatarPreview' : 'epAvatarPreview';
    const preview = document.getElementById(previewElId);
    if (preview) preview.innerHTML = `<img src="${  gifUrl  }" alt="">`;
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
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.gif-picker') || e.target.closest('.chat-attach-btn') || e.target.closest('.ob-avatar-link')) return;
  document.querySelectorAll('.gif-picker').forEach((p) =>{ p.style.display = 'none'; });
});


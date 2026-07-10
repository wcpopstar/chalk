// ── Render the inner content of a message bubble (text / voice / gif / deleted) ─
function messageContentHtml(m, meClass) {
  if (m.deleted_at) {
    return '<div class="msg-text msg-deleted"><span data-i18n="msg_deleted_label">Сообщение удалено</span></div>';
  }
  if (m.type === 'voice') {
    return `<div class="msg-voice"><audio controls preload="none" src="${  escHtml(m.media_url)  }"></audio></div>`;
  }
  if (m.type === 'gif') {
    return `<img class="msg-gif" src="${  escHtml(m.media_url)  }" alt="gif" loading="lazy">`;
  }
  if (m.type === 'video_note') {
    return videoNoteHtml(m);
  }
  if (m.type === 'youtube') {
    return youtubePreviewHtml(m);
  }
  const edited = m.edited_at ? `<span class="msg-edited-tag">(${  T('msg_edited_tag')  })</span>` : '';
  return `<div class="msg-text" data-rawtext="${  escHtml(m.text || '')  }">${  escHtml(m.text || '')  }${edited  }</div>`;
}

function youtubePreviewHtml(m) {
  const videoId = (m.preview_video_id || '');
  const link = (m.preview_url || m.text || '#');
  const thumb = (m.preview_thumbnail || (videoId ? `https://img.youtube.com/vi/${  videoId  }/hqdefault.jpg` : ''));
  const title = (m.preview_title || 'YouTube video');
  return `<div class="msg-youtube-card">` +
    `<a href="${  escHtml(link)  }" target="_blank" rel="noopener noreferrer" class="msg-youtube-link">${ 
    thumb ? `<img class="msg-youtube-thumb" src="${  escHtml(thumb)  }" alt="youtube preview" loading="lazy">` : '' 
    }<div class="msg-youtube-meta"><div class="msg-youtube-title">${  escHtml(title)  }</div><div class="msg-youtube-sub">Open on YouTube</div></div>` +
    `</a>` +
    `</div>`;
}

// ── Circular video note (records like a Telegram "video kruzhok") ──────────
function videoNoteHtml(m) {
  const dur = m.duration_seconds ? (`${Math.floor(m.duration_seconds / 60)  }:${  m.duration_seconds % 60 < 10 ? '0' : ''  }${m.duration_seconds % 60}`) : '';
  return `<div class="msg-video-note-wrap">` +
    `<video class="msg-video-note" src="${  escHtml(m.media_url)  }" playsinline muted loop preload="metadata" onclick="toggleVideoNotePlayback(this)"></video>` +
    `<div class="msg-video-note-play" onclick="toggleVideoNotePlayback(this.previousElementSibling)">▶</div>${ 
    dur ? `<div class="msg-video-note-dur">${  dur  }</div>` : '' 
  }</div>`;
}

function toggleVideoNotePlayback(videoEl) {
  if (!videoEl) return;
  document.querySelectorAll('video.msg-video-note').forEach((v) => {
    if (v !== videoEl) { v.pause(); v.muted = true; const w = v.closest('.msg-video-note-wrap'); if (w) w.classList.remove('playing'); }
  });
  const wrap = videoEl.closest('.msg-video-note-wrap');
  if (videoEl.paused) {
    videoEl.muted = false;
    videoEl.play().catch(() =>{});
    if (wrap) wrap.classList.add('playing');
  } else {
    videoEl.pause();
    if (wrap) wrap.classList.remove('playing');
  }
}

// ── Edit/delete icon row shown on hover, own messages only ──────────────────
function messageActionsHtml(m, scope) {
  if (m.deleted_at) return '';
  const isMe = m.sender_id === currentUser.id || (m.sender && m.sender.id === currentUser.id);
  let btns = '';
  // Replying works for ANY message in a conversation — your own included.
  if (scope === 'conv' && !String(m.id).startsWith('tmp-')) {
    btns += `<button class="msg-action-btn" title="Ответить" data-i18n-title="msg_reply_title" onclick="setReplyTo('${  m.id  }')">↩️</button>`;
  }
  if (isMe) {
    if (m.type === 'text') {
      btns += `<button class="msg-action-btn" title="Редактировать" data-i18n-title="msg_edit_title" onclick="startEditMessage('${  scope  }','${  m.id  }',this)">✏️</button>`;
    }
    btns += `<button class="msg-action-btn" title="Удалить" data-i18n-title="msg_delete_title" onclick="deleteMessage('${  scope  }','${  m.id  }',this)">🗑️</button>`;
  }
  if (!btns) return '';
  return `<div class="msg-actions" data-scope="${  scope  }">${  btns  }</div>`;
}

// Watermark of the newest moment the DM partner has confirmed reading.
// Set from GET /:id/messages (reads) and updated live via chat:read.
var partnerLastReadAt = null;
// Every loaded/appended message of the open conversation, for replies.
var convMessagesById = {};

function msgStatusHtml(m) {
  const isMe = m.sender_id === currentUser.id;
  if (!isMe || m.deleted_at) return '';
  let status = 'delivered';
  if (m._status === 'sending') status = 'sending';
  else if (partnerLastReadAt && m.created_at && m.created_at <= partnerLastReadAt) status = 'read';
  const icon = status === 'sending' ? '🕓' : (status === 'read' ? '✓✓' : '✓');
  const title = status === 'sending' ? T('msg_status_sending') : (status === 'read' ? T('msg_status_read') : T('msg_status_delivered'));
  return `<span class="msg-status" data-status="${  status  }" title="${  title  }">${  icon  }</span>`;
}

function replyQuoteHtml(m) {
  if (!m.reply_to_id && !m.reply_to) return '';
  const q = m.reply_to;
  if (!q) return `<div class="msg-reply-quote"><span class="msg-reply-quote-text">${  T('msg_deleted_label')  }</span></div>`;
  const name = q.sender && q.sender.username ? q.sender.username : T('status_user');
  const snippet = q.deleted_at ? T('msg_deleted_label')
    : q.type === 'voice' ? `🎤 ${  T('voice_msg_title')}`
    : q.type === 'gif' ? '🎞️ GIF'
    : q.type === 'video_note' ? `⭕ ${  T('video_note_title', 'Видеосообщение')}`
    : (q.text || '').slice(0, 60);
  return `<div class="msg-reply-quote" onclick="scrollToMsg('${  escHtml(q.id || '')  }')"><span class="msg-reply-quote-name">${  escHtml(name)  }</span><span class="msg-reply-quote-text">${  escHtml(snippet)  }</span></div>`;
}

function chatMsgHtml(m) {
  const isMe = m.sender_id === currentUser.id;
  const sender = isMe ? currentUser : (m.sender || {});
  const senderId = m.sender_id || sender.id || '';
  // Clicking any avatar in the conversation opens that user's profile.
  const avaClick = senderId && !isMe ? ` onclick="openUserProfilePopup('${  escHtml(senderId)  }')" style="cursor:pointer;` : ' style="';
  return `<div class="msg${  isMe ? ' me' : ''  }" data-msgid="${  m.id  }" data-created="${  escHtml(m.created_at || '')  }"><div class="msg-ava"${  avaClick  }background:linear-gradient(135deg,#7c3aed,${  isMe ? '#c8ff00' : '#ec4899'  })">${  avatarHtml(sender.avatar_emoji, sender.avatar_url)  }</div><div class="msg-body">${  messageActionsHtml(m, 'conv')  }<div class="msg-name">${  isMe ? T('status_you') : escHtml(sender.username || '?')  }</div>${  replyQuoteHtml(m)  }${  messageContentHtml(m)  }${  msgStatusHtml(m)  }</div></div>`;
}

function scrollToMsg(id) {
  const node = document.querySelector(`#chatMessages .msg[data-msgid="${  id  }"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('msg-flash');
  setTimeout(() => node.classList.remove('msg-flash'), 1200);
}

// Flip delivered ✓ into read ✓✓ for every own message the partner has now seen.
function updateReadTicks() {
  if (!partnerLastReadAt) return;
  document.querySelectorAll('#chatMessages .msg.me[data-created]').forEach((node) => {
    const created = node.getAttribute('data-created');
    const statusEl = node.querySelector('.msg-status');
    if (!statusEl || !created) return;
    if (statusEl.getAttribute('data-status') === 'sending') return; // still in flight
    if (created <= partnerLastReadAt) {
      statusEl.setAttribute('data-status', 'read');
      statusEl.textContent = '✓✓';
      statusEl.title = T('msg_status_read');
    }
  });
}

// ── Optimistic ("sending…") bubbles ─────────────────────────────────────────
function renderTempMessage(tempId, text, reply) {
  const m = {
    id: tempId,
    sender_id: currentUser.id,
    text,
    type: 'text',
    created_at: new Date().toISOString(),
    _status: 'sending',
    reply_to_id: reply ? reply.id : null,
    reply_to: reply ? { id: reply.id, text: reply.snippet, sender: { username: reply.name } } : null,
  };
  appendMessage(m);
}

function replaceTempMessage(tempId, msg) {
  convMessagesById[msg.id] = msg;
  const node = document.querySelector(`#chatMessages .msg[data-msgid="${  tempId  }"]`);
  if (!node) { appendMessage(msg); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = chatMsgHtml(msg);
  node.replaceWith(wrap.firstElementChild);
}

function markTempDelivered(tempId) {
  const statusEl = document.querySelector(`#chatMessages .msg[data-msgid="${  tempId  }"] .msg-status`);
  if (statusEl) { statusEl.setAttribute('data-status', 'delivered'); statusEl.textContent = '✓'; statusEl.title = T('msg_status_delivered'); }
}

function markTempFailed(tempId) {
  const statusEl = document.querySelector(`#chatMessages .msg[data-msgid="${  tempId  }"] .msg-status`);
  if (statusEl) { statusEl.setAttribute('data-status', 'failed'); statusEl.textContent = '⚠'; statusEl.title = T('msg_send_failed'); }
}

function appendMessage(msg) {
  const el = document.getElementById('chatMessages');
  if (msg.id) {
    convMessagesById[msg.id] = msg;
    // Our own sends come back twice: once on the ack (which replaces the
    // optimistic bubble) and once as the room broadcast echo — skip dupes.
    if (el.querySelector(`.msg[data-msgid="${  msg.id  }"]`)) return;
  }
  const empty = el.querySelector('.empty-chat');
  if (empty) el.innerHTML = '';
  const div = document.createElement('div');
  div.innerHTML = chatMsgHtml(msg);
  el.appendChild(div.firstElementChild);
  el.scrollTop = el.scrollHeight;
}

// ── Apply a real-time edit/delete to an already-rendered message bubble ─────
function patchRenderedMessage(container, msg) {
  const node = container.querySelector(`.msg[data-msgid="${  msg.id  }"], .gc-msg[data-msgid="${  msg.id  }"]`);
  if (!node) return;
  const isGlobal = node.classList.contains('gc-msg');
  const bodyEl = node.querySelector(isGlobal ? '.gc-msg-body' : '.msg-body');
  if (!bodyEl) return;
  const actionsEl = bodyEl.querySelector(isGlobal ? '.gc-msg-actions' : '.msg-actions');
  if (actionsEl) actionsEl.remove();
  const contentEl = bodyEl.querySelector(isGlobal ? '.gc-msg-text, .msg-edit-row' : '.msg-text, .msg-voice, .msg-gif, .msg-video-note-wrap, .msg-edit-row');
  const newContent = isGlobal ? globalMessageContentHtml(msg) : messageContentHtml(msg);
  if (contentEl) {
    const wrap = document.createElement('div');
    wrap.innerHTML = newContent;
    contentEl.replaceWith(wrap.firstElementChild);
  }
  const newActions = isGlobal ? globalMessageActionsHtml(msg) : messageActionsHtml(msg, 'conv');
  if (newActions) bodyEl.insertAdjacentHTML('afterbegin', newActions);
}

function markMessageDeleted(container, messageId) {
  const node = container.querySelector(`.msg[data-msgid="${  messageId  }"], .gc-msg[data-msgid="${  messageId  }"]`);
  if (!node) return;
  patchRenderedMessage(container, { id: messageId, deleted_at: new Date().toISOString() });
}

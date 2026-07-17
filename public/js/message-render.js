// ── Render the inner content of a message bubble (text / voice / gif / deleted) ─
function messageContentHtml(m, meClass) {
  if (m.deleted_at) {
    return '<div class="msg-text msg-deleted"><span data-i18n="msg_deleted_label">Сообщение удалено</span></div>';
  }
  if (m.type === 'voice') {
    const isMe = m.sender_id === currentUser.id || (m.sender && m.sender.id === currentUser.id);
    // Transcription is offered for *other people's* voice notes, and only when
    // the server has an STT provider configured (transcription.enabled flag).
    const canTranscribe = !isMe && typeof isFeatureEnabled === 'function' && isFeatureEnabled('transcription.enabled') && m.media_url;
    const btn = canTranscribe
      ? `<button class="msg-transcribe-btn" data-url="${  escHtml(m.media_url)  }" onclick="transcribeVoiceMsg(this)" title="Расшифровать в текст" data-i18n-title="transcribe_title">📝 <span data-i18n="transcribe_btn">В текст</span></button>`
      : '';
    return `<div class="msg-voice"><audio controls preload="none" src="${  escHtml(m.media_url)  }"></audio>${  btn  }<div class="msg-transcript" style="display:none"></div></div>`;
  }
  if (m.type === 'gif') {
    return `<img class="msg-gif" src="${  escHtml(m.media_url)  }" alt="gif" loading="lazy">`;
  }
  if (m.type === 'video_note') {
    return videoNoteHtml(m);
  }
  if (m.type === 'image') {
    return `<a class="msg-image-link" href="${  escHtml(m.media_url)  }" target="_blank" rel="noopener"><img class="msg-image" src="${  escHtml(m.media_url)  }" alt="image" loading="lazy"></a>`;
  }
  if (m.type === 'video') {
    return `<video class="msg-video" src="${  escHtml(m.media_url)  }" controls preload="metadata"></video>`;
  }
  if (m.type === 'file') {
    const fname = escHtml(m.text || T('attach_file', 'Файл'));
    return `<a class="msg-file" href="${  escHtml(m.media_url)  }" target="_blank" rel="noopener" download="${  fname  }"><span class="msg-file-ico">📎</span><span class="msg-file-name">${  fname  }</span></a>`;
  }
  if (m.type === 'youtube') {
    return youtubePreviewHtml(m);
  }
  // Direct-chat text is end-to-end encrypted: `m.text` holds base64 ciphertext
  // and e2eeDecryptMessage() turns it back into plaintext client-side (see
  // js/e2ee.js). null means it couldn't be opened (e.g. a keypair from another
  // device/browser) — show a lock placeholder rather than raw ciphertext.
  let text = m.text || '';
  if (m.is_encrypted) {
    const decrypted = e2eeDecryptMessage(m);
    text = decrypted === null ? '🔒 Не удалось расшифровать сообщение' : decrypted;
  }
  const edited = m.edited_at ? `<span class="msg-edited-tag">(${  T('msg_edited_tag')  })</span>` : '';
  return `<div class="msg-text" data-rawtext="${  escHtml(text)  }">${  escHtml(text)  }${edited  }</div>`;
}

// youtubePreviewHtml() + videoNoteHtml() moved to
// public/web/chat/message-html.js (bridged onto window).

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
  // Reply / forward / pin work for ANY message in a conversation — your own
  // included. Skip them on optimistic ("tmp-") bubbles that have no real id yet.
  if (scope === 'conv' && !String(m.id).startsWith('tmp-')) {
    btns += `<button class="msg-action-btn" title="Реакция" data-i18n-title="msg_react_title" onclick="openReactionPicker(event,'${  m.id  }')">😀</button>`;
    btns += `<button class="msg-action-btn" title="Ответить" data-i18n-title="msg_reply_title" onclick="setReplyTo('${  m.id  }')">↩️</button>`;
    if (!m.is_encrypted) {
      btns += `<button class="msg-action-btn" title="Переслать" data-i18n-title="msg_forward_title" onclick="openForwardModal('${  m.id  }')">↪️</button>`;
    }
    btns += `<button class="msg-action-btn" title="Закрепить" data-i18n-title="msg_pin_title" onclick="pinMessage('${  m.id  }')">📌</button>`;
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

// "↪ Forwarded from X" label above the bubble content, for forwarded copies.
// forwardedLabelHtml() + replyQuoteHtml() moved to
// public/web/chat/message-html.js (bridged onto window).

// ── Date dividers ("Сегодня" / "Вчера" / a date) between day groups ─────────
// A local-time YYYY-MM-DD key used to decide when the day changed between two
// consecutive messages.
// msgDayKey() moved to public/web/utils/format.js (bridged onto window).

// Human label for a day: "Сегодня", "Вчера", or a localized date. Used both
// for the inline dividers and the floating sticky header.
// formatDayLabel() moved to public/web/utils/format.js (bridged onto window).

// dateDividerHtml() moved to public/web/chat/message-html.js (bridged onto window).

// Builds a conversation's message list with a date divider inserted whenever
// the day changes. Used for the initial bulk render.
function chatHistoryHtml(msgs) {
  let out = '';
  let lastDay = null;
  for (let i = 0; i < msgs.length; i++) {
    const day = msgDayKey(msgs[i].created_at);
    if (day !== lastDay) { out += dateDividerHtml(msgs[i].created_at); lastDay = day; }
    out += chatMsgHtml(msgs[i]);
  }
  return out;
}

function chatMsgHtml(m) {
  const isMe = m.sender_id === currentUser.id;
  const sender = isMe ? currentUser : (m.sender || {});
  const senderId = m.sender_id || sender.id || '';
  // Clicking any avatar in the conversation opens that user's profile.
  const avaClick = senderId && !isMe ? ` onclick="openUserProfilePopup('${  escHtml(senderId)  }')" style="cursor:pointer;` : ' style="';
  return `<div class="msg${  isMe ? ' me' : ''  }" data-msgid="${  m.id  }" data-created="${  escHtml(m.created_at || '')  }"><div class="msg-ava"${  avaClick  }background:linear-gradient(135deg,#7c3aed,${  isMe ? '#c8ff00' : '#ec4899'  })">${  avatarHtml(sender.avatar_emoji, sender.avatar_url)  }</div><div class="msg-body">${  messageActionsHtml(m, 'conv')  }<div class="msg-name">${  isMe ? T('status_you') : escHtml(sender.username || '?')  }</div>${  replyQuoteHtml(m)  }${  forwardedLabelHtml(m)  }${  messageContentHtml(m)  }${  msgStatusHtml(m)  }${  typeof reactionsBarHtml === 'function' ? reactionsBarHtml(m) : ''  }</div></div>`;
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
  // The room broadcast echo can beat the ack here (the server emits to the
  // room BEFORE answering the ack) — appendMessage has already rendered the
  // real bubble then, so just drop the optimistic one instead of adding a twin.
  if (document.querySelector(`#chatMessages .msg[data-msgid="${  msg.id  }"]`)) {
    if (node) node.remove();
    return;
  }
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
  // Insert a date divider if this message falls on a later day than the last
  // rendered one (or if it's the very first message on screen).
  const lastMsg = el.querySelector('.msg[data-created]:last-of-type') ||
    (function () { const all = el.querySelectorAll('.msg[data-created]'); return all.length ? all[all.length - 1] : null; })();
  const prevDay = lastMsg ? msgDayKey(lastMsg.getAttribute('data-created')) : null;
  const thisDay = msgDayKey(msg.created_at);
  if (thisDay && thisDay !== prevDay) {
    const dwrap = document.createElement('div');
    dwrap.innerHTML = dateDividerHtml(msg.created_at);
    el.appendChild(dwrap.firstElementChild);
  }
  const div = document.createElement('div');
  div.innerHTML = chatMsgHtml(msg);
  el.appendChild(div.firstElementChild);
  el.scrollTop = el.scrollHeight;
  if (typeof updateChatDateFloat === 'function') updateChatDateFloat();
}

// ── Floating sticky date header ─────────────────────────────────────────────
// As the user scrolls the conversation, show the day of the topmost visible
// message in a pill that floats at the top ("Сегодня" → "Вчера" → a date).
function updateChatDateFloat() {
  const el = document.getElementById('chatMessages');
  const float = document.getElementById('chatDateFloat');
  if (!el || !float) return;
  const {top} = el.getBoundingClientRect();
  let label = '';
  const nodes = el.querySelectorAll('.msg[data-created]');
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i].getBoundingClientRect();
    // First message whose bottom is at/below the container top is the topmost
    // one currently visible.
    if (r.bottom >= top + 4) { label = formatDayLabel(nodes[i].getAttribute('data-created')); break; }
  }
  if (!label && nodes.length) label = formatDayLabel(nodes[nodes.length - 1].getAttribute('data-created'));
  if (label) {
    // Positioned as fixed over the top-center of the scroll container so it
    // doesn't disturb the flex layout or scroll with the content.
    const r = el.getBoundingClientRect();
    float.style.left = `${Math.round(r.left + r.width / 2)}px`;
    float.style.top = `${Math.round(r.top + 8)}px`;
    float.textContent = label;
    float.classList.add('show');
    clearTimeout(float._hideTimer);
    // Fade the pill out shortly after scrolling stops so it doesn't linger.
    float._hideTimer = setTimeout(() => { float.classList.remove('show'); }, 1400);
  }
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

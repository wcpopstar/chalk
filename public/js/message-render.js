// ── Render the inner content of a message bubble (text / voice / gif / deleted) ─
function messageContentHtml(m, meClass) {
  if (m.deleted_at) {
    return '<div class="msg-text msg-deleted"><span data-i18n="msg_deleted_label">Сообщение удалено</span></div>';
  }
  if (m.type === 'voice') {
    return '<div class="msg-voice"><audio controls preload="none" src="' + escHtml(m.media_url) + '"></audio></div>';
  }
  if (m.type === 'gif') {
    return '<img class="msg-gif" src="' + escHtml(m.media_url) + '" alt="gif" loading="lazy">';
  }
  if (m.type === 'video_note') {
    return videoNoteHtml(m);
  }
  if (m.type === 'youtube') {
    return youtubePreviewHtml(m);
  }
  var edited = m.edited_at ? '<span class="msg-edited-tag">(' + T('msg_edited_tag') + ')</span>' : '';
  return '<div class="msg-text" data-rawtext="' + escHtml(m.text || '') + '">' + escHtml(m.text || '') + edited + '</div>';
}

function youtubePreviewHtml(m) {
  var videoId = (m.preview_video_id || '');
  var link = (m.preview_url || m.text || '#');
  var thumb = (m.preview_thumbnail || (videoId ? 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg' : ''));
  var title = (m.preview_title || 'YouTube video');
  return '<div class="msg-youtube-card">' +
    '<a href="' + escHtml(link) + '" target="_blank" rel="noopener noreferrer" class="msg-youtube-link">' +
    (thumb ? '<img class="msg-youtube-thumb" src="' + escHtml(thumb) + '" alt="youtube preview" loading="lazy">' : '') +
    '<div class="msg-youtube-meta"><div class="msg-youtube-title">' + escHtml(title) + '</div><div class="msg-youtube-sub">Open on YouTube</div></div>' +
    '</a>' +
    '</div>';
}

// ── Circular video note (records like a Telegram "video kruzhok") ──────────
function videoNoteHtml(m) {
  var dur = m.duration_seconds ? (Math.floor(m.duration_seconds / 60) + ':' + (m.duration_seconds % 60 < 10 ? '0' : '') + (m.duration_seconds % 60)) : '';
  return '<div class="msg-video-note-wrap">' +
    '<video class="msg-video-note" src="' + escHtml(m.media_url) + '" playsinline muted loop preload="metadata" onclick="toggleVideoNotePlayback(this)"></video>' +
    '<div class="msg-video-note-play" onclick="toggleVideoNotePlayback(this.previousElementSibling)">▶</div>' +
    (dur ? '<div class="msg-video-note-dur">' + dur + '</div>' : '') +
  '</div>';
}

function toggleVideoNotePlayback(videoEl) {
  if (!videoEl) return;
  document.querySelectorAll('video.msg-video-note').forEach(function(v) {
    if (v !== videoEl) { v.pause(); v.muted = true; var w = v.closest('.msg-video-note-wrap'); if (w) w.classList.remove('playing'); }
  });
  var wrap = videoEl.closest('.msg-video-note-wrap');
  if (videoEl.paused) {
    videoEl.muted = false;
    videoEl.play().catch(function(){});
    if (wrap) wrap.classList.add('playing');
  } else {
    videoEl.pause();
    if (wrap) wrap.classList.remove('playing');
  }
}

// ── Edit/delete icon row shown on hover, own messages only ──────────────────
function messageActionsHtml(m, scope) {
  if (m.deleted_at) return '';
  var isMe = m.sender_id === currentUser.id || (m.sender && m.sender.id === currentUser.id);
  if (!isMe) return '';
  var btns = '';
  if (m.type === 'text') {
    btns += '<button class="msg-action-btn" title="Редактировать" data-i18n-title="msg_edit_title" onclick="startEditMessage(\'' + scope + '\',\'' + m.id + '\',this)">✏️</button>';
  }
  btns += '<button class="msg-action-btn" title="Удалить" data-i18n-title="msg_delete_title" onclick="deleteMessage(\'' + scope + '\',\'' + m.id + '\',this)">🗑️</button>';
  return '<div class="msg-actions" data-scope="' + scope + '">' + btns + '</div>';
}

function chatMsgHtml(m) {
  var isMe = m.sender_id === currentUser.id;
  var sender = isMe ? currentUser : (m.sender || {});
  return '<div class="msg' + (isMe ? ' me' : '') + '" data-msgid="' + m.id + '"><div class="msg-ava" style="background:linear-gradient(135deg,#7c3aed,' + (isMe ? '#c8ff00' : '#ec4899') + ')">' + avatarHtml(sender.avatar_emoji, sender.avatar_url) + '</div><div class="msg-body">' + messageActionsHtml(m, 'conv') + '<div class="msg-name">' + (isMe ? T('status_you') : escHtml(sender.username || '?')) + '</div>' + messageContentHtml(m) + '</div></div>';
}

function appendMessage(msg) {
  var el = document.getElementById('chatMessages');
  var empty = el.querySelector('.empty-chat');
  if (empty) el.innerHTML = '';
  var div = document.createElement('div');
  div.innerHTML = chatMsgHtml(msg);
  el.appendChild(div.firstElementChild);
  el.scrollTop = el.scrollHeight;
}

// ── Apply a real-time edit/delete to an already-rendered message bubble ─────
function patchRenderedMessage(container, msg) {
  var node = container.querySelector('.msg[data-msgid="' + msg.id + '"], .gc-msg[data-msgid="' + msg.id + '"]');
  if (!node) return;
  var isGlobal = node.classList.contains('gc-msg');
  var bodyEl = node.querySelector(isGlobal ? '.gc-msg-body' : '.msg-body');
  if (!bodyEl) return;
  var actionsEl = bodyEl.querySelector(isGlobal ? '.gc-msg-actions' : '.msg-actions');
  if (actionsEl) actionsEl.remove();
  var contentEl = bodyEl.querySelector(isGlobal ? '.gc-msg-text, .msg-edit-row' : '.msg-text, .msg-voice, .msg-gif, .msg-video-note-wrap, .msg-edit-row');
  var newContent = isGlobal ? globalMessageContentHtml(msg) : messageContentHtml(msg);
  if (contentEl) {
    var wrap = document.createElement('div');
    wrap.innerHTML = newContent;
    contentEl.replaceWith(wrap.firstElementChild);
  }
  var newActions = isGlobal ? globalMessageActionsHtml(msg) : messageActionsHtml(msg, 'conv');
  if (newActions) bodyEl.insertAdjacentHTML('afterbegin', newActions);
}

function markMessageDeleted(container, messageId) {
  var node = container.querySelector('.msg[data-msgid="' + messageId + '"], .gc-msg[data-msgid="' + messageId + '"]');
  if (!node) return;
  patchRenderedMessage(container, { id: messageId, deleted_at: new Date().toISOString() });
}

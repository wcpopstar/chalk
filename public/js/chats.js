// ── TINDER ────────────────────────────────────────────────────────────────────
async function loadDiscover() {
  try {
    var data = await api('/api/users/discover?limit=10');
    discoverUsers = data.users || [];
    discoverIndex = 0;
    renderTinderCards();
  } catch(e) { console.error(e); }
}

function renderTinderCards() {
  var stack = document.getElementById('tinderStack');
  var slice = discoverUsers.slice(discoverIndex, discoverIndex + 3);
  if (!slice.length) {
    stack.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;flex-direction:column;gap:10px"><div style="font-size:38px">🎮</div><span data-i18n="discover_seen_everyone">Пока всех посмотрел!</span></div>';
    return;
  }
  stack.innerHTML = slice.map(function(u, i){
    var bg = ['linear-gradient(135deg,#1a0533,#0f172a)','linear-gradient(135deg,#0c1445,#1e3a5f)','linear-gradient(135deg,#1a1a2e,#16213e)'][i % 3];
    return '<div class="tinder-card" data-userid="' + u.id + '" data-username="' + u.username + '"><div class="tc-banner" style="background:' + bg + '">' + avatarHtml(u.avatar_emoji, u.avatar_url) + '<div class="tc-badges"><div class="tc-badge">🌍 ' + (u.country || '?') + '</div></div></div><div class="tc-body"><div class="tc-name">' + u.username + (u.age ? ', ' + u.age : '') + '</div><div class="tc-game">\ud83c\udfae ' + T('games_player') + '</div><div class="tc-details"><div class="tc-detail">' + (u.languages || ['ru']).join(', ').toUpperCase() + '</div>' + (u.gender ? '<div class="tc-detail">' + genderLabel(u.gender) + '</div>' : '') + '<div class="tc-detail">\u25cf ' + T('status_online') + '</div></div><div class="tc-bio">' + (u.bio || T('looking_for_teammates_status')) + '</div></div></div>';
  }).join('');
}

var swipeInFlight = false;
function swipe(dir) {
  var stack = document.getElementById('tinderStack');
  var top = stack.querySelector('.tinder-card:first-child');
  if (!top || swipeInFlight) return;
  swipeInFlight = true;
  setTimeout(function(){ swipeInFlight = false; }, 350);
  var userId = top.dataset.userid;
  var username = top.dataset.username;
  top.classList.add(dir === 'left' ? 'swiped-left' : 'swiped-right');
  if (socket && userId) socket.emit('swipe', { targetUserId: userId, direction: dir });
  setTimeout(function(){
    top.remove();
    discoverIndex++;
    if (!stack.querySelector('.tinder-card')) renderTinderCards();
  }, 420);
}

// ── CHATS ─────────────────────────────────────────────────────────────────────
// ── Short preview text for the chat list (handles voice/gif/deleted) ────────
function lastMessagePreview(m) {
  if (!m) return '';
  if (m.deleted_at) return T('msg_deleted_label');
  if (m.type === 'voice') return '🎤 ' + T('voice_msg_title');
  if (m.type === 'gif') return '🎞️ GIF';
  if (m.type === 'video_note') return '⭕ ' + T('video_note_title', 'Видеосообщение');
  return (m.text || '').slice(0, 34);
}

async function loadChats() {
  try {
    var data = await api('/api/chats');
    var convs = data.conversations || [];
    var dms = convs.filter(function(c){ return c.type === 'direct' });
    var groups = convs.filter(function(c){ return c.type === 'group' });

    dmPartnersByConv = {};
    dms.forEach(function(c){ if (c.other_user) dmPartnersByConv[c.id] = c.other_user; });

    document.getElementById('dmList').innerHTML = dms.length ? dms.map(function(c){
      var last = c.last_message;
      var sub = last ? escHtml(lastMessagePreview(last)) : T('chat_no_messages');
      var time = last && last.created_at ? formatChatTime(last.created_at) : '';
      var online = c.online ? ' ci-online' : '';
      var dmName = c.other_user ? (c.other_user.username || T('status_user')) : (c.name || T('status_user'));
      var dmAva = c.other_user ? avatarHtml(c.other_user.avatar_emoji, c.other_user.avatar_url) : '👤';
      return '<div class="chat-item' + online + '" data-convid="' + c.id + '" onclick="openConv(\'' + c.id + '\',\'' + dmName.replace(/'/g,"\\'") + '\')"><div class="chat-ava">' + dmAva + '</div><div class="chat-item-body"><div class="chat-item-toprow"><div class="chat-name">' + escHtml(dmName) + '</div>' + (time ? '<div class="chat-item-time">' + time + '</div>' : '') + '</div><div class="chat-sub">' + sub + '</div></div></div>';
    }).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px"><span data-i18n="chat_no_dialogs">Нет диалогов</span></div>';

    document.getElementById('groupList').innerHTML = groups.length ? groups.map(function(c){
      return '<div class="chat-item" data-convid="' + c.id + '" onclick="openConv(\'' + c.id + '\',\'' + (c.name || T('match_group')).replace(/'/g,"\\'") + '\')"><div class="chat-ava-group">👥</div><div class="chat-item-body"><div class="chat-item-toprow"><div class="chat-name">' + (c.name || T('match_group')) + '</div></div><div class="chat-sub"><span data-i18n="match_group_chat">Групповой чат</span></div></div></div>';
    }).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px"><span data-i18n="chat_no_groups">Нет групп</span></div>';
  } catch(e) { console.error(e); }
}

// ── CREATE GROUP ─────────────────────────────────────────────────────────────
var cgSelectedIds = new Set();

async function openCreateGroup() {
  cgSelectedIds = new Set();
  document.getElementById('cgName').value = '';
  document.getElementById('cgError').classList.remove('show');
  document.getElementById('createGroupOverlay').classList.add('show');

  var listEl = document.getElementById('cgFriendList');
  listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px"><span data-i18n="status_loading">Загрузка...</span></div>';

  try {
    var data = await api('/api/friends');
    var accepted = (data.friends || []).filter(function(f){ return f.status === 'accepted' && f.friend; });
    if (!accepted.length) {
      listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px"><span data-i18n="chat_add_friends_first">Сначала добавь друзей, чтобы создать с ними группу</span></div>';
      return;
    }
    listEl.innerHTML = accepted.map(function(f){
      var fr = f.friend;
      var uname = escHtml(fr.username);
      return '<label class="cg-friend-item"><input type="checkbox" onchange="toggleGroupMember(\'' + fr.id + '\',this.checked)"><div class="chat-ava" style="width:28px;height:28px;font-size:13px">' + avatarHtml(fr.avatar_emoji, fr.avatar_url) + '</div><span class="cg-friend-name">' + uname + '</span></label>';
    }).join('');
  } catch(e) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px"><span data-i18n="friends_err_load">Не удалось загрузить друзей</span></div>';
  }
}

function closeCreateGroup() {
  document.getElementById('createGroupOverlay').classList.remove('show');
}

function toggleGroupMember(id, checked) {
  if (checked) cgSelectedIds.add(id); else cgSelectedIds.delete(id);
}

function cgShowError(msg) {
  var el = document.getElementById('cgError');
  el.textContent = msg;
  el.classList.add('show');
}

async function createGroupSubmit() {
  var name = document.getElementById('cgName').value.trim();
  if (!cgSelectedIds.size) return cgShowError(T('chat_choose_at_least_one_member'));

  var btn = document.getElementById('cgCreateBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span>' + T('auth_creating');
  try {
    var data = await api('/api/chats/group', {
      method: 'POST',
      body: JSON.stringify({ name: name || null, memberIds: Array.from(cgSelectedIds) })
    });
    closeCreateGroup();
    switchToChatTab();
    await loadChats();
    openConv(data.conversation.id, data.conversation.name || T('match_group'));
    showToast(T('chat_group_created') + ' \u2713');
  } catch(e) {
    cgShowError(e.message || T('chat_err_create_group'));
  } finally {
    btn.disabled = false;
    btn.innerHTML = T('btn_create');
  }
}

function formatChatTime(iso) {
  try {
    var d = new Date(iso);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
    }
    return (d.getDate()+'').padStart(2,'0') + '.' + ((d.getMonth()+1)+'').padStart(2,'0');
  } catch(_) { return ''; }
}

function filterChatList(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('#dmList .chat-item, #groupList .chat-item').forEach(function(item){
    var name = (item.querySelector('.chat-name') || {}).textContent || '';
    item.style.display = name.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
  });
}

function switchToChatTab() {
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active') });
  document.querySelectorAll('.nav-tab').forEach(function(t){ t.classList.remove('active') });
  document.getElementById('page-chat').classList.add('active');
  document.querySelectorAll('.nav-tab')[2].classList.add('active');
  document.getElementById('globalChatBubble').style.display = 'none';
  var panel = document.getElementById('globalChatPanel');
  if (panel) panel.style.display = 'none';
}

async function openDM(userId, username, emoji) {
  try {
    var data = await api('/api/chats/direct', { method: 'POST', body: JSON.stringify({ targetUserId: userId }) });
    switchToChatTab();
    await loadChats();
    openConv(data.conversation.id, username);
  } catch(e) { showToast(T('err_generic') + ' ' + e.message); }
}

// Jump straight into the main chat after a trial/full call. If the server
// already created the conversation (mutual "yes" vote), reuse it; otherwise
// fall back to opening/creating a DM with the first participant.
async function goToChatAfterCall() {
  try {
    clearTimeout(window._trialPromoteTimeout);
    document.getElementById('trialOverlay').classList.remove('show');
    document.getElementById('fullCallOverlay').classList.remove('show');
    document.getElementById('postCallOverlay').classList.remove('show');

    var name = currentCallParticipants.length === 1
      ? participantDisplayName(currentCallParticipants[0])
      : T('match_group');

    if (pendingChatConversationId) {
      switchToChatTab();
      await loadChats();
      openConv(pendingChatConversationId, name);
    } else if (currentCallParticipants.length === 1) {
      await openDM(currentCallParticipants[0].id, name, currentCallParticipants[0].avatar_emoji);
    } else {
      showToast(T('chat_not_available_for_group'));
    }
  } catch(e) { showToast(T('err_generic') + ' ' + e.message); }
}

async function openConv(convId, name) {
  currentConvId = convId;
  currentConvPartner = dmPartnersByConv[convId] || null;
  document.querySelectorAll('.chat-item').forEach(function(i){ i.classList.remove('active') });
  var activeItem = document.querySelector('.chat-item[data-convid="' + convId + '"]');
  if (activeItem) activeItem.classList.add('active');

  var layout = document.querySelector('.chat-layout');
  if (layout) layout.classList.add('show-chat');

  document.getElementById('chatHeader').style.display = 'flex';
  document.getElementById('chatHeaderName').textContent = currentConvPartner ? currentConvPartner.username : name;
  document.getElementById('chatHeaderStatus').textContent = currentConvPartner ? (currentConvPartner.status === 'online' ? T('status_online_lc') : T('status_offline_lc')) : T('match_group_chat');
  document.getElementById('chatHeaderAva').innerHTML = currentConvPartner ? avatarHtml(currentConvPartner.avatar_emoji, currentConvPartner.avatar_url) : '👥';
  document.getElementById('chatInputRow').style.display = 'flex';
  var callBtn = document.querySelector('.call-btn-inline');
  if (callBtn) callBtn.style.display = currentConvPartner ? '' : 'none';

  if (socket) {
    socket.emit('chat:join', { conversationId: convId });
  }

  try {
    var data = await api('/api/chats/' + convId + '/messages');
    var msgs = data.messages || [];
    var el = document.getElementById('chatMessages');
    if (!msgs.length) { el.innerHTML = '<div class="empty-chat"><div style="font-size:32px">💬</div><span data-i18n="chat_start_dialog">Начни диалог!</span></div>'; return; }
    el.innerHTML = msgs.map(function(m){ return chatMsgHtml(m); }).join('');
    el.scrollTop = el.scrollHeight;
  } catch(e) { console.error(e); }
}

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
  return '<div class="msg' + (isMe ? ' me' : '') + '" data-msgid="' + m.id + '"><div class="msg-ava" style="background:linear-gradient(135deg,#7c3aed,' + (isMe ? '#c8ff00' : '#ec4899') + ')">' + avatarHtml(sender.avatar_emoji, sender.avatar_url) + '</div><div class="msg-body">' + messageActionsHtml(m, 'conv') + '<div class="msg-name">' + (isMe ? T('status_you') : (sender.username || '?')) + '</div>' + messageContentHtml(m) + '</div></div>';
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

// ── Inline edit UI ────────────────────────────────────────────────────────
function startEditMessage(scope, messageId, btnEl) {
  var msgNode = btnEl.closest('.msg, .gc-msg');
  if (!msgNode) return;
  var isGlobal = scope === 'global';
  var textEl = msgNode.querySelector(isGlobal ? '.gc-msg-text' : '.msg-text');
  if (!textEl) return;
  var editedTagRe = new RegExp('\\(' + T('msg_edited_tag').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)\\s*$');
  var currentText = textEl.childNodes.length ? (textEl.textContent || '').replace(editedTagRe, '').trim() : '';

  var row = document.createElement('div');
  row.className = 'msg-edit-row';
  row.innerHTML = '<input class="msg-edit-input" value="" /><button class="msg-action-btn" title="Сохранить" data-i18n-title="profile_save">✔️</button><button class="msg-action-btn" title="Отмена" data-i18n-title="status_cancel">✕</button>';
  textEl.replaceWith(row);
  var input = row.querySelector('input');
  input.value = currentText;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  var buttons = row.querySelectorAll('.msg-action-btn');
  var saveBtn = buttons[0], cancelBtn = buttons[1];
  var saving = false;

  function save() {
    var newText = input.value.trim();
    if (!newText) return cancel();
    if (saving) return;
    saving = true;
    saveBtn.disabled = true;
    function onAck(res) {
      saving = false;
      saveBtn.disabled = false;
      if (res && res.error) {
        showToast('❌ ' + res.error);
        // Leave the edit box open so the person can retry instead of losing their edit.
      }
      // On success the server broadcasts chat:message:edited / global:message:edited,
      // which is what actually swaps this edit row back out for the updated bubble.
    }
    if (isGlobal) socket.emit('global:edit', { messageId: messageId, text: newText }, onAck);
    else socket.emit('chat:edit', { conversationId: currentConvId, messageId: messageId, text: newText }, onAck);
  }
  function cancel() { row.replaceWith(textEl); }

  saveBtn.onclick = save;
  cancelBtn.onclick = cancel;
  input.onkeydown = function(e){ if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); };
}

function deleteMessage(scope, messageId) {
  if (!confirm(T('msg_confirm_delete'))) return;
  function onAck(res) {
    if (res && res.error) showToast('❌ ' + res.error);
  }
  if (scope === 'global') socket.emit('global:delete', { messageId: messageId }, onAck);
  else socket.emit('chat:delete', { conversationId: currentConvId, messageId: messageId }, onAck);
}

function closeConv() {
  var layout = document.querySelector('.chat-layout');
  if (layout) layout.classList.remove('show-chat');
  currentConvId = null;
  currentConvPartner = null;
}

var lastMsgSentAt = 0;
function sendMsg(e) { if (e.key === 'Enter') sendMsgBtn(); }
function sendMsgBtn() {
  var input = document.getElementById('chatInput');
  var text = input.value.trim();
  if (!text || !currentConvId || !socket) return;
  var now = Date.now();
  if (now - lastMsgSentAt < 300) return; // guards against Enter-key/double-click spam
  lastMsgSentAt = now;
  socket.emit('chat:message', { conversationId: currentConvId, text: text }, function(res) {
    if (res && res.error) showToast('❌ ' + res.error);
  });
  input.value = '';
}

function startFriendCall() {
  if (!currentConvPartner || !currentConvPartner.id) {
    showToast(T('call_couldnt_determine_peer'));
    return;
  }
  if (!socket) {
    showToast(T('call_no_connection_server'));
    return;
  }
  // Reuse the exact same path as calling a friend from the friends sidebar:
  // call:invite → call:incoming → call:accept → call:accepted → startFullCall
  // (or call:request_join if they're already in a call). This rings the
  // other person and opens the normal full-call UI, instead of silently
  // joining a voice channel nobody else was told about.
  var cs = friendCallStatus[currentConvPartner.id] || { inCall: false, roomSize: 0 };
  callFriend(currentConvPartner.id, currentConvPartner.username, currentConvPartner.avatar_emoji, cs.inCall, cs.roomSize);
}

function startTrialCall(pts) {
  var wrap = document.getElementById('trialParticipants');
  wrap.innerHTML = pts.map(function(p){
    var pid = getParticipantId(p);
    var pname = escHtml(participantDisplayName(p)).replace(/'/g, "\\'");
    return '<div class="tp-item"><div class="tp-ava speaking" style="background:linear-gradient(135deg,#7c3aed,#059669);cursor:pointer" title="Громкость" data-i18n-title="call_volume" onclick="openUserVolumeMenu(event,\'' + pid + '\',\'' + pname + '\')">' + participantAvatarHtml(p) + '</div><div class="tp-name">' + escHtml(participantDisplayName(p)) + '</div></div>';
  }).join('') + '<div class="tp-item"><div class="tp-ava" style="background:linear-gradient(135deg,#7c3aed,#c8ff00)">' + avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url) + '</div><div class="tp-name"><span data-i18n="status_you">Ты</span></div></div>';

  trialSeconds = 120; trialVoted = false; trialMuted = false;
  document.getElementById('trialMuteBtn').textContent = '🎙️';
  document.getElementById('trialMuteBtn').classList.remove('muted');
  var continueBtn = document.getElementById('trialContinueBtn');
  if (continueBtn) {
    continueBtn.textContent = '✓';
    continueBtn.classList.remove('selected');
    continueBtn.disabled = false;
    continueBtn.title = T('btn_continue');
  }
  document.getElementById('voteSection').classList.remove('show');
  document.getElementById('trialTimer').classList.remove('warning');
  document.getElementById('trialStatus').textContent = T('match_meet_and_decide');
  document.getElementById('trialProgressFill').style.width = '100%';
  document.getElementById('trialOverlay').classList.add('show');
  clearInterval(trialInterval);
  trialInterval = setInterval(tickTrial, 1000);

  const channelName = currentRoomId ? 'voice-' + currentRoomId : 'chalk-default';
  const joinFn = window.joinVoiceAndEnableMic || window.joinVoice;
  if (joinFn) {
    joinFn(channelName, currentUser && currentUser.id).catch(function () {
      showToast(T('call_couldnt_connect_voice'));
    });
  }
}

function leaveTrialCall() { clearInterval(trialInterval); if (window.leaveVoice) window.leaveVoice(); endTrialCall(); }
function endTrialCall() { document.getElementById('trialOverlay').classList.remove('show'); showToast('📝 ' + T('call_ended')); }
function toggleTrialMute() {
  if (window.toggleVoiceMute) {
    window.toggleVoiceMute().catch(function () {
      showToast(T('call_couldnt_toggle_mic'));
    });
  }
  trialMuted = !trialMuted;
  var btn = document.getElementById('trialMuteBtn');
  btn.textContent = trialMuted ? '🔇' : '🎙️';
  btn.classList.toggle('muted', trialMuted);
}


// ── CHAT LIST ─────────────────────────────────────────────────────────────────
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

function closeConv() {
  var layout = document.querySelector('.chat-layout');
  if (layout) layout.classList.remove('show-chat');
  currentConvId = null;
  currentConvPartner = null;
}

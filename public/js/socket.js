// ── SOCKET ────────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io(API, { auth: { token: token } });

  socket.on('connect', function() { console.log('[socket] connected'); });

  socket.on('online:count', function(count) {
    document.getElementById('onlineCount').textContent = count + ' ' + T('unit_online_word');
  });

  socket.on('presence:self', function(data) {
    if (!currentUser) return;
    currentUser.presence = data.presence;
    updatePresenceUI();
  });

  socket.on('queue:size', function(data) {
    var total = (data.solo || 0) + (data.group || 0);
    document.getElementById('queueCount').textContent = total;
    document.getElementById('queueCount2').textContent = total;
  });

  socket.on('match:found', function(data) {
    currentRoomId = data.roomId;
    pendingChatConversationId = null;
    currentCallParticipants = (data.participants || [])
      .filter(function(p){ return p.userId !== currentUser.id })
      .map(function(p){ return Object.assign({}, p, { id: p.id || p.userId }); });
    showFoundOverlay(data);
  });

  socket.on('trial:voted', function(data) {
    if (data.userId !== currentUser.id) {
      showToast('✓ ' + T('call_other_player_voted'));
    }
  });

  // Server auto-adds friendship + creates/opens the conversation as soon as
  // everyone votes "yes" in the trial call, so the chat is ready right away.
  socket.on('call:promoted', function(data) {
    pendingChatConversationId = data.conversationId || null;
    loadFriends(); // server just persisted the friendship — refresh currentFriendIds
  });

  socket.on('trial:result', function(data) {
    if (data.promote) {
      clearInterval(trialInterval);
      document.getElementById('trialStatus').textContent = '✓ ' + T('call_all_ready_now_friends') + ' — ' + T('chat_already_available');
      showToast('💬 ' + T('chat_now_open_text'));
      clearTimeout(window._trialPromoteTimeout);
      window._trialPromoteTimeout = setTimeout(function() {
        document.getElementById('trialOverlay').classList.remove('show');
        startFullCall(currentCallParticipants, { mode: 'full', promotedFromTrial: true });
      }, 2500);
    }
  });

  socket.on('call:incoming', function(data) {
    if (confirm(T('call_incoming_from') + ' ' + data.from.username + '. ' + T('call_accept_q'))) {
      socket.emit('call:accept', { roomId: data.roomId, inviterId: data.from.id });
      currentRoomId = data.roomId;
      currentCallParticipants = [data.from];
      startFullCall([data.from], { mode: 'full' });
    } else {
      socket.emit('call:reject', { roomId: data.roomId, inviterId: data.from.id });
    }
  });

  socket.on('call:ended', function() {
    endFullCall(true);
  });

  socket.on('call:invite_failed', function(data) {
    showToast('❌ ' + (data && data.reason ? data.reason : T('call_couldnt_call')));
  });

  socket.on('call:accepted', function(data) {
    // We are the inviter — friend accepted our 1:1 call invite
    currentRoomId = data.roomId;
    startFullCall(currentCallParticipants, { mode: 'full' });
  });

  socket.on('call:rejected', function() {
    showToast('❌ ' + T('call_declined'));
  });

  socket.on('call:join_request_sent', function() {
    showToast('\u23f3 ' + T('match_waiting_confirm'));
  });

  socket.on('call:join_requested', function(data) {
    if (confirm(data.from.username + ' ' + T('call_someone_wants_join'))) {
      socket.emit('call:join_response', { roomId: data.roomId, requesterId: data.from.id, accept: true });
    } else {
      socket.emit('call:join_response', { roomId: data.roomId, requesterId: data.from.id, accept: false });
    }
  });

  socket.on('call:join_accepted', function(data) {
    currentRoomId = data.roomId;
    showToast('✅ ' + T('call_you_joined'));
    startFullCall(currentCallParticipants.length ? currentCallParticipants : [{ username: T('match_group'), avatar_emoji: '🎮' }], { mode: 'full' });
  });

  socket.on('call:join_rejected', function() {
    showToast('❌ ' + T('call_join_denied'));
  });

  socket.on('call:join_failed', function(data) {
    showToast('❌ ' + (data && data.reason ? data.reason : T('call_couldnt_join')));
  });

  socket.on('call:participant_joined', function(data) {
    if (!currentUser || data.userId !== currentUser.id) showToast('👋 ' + T('call_new_participant_joined'));
  });

  socket.on('friend:call_status', function(data) {
    friendCallStatus[data.userId] = { inCall: data.inCall, roomSize: data.roomSize };
    renderFriendsList();
  });

  socket.on('chat:message', function(msg) {
    if (msg.conversation_id === currentConvId) {
      appendMessage(msg);
    }
  });

  socket.on('chat:message:edited', function(msg) {
    patchRenderedMessage(document.getElementById('chatMessages'), msg);
  });

  socket.on('chat:message:deleted', function(data) {
    markMessageDeleted(document.getElementById('chatMessages'), data.messageId);
  });

  socket.on('chat:blocked', function() {
    showToast('🚫 ' + T('msg_blocked_cant_send'));
  });

  socket.on('global:message', function(msg) {
    appendGlobalMessage(msg);
    var panel = document.getElementById('globalChatPanel');
    var badge = document.getElementById('globalChatBadge');
    if ((!panel || panel.style.display === 'none') && msg.sender.id !== currentUser.id) {
      badge.style.display = 'flex';
    }
  });

  socket.on('global:message:edited', function(msg) {
    patchRenderedMessage(document.getElementById('globalChatMessages'), msg);
  });

  socket.on('global:message:deleted', function(data) {
    markMessageDeleted(document.getElementById('globalChatMessages'), data.messageId);
  });

  socket.on('swipe:match', function(data) {
    showToast('🎉 ' + T('match_mutual_like'));
  });

  socket.on('swipe:error', function(data) {
    showToast('⏳ ' + (data && data.error ? data.error : T('err_generic')));
  });

  socket.on('match:error', function(data) {
    showToast('⏳ ' + (data && data.error ? data.error : T('err_generic')));
    // Server refused the match:join — reset the button so it doesn't stay
    // stuck showing "searching" while nothing is actually queued.
    isSearching = false;
    var btn = document.getElementById('matchBtn');
    var status = document.getElementById('searchStatus');
    if (btn) { btn.textContent = T('btn_find_caps'); btn.classList.remove('searching'); }
    if (status) status.classList.remove('show');
  });

  socket.on('presence', function(data) {
    loadFriends();
  });

  socket.on('disconnect', function() { console.log('[socket] disconnected'); });
}


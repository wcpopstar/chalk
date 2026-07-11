// ── SOCKET ────────────────────────────────────────────────────────────────────
function connectSocket() {
  // `auth` as a function (rather than a plain object) is re-evaluated by
  // socket.io on every (re)connection attempt, so a reconnect automatically
  // picks up whatever the current `token` is at that moment — including one
  // we just refreshed a second ago.
  socket = io(API, { auth (cb) { cb({ token }); } });

  socket.on('connect', () => { console.log('[socket] connected'); });

  // Server proactively warns a connected socket right before it force-
  // disconnects it for an expired access token, so we can refresh and
  // reconnect immediately instead of waiting for the drop to surface as a
  // failure somewhere else in the UI.
  socket.on('auth:expired', async () => {
    const renewed = await refreshSession();
    if (renewed) {
      socket.connect();
    } else {
      forceLogout();
    }
  });

  // Covers both the initial handshake and any reconnection attempt failing
  // because the token socket.io sent was expired/revoked/invalid.
  socket.on('connect_error', async (err) => {
    const reason = err && err.message;
    if (reason === 'TOKEN_EXPIRED' || reason === 'TOKEN_REVOKED') {
      const renewed = await refreshSession();
      if (renewed) {
        socket.connect();
      } else {
        forceLogout();
      }
    } else {
      console.warn('[socket] connect_error', reason);
    }
  });

  socket.on('online:count', (count) => {
    document.getElementById('onlineCount').textContent = `${count  } ${  T('unit_online_word')}`;
  });

  socket.on('presence:self', (data) => {
    if (!currentUser) return;
    currentUser.presence = data.presence;
    updatePresenceUI();
  });

  socket.on('queue:size', (data) => {
    const total = (data.solo || 0) + (data.group || 0);
    document.getElementById('queueCount').textContent = total;
    document.getElementById('queueCount2').textContent = total;
  });

  socket.on('match:found', (data) => {
    currentRoomId = data.roomId;
    pendingChatConversationId = null;
    currentCallParticipants = (data.participants || [])
      .filter((p) =>p.userId !== currentUser.id)
      .map((p) =>Object.assign({}, p, { id: p.id || p.userId }));
    showFoundOverlay(data);
  });

  socket.on('trial:voted', (data) => {
    if (data.userId !== currentUser.id) {
      showToast(`✓ ${  T('call_other_player_voted')}`);
    }
  });

  // Server auto-adds friendship + creates/opens the conversation as soon as
  // everyone votes "yes" in the trial call, so the chat is ready right away.
  socket.on('call:promoted', (data) => {
    pendingChatConversationId = data.conversationId || null;
    loadFriends(); // server just persisted the friendship — refresh currentFriendIds
  });

  socket.on('trial:result', (data) => {
    if (data.promote) {
      clearInterval(trialInterval);
      document.getElementById('trialStatus').textContent = `✓ ${  T('call_all_ready_now_friends')  } — ${  T('chat_already_available')}`;
      showToast(`💬 ${  T('chat_now_open_text')}`);
      clearTimeout(window._trialPromoteTimeout);
      window._trialPromoteTimeout = setTimeout(() => {
        document.getElementById('trialOverlay').classList.remove('show');
        startFullCall(currentCallParticipants, { mode: 'full', promotedFromTrial: true });
      }, 2500);
    }
  });

  socket.on('call:incoming', (data) => {
    if (confirm(`${T('call_incoming_from')  } ${  data.from.username  }. ${  T('call_accept_q')}`)) {
      socket.emit('call:accept', { roomId: data.roomId, inviterId: data.from.id });
      currentRoomId = data.roomId;
      currentCallParticipants = [data.from];
      startFullCall([data.from], { mode: 'full' });
    } else {
      socket.emit('call:reject', { roomId: data.roomId, inviterId: data.from.id });
    }
  });

  socket.on('call:ended', () => {
    endFullCall(true);
  });

  socket.on('call:invite_failed', (data) => {
    showToast(`❌ ${  data && data.reason ? data.reason : T('call_couldnt_call')}`);
  });

  socket.on('call:accepted', (data) => {
    // We are the inviter — friend accepted our 1:1 call invite
    currentRoomId = data.roomId;
    startFullCall(currentCallParticipants, { mode: 'full' });
  });

  socket.on('call:rejected', () => {
    showToast(`❌ ${  T('call_declined')}`);
  });

  socket.on('call:join_request_sent', () => {
    showToast(`\u23f3 ${  T('match_waiting_confirm')}`);
  });

  socket.on('call:join_requested', (data) => {
    if (confirm(`${data.from.username  } ${  T('call_someone_wants_join')}`)) {
      socket.emit('call:join_response', { roomId: data.roomId, requesterId: data.from.id, accept: true });
    } else {
      socket.emit('call:join_response', { roomId: data.roomId, requesterId: data.from.id, accept: false });
    }
  });

  socket.on('call:join_accepted', (data) => {
    currentRoomId = data.roomId;
    showToast(`✅ ${  T('call_you_joined')}`);
    startFullCall(currentCallParticipants.length ? currentCallParticipants : [{ username: T('match_group'), avatar_emoji: '🎮' }], { mode: 'full' });
  });

  socket.on('call:join_rejected', () => {
    showToast(`❌ ${  T('call_join_denied')}`);
  });

  socket.on('call:join_failed', (data) => {
    showToast(`❌ ${  data && data.reason ? data.reason : T('call_couldnt_join')}`);
  });

  socket.on('call:participant_joined', (data) => {
    if (!currentUser || data.userId !== currentUser.id) showToast(`👋 ${  T('call_new_participant_joined')}`);
  });

  socket.on('friend:call_status', (data) => {
    friendCallStatus[data.userId] = { inCall: data.inCall, roomSize: data.roomSize };
    renderFriendsList();
  });

  socket.on('chat:message', (msg) => {
    if (msg.conversation_id === currentConvId) {
      appendMessage(msg); // dedupes the echo of our own ack-rendered sends
      // The conversation is open on screen — confirm the read right away so
      // the sender's ✓ flips to ✓✓ in real time.
      if (msg.sender_id !== currentUser.id) {
        socket.emit('chat:read', { conversationId: currentConvId });
      }
    }
  });

  // Someone (either member — io.to() echoes this back to the toggler too)
  // flipped the conversation's E2EE lock. Flip the send path + button, and
  // toast so the change never happens silently.
  socket.on('chat:e2ee', (data) => {
    convE2eeById[data.conversationId] = data.enabled;
    if (data.conversationId !== currentConvId) return;
    currentConvE2ee = data.enabled;
    updateE2eeToggleBtn();
    showToast(data.enabled ? `🔒 ${  T('e2ee_enabled_toast')}` : `🔓 ${  T('e2ee_disabled_toast')}`);
  });

  // Partner confirmed reading up to lastReadAt — flip ✓ into ✓✓ live.
  socket.on('chat:read', (data) => {
    if (data.conversationId !== currentConvId || data.userId === currentUser.id) return;
    if (!partnerLastReadAt || data.lastReadAt > partnerLastReadAt) {
      partnerLastReadAt = data.lastReadAt;
      updateReadTicks();
    }
  });

  // "N is typing… / recording a voice message…" under the chat header.
  socket.on('chat:typing', (data) => {
    if (data.conversationId !== currentConvId || data.userId === currentUser.id) return;
    showChatActivity(data);
  });

  socket.on('chat:message:edited', (msg) => {
    patchRenderedMessage(document.getElementById('chatMessages'), msg);
  });

  socket.on('chat:message:deleted', (data) => {
    markMessageDeleted(document.getElementById('chatMessages'), data.messageId);
  });

  socket.on('chat:blocked', () => {
    showToast(`🚫 ${  T('msg_blocked_cant_send')}`);
  });

  socket.on('global:message', (msg) => {
    appendGlobalMessage(msg);
    const panel = document.getElementById('globalChatPanel');
    const badge = document.getElementById('globalChatBadge');
    if ((!panel || panel.style.display === 'none') && msg.sender.id !== currentUser.id) {
      badge.style.display = 'flex';
    }
  });

  socket.on('global:message:edited', (msg) => {
    patchRenderedMessage(document.getElementById('globalChatMessages'), msg);
  });

  socket.on('global:message:deleted', (data) => {
    markMessageDeleted(document.getElementById('globalChatMessages'), data.messageId);
  });

  socket.on('swipe:match', (data) => {
    showToast(`🎉 ${  T('match_mutual_like')}`);
  });

  socket.on('swipe:error', (data) => {
    showToast(`⏳ ${  data && data.error ? data.error : T('err_generic')}`);
  });

  socket.on('match:error', (data) => {
    showToast(`⏳ ${  data && data.error ? data.error : T('err_generic')}`);
    // Server refused the match:join — reset the button so it doesn't stay
    // stuck showing "searching" while nothing is actually queued.
    isSearching = false;
    const btn = document.getElementById('matchBtn');
    const status = document.getElementById('searchStatus');
    if (btn) { btn.textContent = T('btn_find_caps'); btn.classList.remove('searching'); }
    if (status) status.classList.remove('show');
  });

  socket.on('presence', (data) => {
    loadFriends();
  });

  socket.on('disconnect', () => { console.log('[socket] disconnected'); });
}


// ── Chat activity label (typing / recording voice / recording video) ────────
// Shown in place of the online/offline line under the partner's name and
// restored automatically after 3.5s without a fresh activity event (the
// sender re-emits every ~2.5s while active, so no explicit stop is needed).
var _chatActivityTimer = null;
function showChatActivity(data) {
  const statusEl = document.getElementById('chatHeaderStatus');
  if (!statusEl) return;
  if (!statusEl.dataset.origText) statusEl.dataset.origText = statusEl.textContent;
  const label = data.kind === 'voice' ? T('chat_recording_voice_label', 'записывает голосовое…')
    : data.kind === 'video' ? T('chat_recording_video_label', 'записывает видеосообщение…')
    : T('chat_typing_label', 'печатает…');
  statusEl.textContent = currentConvPartner ? label : `${data.username} ${label}`;
  statusEl.classList.add('chat-activity');
  clearTimeout(_chatActivityTimer);
  _chatActivityTimer = setTimeout(() => {
    statusEl.textContent = statusEl.dataset.origText || '';
    statusEl.dataset.origText = '';
    statusEl.classList.remove('chat-activity');
  }, 3500);
}

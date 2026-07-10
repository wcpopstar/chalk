// ── SEND + REPLY + ACTIVITY (typing / recording) ────────────────────────────
var lastMsgSentAt = 0;
var replyingTo = null;      // { id, name, snippet } — message being replied to
var _tempMsgSeq = 0;
// Conversations where we've already shown the "partner has no E2EE key yet,
// sending unencrypted" notice — once per conversation per session is enough.
var _plaintextNoticeShown = {};

function sendMsg(e) { if (e.key === 'Enter') sendMsgBtn(); }

function sendMsgBtn() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !currentConvId || !socket) return;
  const now = Date.now();
  if (now - lastMsgSentAt < 300) return; // guards against Enter-key/double-click spam

  // Direct (1:1) chats are end-to-end encrypted — currentConvPartner is only
  // set for direct chats (see chats-list.js openConv()); group chats leave it
  // null and keep sending plaintext (no group-key scheme yet). Build the wire
  // payload first so we can bail out *before* the optimistic bubble/clearing
  // the input if encryption isn't possible yet.
  const reply = replyingTo;
  const payload = { conversationId: currentConvId };
  if (reply) payload.replyToId = reply.id;

  const partnerKey = currentConvPartner && currentConvPartner.public_key;
  if (partnerKey) {
    const enc = e2eeEncryptOrToast(text, partnerKey);
    if (!enc) return;
    payload.ciphertext = enc.ciphertext;
    payload.nonce = enc.nonce;
  } else {
    if (currentConvPartner) {
      // Direct chat, but the partner hasn't opened the app since E2EE
      // shipped, so there's no key to encrypt to yet. Blocking the message
      // entirely would make every dormant user unreachable — fall back to
      // plaintext (exactly what the whole conversation was before E2EE) and
      // say so once. The snapshot can be stale, so re-check in the
      // background, and the server independently rejects plaintext when a
      // key actually exists (see the e2ee_required handling in the ack).
      if (typeof refreshPartnerKey === 'function') refreshPartnerKey(currentConvId);
      if (!_plaintextNoticeShown[currentConvId]) {
        _plaintextNoticeShown[currentConvId] = true;
        showToast('🔓 Собеседник ещё не настроил шифрование — пока сообщения отправляются без него');
      }
    }
    payload.text = text; // group chats and keyless direct chats both go plaintext
  }

  lastMsgSentAt = now;

  // Optimistic bubble: shows the *plaintext* instantly (this device already
  // knows it) with a "sending" clock, swapped for the real saved message
  // when the server ack arrives.
  const tempId = `tmp-${Date.now()}-${++_tempMsgSeq}`;
  renderTempMessage(tempId, text, reply);

  clearReply();
  input.value = '';

  let retriedEncrypted = false;
  function onSendAck(res) {
    if (res && res.error) {
      // The server rejected a plaintext send because the partner DOES have a
      // key (our snapshot was stale) and handed the fresh key back — adopt
      // it, re-encrypt the same text, and resend once.
      if (!retriedEncrypted && res.code === 'e2ee_required' && res.partnerPublicKey) {
        retriedEncrypted = true;
        if (dmPartnersByConv[payload.conversationId]) dmPartnersByConv[payload.conversationId].public_key = res.partnerPublicKey;
        if (currentConvId === payload.conversationId && currentConvPartner) currentConvPartner.public_key = res.partnerPublicKey;
        delete _plaintextNoticeShown[payload.conversationId]; // the notice no longer applies
        const enc = e2eeReady() ? e2eeEncrypt(text, res.partnerPublicKey) : null;
        if (enc) {
          delete payload.text;
          payload.ciphertext = enc.ciphertext;
          payload.nonce = enc.nonce;
          socket.emit('chat:message', payload, onSendAck);
          return;
        }
      }
      markTempFailed(tempId);
      showToast(`❌ ${  res.error}`);
      return;
    }
    // Server echoes the saved message on the ack (newer server); fall back
    // to just flipping the clock to a checkmark if it doesn't.
    if (res && res.message) replaceTempMessage(tempId, res.message);
    else markTempDelivered(tempId);
  }
  socket.emit('chat:message', payload, onSendAck);
}

// ── Reply state ──────────────────────────────────────────────────────────────
function setReplyTo(messageId) {
  const m = convMessagesById[messageId];
  if (!m) return;
  const name = m.sender_id === currentUser.id ? T('status_you') : ((m.sender && m.sender.username) || T('status_user'));
  replyingTo = { id: messageId, name, snippet: replySnippet(m) };
  const bar = document.getElementById('chatReplyBar');
  if (bar) {
    bar.innerHTML = `<div class="chat-reply-bar-body">↩ <b>${  escHtml(name)  }</b>: ${  escHtml(replyingTo.snippet)  }</div>` +
      `<button class="chat-reply-bar-cancel" onclick="clearReply()">✕</button>`;
    bar.style.display = 'flex';
  }
  const input = document.getElementById('chatInput');
  if (input) input.focus();
}

function clearReply() {
  replyingTo = null;
  const bar = document.getElementById('chatReplyBar');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
}

function replySnippet(m) {
  if (m.deleted_at) return T('msg_deleted_label');
  if (m.type === 'voice') return `🎤 ${  T('voice_msg_title')}`;
  if (m.type === 'gif') return '🎞️ GIF';
  if (m.type === 'video_note') return `⭕ ${  T('video_note_title', 'Видеосообщение')}`;
  return (m.text || '').slice(0, 60);
}

// ── Activity: typing + recording indicators ──────────────────────────────────
// Sent at most once per 2.5s per kind; the receiving side lets the label
// expire after 3.5s of silence, so no explicit "stopped" event is needed.
var _lastActivitySentAt = 0;
var _recordingActivityTimer = null;

function sendChatActivity(kind) {
  if (!socket || !currentConvId) return;
  socket.emit('chat:typing', { conversationId: currentConvId, kind });
}

function notifyTypingInput() {
  const now = Date.now();
  if (now - _lastActivitySentAt < 2500) return;
  _lastActivitySentAt = now;
  sendChatActivity('typing');
}

// Called by media-notes.js while a voice/video note is being recorded.
function chatActivityStart(kind) {
  chatActivityStop();
  sendChatActivity(kind);
  _recordingActivityTimer = setInterval(() => sendChatActivity(kind), 2500);
}

function chatActivityStop() {
  if (_recordingActivityTimer) { clearInterval(_recordingActivityTimer); _recordingActivityTimer = null; }
}

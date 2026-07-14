// ── SEND + REPLY + ACTIVITY (typing / recording) ────────────────────────────
var lastMsgSentAt = 0;
var replyingTo = null;      // { id, name, snippet } — message being replied to
var _tempMsgSeq = 0;

function sendMsg(e) { if (e.key === 'Enter') sendMsgBtn(); }

// ── Attachments (photo / video / file) ──────────────────────────────────────
// Reads each picked file as raw bytes and streams it over the socket; the
// server sniffs the type, stores it, and echoes back a chat:message which the
// socket handler appends to the open conversation. See socket/chat.ts.
var MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024; // keep in sync with socket/media.ts
function sendChatFiles(files) {
  if (!files || !files.length || !currentConvId || !socket) return;
  var sending = false;
  Array.prototype.forEach.call(files, (file) => {
    if (file.size > MAX_CHAT_FILE_BYTES) {
      showToast(T('attach_too_big').replace('{name}', file.name));
      return;
    }
    sending = true;
    file.arrayBuffer().then((buf) => {
      socket.emit('chat:media', { conversationId: currentConvId, data: buf, mime: file.type || '', name: file.name }, (res) => {
        if (res && res.error) showToast(`❌ ${  res.error}`);
      });
    }).catch(() => { showToast(T('err_generic')); });
  });
  if (sending) showToast(T('attach_sending'));
}

function sendMsgBtn() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !currentConvId || !socket) return;
  const now = Date.now();
  if (now - lastMsgSentAt < 300) return; // guards against Enter-key/double-click spam

  // E2EE is opt-in per conversation (the lock button → chats-list.js
  // toggleConvE2ee(); currentConvE2ee tracks the open conversation's flag).
  // Everything else — groups, and direct chats with the lock off — goes
  // plaintext. Build the wire payload first so we can bail out *before* the
  // optimistic bubble/clearing the input if encryption isn't possible yet.
  const reply = replyingTo;
  const payload = { conversationId: currentConvId };
  if (reply) payload.replyToId = reply.id;

  if (currentConvE2ee && currentConvPartner) {
    const enc = e2eeEncryptOrToast(text, currentConvPartner.public_key);
    if (!enc) return;
    payload.ciphertext = enc.ciphertext;
    payload.nonce = enc.nonce;
  } else {
    payload.text = text;
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
      // The server rejected a plaintext send because encryption was switched
      // ON while our flag was stale (e.g. the partner flipped the lock right
      // before we hit send) and handed the fresh key back — adopt the flag
      // and key, re-encrypt the same text, and resend once.
      if (!retriedEncrypted && res.code === 'e2ee_required' && res.partnerPublicKey) {
        retriedEncrypted = true;
        convE2eeById[payload.conversationId] = true;
        if (dmPartnersByConv[payload.conversationId]) dmPartnersByConv[payload.conversationId].public_key = res.partnerPublicKey;
        if (currentConvId === payload.conversationId) {
          currentConvE2ee = true;
          if (currentConvPartner) currentConvPartner.public_key = res.partnerPublicKey;
          updateE2eeToggleBtn();
        }
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

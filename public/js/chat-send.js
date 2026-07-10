// ── SEND + REPLY + ACTIVITY (typing / recording) ────────────────────────────
var lastMsgSentAt = 0;
var replyingTo = null;      // { id, name, snippet } — message being replied to
var _tempMsgSeq = 0;

function sendMsg(e) { if (e.key === 'Enter') sendMsgBtn(); }

function sendMsgBtn() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !currentConvId || !socket) return;
  const now = Date.now();
  if (now - lastMsgSentAt < 300) return; // guards against Enter-key/double-click spam
  lastMsgSentAt = now;

  // Optimistic bubble: shows instantly with a "sending" clock, swapped for
  // the real saved message when the server ack arrives.
  const tempId = `tmp-${Date.now()}-${++_tempMsgSeq}`;
  const reply = replyingTo;
  renderTempMessage(tempId, text, reply);

  const payload = { conversationId: currentConvId, text };
  if (reply) payload.replyToId = reply.id;
  clearReply();
  input.value = '';

  socket.emit('chat:message', payload, (res) => {
    if (res && res.error) {
      markTempFailed(tempId);
      showToast(`❌ ${  res.error}`);
      return;
    }
    // Server echoes the saved message on the ack (newer server); fall back
    // to just flipping the clock to a checkmark if it doesn't.
    if (res && res.message) replaceTempMessage(tempId, res.message);
    else markTempDelivered(tempId);
  });
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

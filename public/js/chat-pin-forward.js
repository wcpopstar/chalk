// ── PIN / FORWARD / LAST-SEEN ───────────────────────────────────────────────
// Three small chat features that share the open-conversation state
// (currentConvId / currentConvPartner / convMessagesById) already set up by
// chats-list.js and message-render.js.

// ── Pinned message (one per conversation, Telegram-style banner) ────────────
var currentPinnedId = null;

function pinMessage(messageId) {
  if (!socket || !currentConvId) return;
  socket.emit('chat:pin', { conversationId: currentConvId, messageId }, (res) => {
    if (res && res.error) { showToast(`❌ ${  res.error}`); return; }
    showToast(`📌 ${  T('pinned_toast')}`);
  });
}

function unpinCurrent() {
  if (!socket || !currentConvId) return;
  socket.emit('chat:pin', { conversationId: currentConvId, messageId: null }, (res) => {
    if (res && res.error) { showToast(`❌ ${  res.error}`); return; }
    showToast(T('unpinned_toast'));
  });
}

// Build the short preview shown in the pinned banner (decrypts E2EE text the
// same way message-render.js does for the open conversation).
function pinnedSnippet(m) {
  if (!m) return '';
  if (m.deleted_at) return T('msg_deleted_label');
  if (m.type === 'voice') return `🎤 ${  T('voice_msg_title')}`;
  if (m.type === 'gif') return '🎞️ GIF';
  if (m.type === 'video_note') return `⭕ ${  T('video_note_title', 'Видеосообщение')}`;
  let text = m.text || '';
  if (m.is_encrypted && typeof e2eeDecryptMessage === 'function') {
    const d = e2eeDecryptMessage(m);
    text = d === null ? '🔒' : d;
  }
  return text.slice(0, 80);
}

function renderPinnedBanner(msg) {
  const bar = document.getElementById('chatPinnedBar');
  const txt = document.getElementById('chatPinnedText');
  if (!bar || !txt) return;
  if (!msg) { bar.style.display = 'none'; currentPinnedId = null; return; }
  currentPinnedId = msg.id;
  txt.textContent = pinnedSnippet(msg);
  bar.style.display = 'flex';
}

function scrollToPinned() {
  if (currentPinnedId && typeof scrollToMsg === 'function') scrollToMsg(currentPinnedId);
}

// Called from socket.js on the chat:pinned broadcast.
function applyPinnedUpdate(data) {
  if (data.conversationId !== currentConvId) return;
  renderPinnedBanner(data.message || null);
}

// ── Per-conversation extras (pin banner + wallpaper), driven by openConv ────
// Reset to defaults when a conversation is opened, then re-applied from the
// GET /:id/messages response once it lands.
function resetConvExtrasUI() {
  renderPinnedBanner(null);
  if (typeof setChatBackgroundForConv === 'function') setChatBackgroundForConv('none');
}

function applyConvExtras(data) {
  if (typeof setChatBackgroundForConv === 'function') setChatBackgroundForConv((data && data.chat_background) || 'none');
  renderPinnedBanner((data && data.pinned) || null);
}

// ── Forward a message into another conversation ─────────────────────────────
var forwardSourceId = null;

function openForwardModal(messageId) {
  const m = convMessagesById[messageId];
  if (m && m.is_encrypted) { showToast(`🔒 ${  T('forward_cant_encrypted')}`); return; }
  forwardSourceId = messageId;
  renderForwardList('');
  const overlay = document.getElementById('forwardOverlay');
  if (overlay) overlay.classList.add('show');
  const s = document.getElementById('forwardSearch');
  if (s) { s.value = ''; setTimeout(() => s.focus(), 50); }
}

function closeForwardModal() {
  const overlay = document.getElementById('forwardOverlay');
  if (overlay) overlay.classList.remove('show');
  forwardSourceId = null;
}

function renderForwardList(q) {
  const list = document.getElementById('forwardList');
  if (!list) return;
  q = (q || '').trim().toLowerCase();
  // Encrypted conversations can't receive a forwarded (plaintext) copy — the
  // server rejects it — so leave them out of the picker entirely.
  const convs = (typeof lastConversations !== 'undefined' && lastConversations ? lastConversations : []).filter((c) => !c.e2ee_enabled);
  const rows = convs.map((c) => {
    const name = c.type === 'direct'
      ? ((c.other_user && c.other_user.username) || c.name || T('status_user'))
      : (c.name || T('match_group'));
    if (q && name.toLowerCase().indexOf(q) === -1) return '';
    const ava = c.type === 'direct'
      ? (c.other_user ? avatarHtml(c.other_user.avatar_emoji, c.other_user.avatar_url) : '👤')
      : '👥';
    return `<div class="forward-item" onclick="doForward('${  c.id  }')"><div class="chat-ava" style="width:34px;height:34px;font-size:15px">${  ava  }</div><div class="forward-item-name">${  escHtml(name)  }</div></div>`;
  }).filter(Boolean).join('');
  list.innerHTML = rows || `<div style="font-size:12px;color:var(--muted);padding:12px;text-align:center">${  T('forward_no_chats')  }</div>`;
}

function filterForwardList(q) { renderForwardList(q); }

function doForward(toConvId) {
  if (!socket || !forwardSourceId) { closeForwardModal(); return; }
  socket.emit('chat:forward', { fromMessageId: forwardSourceId, toConversationId: toConvId }, (res) => {
    if (res && res.error) { showToast(`❌ ${  res.error}`); return; }
    showToast(`↪️ ${  T('forward_sent')}`);
  });
  closeForwardModal();
}

// ── "Last seen" formatting for the direct-chat header ───────────────────────
// formatLastSeen() moved to public/web/utils/format.js (bridged onto window).

// presenceStatusLabel() moved to public/web/chat/summary.js (bridged onto window).

// Refresh the header line under the partner's name from currentConvPartner —
// unless a transient "typing…/recording…" label is currently showing (that
// one restores itself after a few seconds, see socket.js showChatActivity).
function updateChatHeaderPresence() {
  const el = document.getElementById('chatHeaderStatus');
  if (!el) return;
  if (el.classList.contains('chat-activity')) return;
  if (!currentConvPartner) { el.textContent = T('match_group_chat'); return; }
  el.textContent = presenceStatusLabel(currentConvPartner);
}

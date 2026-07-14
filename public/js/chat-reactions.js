// ── MESSAGE REACTIONS (Telegram-style) ──────────────────────────────────────
// Each message carries a `reactions` array of { emoji, user_id } rows (from
// GET /:id/messages and the chat:message payload). We aggregate those into
// per-emoji counts for the little chips under a bubble, and highlight the
// ones the current user picked. Toggling is a single chat:react socket event;
// the server broadcasts the fresh aggregate back on chat:reaction, which
// re-renders just the affected bubble's reaction bar.

var REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '😮', '😢', '🎉', '👎'];

// Aggregate raw {emoji,user_id} rows into [{ emoji, count, mine }], stable
// insertion order so the chips don't jump around as counts change.
function aggregateReactions(rows) {
  const order = [];
  const byEmoji = {};
  (rows || []).forEach((r) => {
    if (!r || !r.emoji) return;
    if (!byEmoji[r.emoji]) { byEmoji[r.emoji] = { emoji: r.emoji, count: 0, mine: false }; order.push(r.emoji); }
    byEmoji[r.emoji].count += 1;
    if (currentUser && r.user_id === currentUser.id) byEmoji[r.emoji].mine = true;
  });
  return order.map((e) => byEmoji[e]);
}

function reactionsBarHtml(m) {
  if (!m || m.deleted_at) return '';
  const aggregated = aggregateReactions(m.reactions);
  if (!aggregated.length) return '';
  const chips = aggregated.map((a) =>
    `<button class="msg-reaction-chip${  a.mine ? ' mine' : ''  }" onclick="reactToMessage('${  m.id  }','${  escHtml(a.emoji)  }')">${  a.emoji  }<span class="msg-reaction-count">${  a.count  }</span></button>`
  ).join('');
  return `<div class="msg-reactions" data-reactions-for="${  m.id  }">${  chips  }</div>`;
}

// Re-render only the reaction bar of one already-rendered message (after a
// chat:reaction broadcast or our own optimistic toggle round-trip).
function rerenderMessageReactions(messageId) {
  const m = convMessagesById[messageId];
  const node = document.querySelector(`#chatMessages .msg[data-msgid="${  messageId  }"]`);
  if (!node) return;
  const body = node.querySelector('.msg-body');
  if (!body) return;
  const existing = body.querySelector('.msg-reactions');
  const html = reactionsBarHtml(m);
  if (existing) {
    if (html) { const wrap = document.createElement('div'); wrap.innerHTML = html; existing.replaceWith(wrap.firstElementChild); }
    else existing.remove();
  } else if (html) {
    body.insertAdjacentHTML('beforeend', html);
  }
}

// ── Reaction picker popover ─────────────────────────────────────────────────
function closeReactionPicker() {
  const p = document.getElementById('reactionPicker');
  if (p) p.remove();
}

function openReactionPicker(event, messageId) {
  event.stopPropagation();
  closeReactionPicker();
  const picker = document.createElement('div');
  picker.id = 'reactionPicker';
  picker.className = 'reaction-picker';
  picker.innerHTML = REACTION_EMOJIS.map((e) =>
    `<button class="reaction-picker-emoji" onclick="reactToMessage('${  messageId  }','${  e  }');closeReactionPicker()">${  e  }</button>`
  ).join('');
  document.body.appendChild(picker);

  // Anchor above the clicked button, clamped to the viewport.
  const rect = event.currentTarget.getBoundingClientRect();
  const pw = picker.offsetWidth || 300;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  let top = rect.top - (picker.offsetHeight || 46) - 8;
  if (top < 8) top = rect.bottom + 8;
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;

  setTimeout(() => document.addEventListener('click', closeReactionPicker, { once: true }), 0);
}

function reactToMessage(messageId, emoji) {
  if (!socket || !currentConvId) return;
  socket.emit('chat:react', { conversationId: currentConvId, messageId, emoji }, (res) => {
    if (res && res.error) { showToast(`❌ ${  res.error}`); return; }
    // The room broadcast (chat:reaction) updates the bar; this ack path just
    // covers the rare case the sender isn't in the room echo.
    if (res && res.reactions && convMessagesById[messageId]) {
      convMessagesById[messageId].reactions = res.reactions;
      rerenderMessageReactions(messageId);
    }
  });
}

// Called from socket.js on the chat:reaction broadcast.
function applyReactionUpdate(data) {
  if (data.conversationId !== currentConvId) return;
  if (convMessagesById[data.messageId]) convMessagesById[data.messageId].reactions = data.reactions;
  rerenderMessageReactions(data.messageId);
}

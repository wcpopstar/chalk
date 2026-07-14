// ── EMOJI PICKER (chat inputs) ──────────────────────────────────────────────
// A lightweight, dependency-free emoji panel for the direct-chat and global-
// chat message inputs. Clicking the 😊 button toggles a floating grid; picking
// an emoji inserts it into the target input at the caret and keeps focus so
// you can keep typing. Purely client-side — no backend, the emoji just becomes
// part of the message text.

var EMOJI_LIST = [
  '😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😜', '🤪', '😎', '🤩', '🥳',
  '😏', '😒', '😞', '😔', '😟', '😢', '😭', '😤', '😠', '😡', '🤬', '😱', '😨', '😰', '😳', '🥺',
  '🤔', '🤨', '😐', '😶', '🙄', '😴', '🤤', '😷', '🤒', '🤕', '🤢', '🤮', '🥴', '😵', '🤯', '🤠',
  '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👏', '🙌', '🙏', '💪', '🫡', '👋', '🤙', '☝️', '✍️',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❤️‍🔥', '💕', '💖', '💯', '💢', '💥', '✨',
  '🔥', '🎉', '🎊', '🎁', '🏆', '⭐', '🌟', '⚡', '💎', '🎮', '🕹️', '🎯', '🎲', '🃏', '🎧', '🎵',
  '👀', '🧠', '💀', '👻', '🤖', '👾', '🐱', '🐶', '🦊', '🦁', '🐸', '🐵', '🌚', '🌈', '☀️', '🌙',
  '☕', '🍕', '🍔', '🍟', '🍺', '🍻', '🥤', '🍩', '🍿', '🎂', '💸', '💰', '📌', '✅', '❌', '❓',
];

var _emojiPanel = null;
var _emojiScope = null;

function _emojiTargetInput(scope) {
  return document.getElementById(scope === 'global' ? 'globalChatInput' : 'chatInput');
}

function closeEmojiPicker() {
  if (_emojiPanel) { _emojiPanel.remove(); _emojiPanel = null; _emojiScope = null; }
}

function toggleEmojiPicker(event, scope) {
  event.stopPropagation();
  // Second click on the same scope's button closes it.
  if (_emojiPanel && _emojiScope === scope) { closeEmojiPicker(); return; }
  closeEmojiPicker();
  _emojiScope = scope;

  const panel = document.createElement('div');
  panel.className = 'emoji-picker-panel';
  panel.id = 'emojiPickerPanel';
  panel.innerHTML = EMOJI_LIST.map((e) =>
    `<button type="button" class="emoji-pick" onclick="insertEmoji('${  scope  }','${  e  }')">${  e  }</button>`
  ).join('');
  // Clicking inside the panel must not bubble to the document handler that
  // closes it — so you can pick several emoji in a row.
  panel.addEventListener('click', (ev) => ev.stopPropagation());
  document.body.appendChild(panel);
  _emojiPanel = panel;

  const rect = event.currentTarget.getBoundingClientRect();
  const pw = panel.offsetWidth || 300;
  const ph = panel.offsetHeight || 240;
  let left = Math.min(rect.left, window.innerWidth - pw - 8);
  left = Math.max(8, left);
  let top = rect.top - ph - 8;
  if (top < 8) top = rect.bottom + 8;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;

  setTimeout(() => document.addEventListener('click', closeEmojiPicker, { once: true }), 0);
}

function insertEmoji(scope, emoji) {
  const input = _emojiTargetInput(scope);
  if (!input) return;
  const start = input.selectionStart != null ? input.selectionStart : input.value.length;
  const end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  const caret = start + emoji.length;
  input.focus();
  try { input.setSelectionRange(caret, caret); } catch (_) {}
  // Keep typing indicators / send-button state in sync for the direct chat.
  if (scope !== 'global' && typeof notifyTypingInput === 'function') notifyTypingInput();
}

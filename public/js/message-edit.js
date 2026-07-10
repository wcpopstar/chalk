// ── Inline edit UI ────────────────────────────────────────────────────────
function startEditMessage(scope, messageId, btnEl) {
  const msgNode = btnEl.closest('.msg, .gc-msg');
  if (!msgNode) return;
  const isGlobal = scope === 'global';
  const textEl = msgNode.querySelector(isGlobal ? '.gc-msg-text' : '.msg-text');
  if (!textEl) return;
  const editedTagRe = new RegExp(`\\(${  T('msg_edited_tag').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  }\\)\\s*$`);
  const currentText = textEl.childNodes.length ? (textEl.textContent || '').replace(editedTagRe, '').trim() : '';

  const row = document.createElement('div');
  row.className = 'msg-edit-row';
  row.innerHTML = '<input class="msg-edit-input" value="" /><button class="msg-action-btn" title="Сохранить" data-i18n-title="profile_save">✔️</button><button class="msg-action-btn" title="Отмена" data-i18n-title="status_cancel">✕</button>';
  textEl.replaceWith(row);
  const input = row.querySelector('input');
  input.value = currentText;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const buttons = row.querySelectorAll('.msg-action-btn');
  const saveBtn = buttons[0]; const cancelBtn = buttons[1];
  let saving = false;

  function save() {
    const newText = input.value.trim();
    if (!newText) return cancel();
    if (saving) return;
    saving = true;
    saveBtn.disabled = true;
    function onAck(res) {
      saving = false;
      saveBtn.disabled = false;
      if (res && res.error) {
        showToast(`❌ ${  res.error}`);
        // Leave the edit box open so the person can retry instead of losing their edit.
      }
      // On success the server broadcasts chat:message:edited / global:message:edited,
      // which is what actually swaps this edit row back out for the updated bubble.
    }
    // Re-enable the edit box and (optionally) toast — the shared epilogue
    // for every pre-send failure below.
    function fail(msg) {
      saving = false; saveBtn.disabled = false;
      if (msg) showToast(`❌ ${  msg}`);
    }
    if (isGlobal) {
      socket.emit('global:edit', { messageId, text: newText }, onAck);
      return;
    }
    // An edit must keep the message's own encryption mode (is_encrypted was
    // fixed at insert time and the DB CHECK enforces nonce consistency) —
    // NOT follow the conversation's current state. A plaintext message sent
    // before the partner set up E2EE stays plaintext even after their key
    // appears; an encrypted one stays encrypted. Every editable bubble was
    // registered in convMessagesById when it was rendered, so a miss means
    // the view is genuinely stale (the server double-checks the mode anyway).
    const original = convMessagesById[messageId];
    if (!original) return fail('Сообщение не найдено — обнови чат');
    if (original.is_encrypted) {
      const enc = e2eeEncryptOrToast(newText, currentConvPartner && currentConvPartner.public_key);
      if (!enc) return fail(); // e2eeEncryptOrToast already toasted the reason
      socket.emit('chat:edit', { conversationId: currentConvId, messageId, ciphertext: enc.ciphertext, nonce: enc.nonce }, onAck);
    } else {
      socket.emit('chat:edit', { conversationId: currentConvId, messageId, text: newText }, onAck);
    }
  }
  function cancel() { row.replaceWith(textEl); }

  saveBtn.onclick = save;
  cancelBtn.onclick = cancel;
  input.onkeydown = function(e){ if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); };
}

function deleteMessage(scope, messageId) {
  if (!confirm(T('msg_confirm_delete'))) return;
  function onAck(res) {
    if (res && res.error) showToast(`❌ ${  res.error}`);
  }
  if (scope === 'global') socket.emit('global:delete', { messageId }, onAck);
  else socket.emit('chat:delete', { conversationId: currentConvId, messageId }, onAck);
}

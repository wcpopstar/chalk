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
    if (isGlobal) {
      socket.emit('global:edit', { messageId, text: newText }, onAck);
    } else if (currentConvPartner && currentConvPartner.public_key) {
      // Direct chat — the original was E2E-encrypted, so the edit must be too
      // (see js/e2ee.js). Group chats fall through to the plaintext branch.
      if (!e2eeReady()) { saving = false; saveBtn.disabled = false; showToast('❌ Шифрование ещё не готово, попробуй снова'); return; }
      const enc = e2eeEncrypt(newText, currentConvPartner.public_key);
      if (!enc) { saving = false; saveBtn.disabled = false; showToast('❌ Не удалось зашифровать сообщение'); return; }
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

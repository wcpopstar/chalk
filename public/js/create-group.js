// ── CREATE GROUP ─────────────────────────────────────────────────────────────
var cgSelectedIds = new Set();

async function openCreateGroup() {
  cgSelectedIds = new Set();
  document.getElementById('cgName').value = '';
  document.getElementById('cgError').classList.remove('show');
  document.getElementById('createGroupOverlay').classList.add('show');

  const listEl = document.getElementById('cgFriendList');
  listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px"><span data-i18n="status_loading">Загрузка...</span></div>';

  try {
    const data = await api('/api/friends');
    const accepted = (data.friends || []).filter((f) =>f.status === 'accepted' && f.friend);
    if (!accepted.length) {
      listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px"><span data-i18n="chat_add_friends_first">Сначала добавь друзей, чтобы создать с ними группу</span></div>';
      return;
    }
    listEl.innerHTML = accepted.map((f) =>{
      const fr = f.friend;
      const uname = escHtml(fr.username);
      return `<label class="cg-friend-item"><input type="checkbox" onchange="toggleGroupMember('${  fr.id  }',this.checked)"><div class="chat-ava" style="width:28px;height:28px;font-size:13px">${  avatarHtml(fr.avatar_emoji, fr.avatar_url)  }</div><span class="cg-friend-name">${  uname  }</span></label>`;
    }).join('');
  } catch(e) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px"><span data-i18n="friends_err_load">Не удалось загрузить друзей</span></div>';
  }
}

function closeCreateGroup() {
  document.getElementById('createGroupOverlay').classList.remove('show');
}

function toggleGroupMember(id, checked) {
  if (checked) cgSelectedIds.add(id); else cgSelectedIds.delete(id);
}

function cgShowError(msg) {
  const el = document.getElementById('cgError');
  el.textContent = msg;
  el.classList.add('show');
}

async function createGroupSubmit() {
  const name = document.getElementById('cgName').value.trim();
  if (!cgSelectedIds.size) return cgShowError(T('chat_choose_at_least_one_member'));

  const btn = document.getElementById('cgCreateBtn');
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span>${  T('auth_creating')}`;
  try {
    const data = await api('/api/chats/group', {
      method: 'POST',
      body: JSON.stringify({ name: name || null, memberIds: Array.from(cgSelectedIds) })
    });
    closeCreateGroup();
    switchToChatTab();
    await loadChats();
    openConv(data.conversation.id, data.conversation.name || T('match_group'));
    showToast(`${T('chat_group_created')  } \u2713`);
  } catch(e) {
    cgShowError(e.message || T('chat_err_create_group'));
  } finally {
    btn.disabled = false;
    btn.innerHTML = T('btn_create');
  }
}

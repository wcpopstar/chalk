// ── CHAT LIST ─────────────────────────────────────────────────────────────────
// ── Short preview text for the chat list (handles voice/gif/deleted) ────────
function lastMessagePreview(m) {
  if (!m) return '';
  if (m.deleted_at) return T('msg_deleted_label');
  // The chats-list endpoint returns only is_encrypted (not the nonce/keys
  // needed to decrypt), and we don't have the per-conversation partner key
  // handy here anyway — show a neutral lock placeholder for encrypted DMs.
  if (m.is_encrypted) return '🔒 Сообщение';
  if (m.type === 'voice') return `🎤 ${  T('voice_msg_title')}`;
  if (m.type === 'gif') return '🎞️ GIF';
  if (m.type === 'video_note') return `⭕ ${  T('video_note_title', 'Видеосообщение')}`;
  if (m.type === 'image') return `📷 ${  T('attach_photo', 'Фото')}`;
  if (m.type === 'video') return `🎥 ${  T('attach_video', 'Видео')}`;
  if (m.type === 'file') return `📎 ${  m.text || T('attach_file', 'Файл')}`;
  return (m.text || '').slice(0, 34);
}

var lastConversations = null; // cached for re-render on language change (avoids a refetch)

async function loadChats() {
  try {
    const data = await api('/api/chats');
    lastConversations = data.conversations || [];
    renderChatsList();
  } catch(e) { console.error(e); }
}

// Renders the DM + group lists from the cached conversations. Split out from
// loadChats() so a language switch can re-render the already-loaded list
// (which contains plain-text strings like "Group chat" or "No messages"
// baked in via T()) without needing another API round-trip.
function renderChatsList() {
  const convs = lastConversations;
  if (!convs) return;
  const dms = convs.filter((c) =>c.type === 'direct');
  const groups = convs.filter((c) =>c.type === 'group');

  dmPartnersByConv = {};
  dms.forEach((c) =>{ if (c.other_user) dmPartnersByConv[c.id] = c.other_user; });
  convs.forEach((c) => { convE2eeById[c.id] = Boolean(c.e2ee_enabled); });

  document.getElementById('dmList').innerHTML = dms.length ? dms.map((c) =>{
    const last = c.last_message;
    const sub = last ? escHtml(lastMessagePreview(last)) : T('chat_no_messages');
    const time = last && last.created_at ? formatChatTime(last.created_at) : '';
    const online = c.online ? ' ci-online' : '';
    const dmName = c.other_user ? (c.other_user.username || T('status_user')) : (c.name || T('status_user'));
    const dmAva = c.other_user ? avatarHtml(c.other_user.avatar_emoji, c.other_user.avatar_url) : '👤';
    const mutedIco = c.muted ? `<span class="chat-muted-ico" title="${  T('chat_muted_toast')  }">🔕</span>` : '';
    return `<div class="chat-item${  online  }" data-convid="${  c.id  }" onclick="openConv('${  c.id  }','${  dmName.replace(/'/g,"\\'")  }')"><div class="chat-ava">${  dmAva  }</div><div class="chat-item-body"><div class="chat-item-toprow"><div class="chat-name">${  escHtml(dmName)  }${  mutedIco  }</div>${  time ? `<div class="chat-item-time">${  time  }</div>` : ''  }</div><div class="chat-sub">${  sub  }</div></div><button class="chat-item-menu-btn" title="${  T('chat_options_title')  }" onclick="event.stopPropagation();openChatItemMenu(event,'${  c.id  }')">⋯</button></div>`;
  }).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px"><span data-i18n="chat_no_dialogs">Нет диалогов</span></div>';

  document.getElementById('groupList').innerHTML = groups.length ? groups.map((c) =>{
    const mutedIco = c.muted ? `<span class="chat-muted-ico" title="${  T('chat_muted_toast')  }">🔕</span>` : '';
    return `<div class="chat-item" data-convid="${  c.id  }" onclick="openConv('${  c.id  }','${  (c.name || T('match_group')).replace(/'/g,"\\'")  }')"><div class="chat-ava-group">👥</div><div class="chat-item-body"><div class="chat-item-toprow"><div class="chat-name">${  c.name || T('match_group')  }${  mutedIco  }</div></div><div class="chat-sub"><span data-i18n="match_group_chat">Групповой чат</span></div></div><button class="chat-item-menu-btn" title="${  T('chat_options_title')  }" onclick="event.stopPropagation();openChatItemMenu(event,'${  c.id  }')">⋯</button></div>`;
  }).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px"><span data-i18n="chat_no_groups">Нет групп</span></div>';
}

// ── Per-chat context menu: mute / delete-for-me / delete-for-both ────────────
function isConversationMuted(convId) {
  const c = (lastConversations || []).find((x) => x.id === convId);
  return Boolean(c && c.muted);
}

function closeChatItemMenu() {
  const m = document.getElementById('chatCtxMenu');
  if (m) m.remove();
}

function openChatItemMenu(ev, convId) {
  ev.stopPropagation();
  closeChatItemMenu();
  const conv = (lastConversations || []).find((c) => c.id === convId);
  if (!conv) return;
  const isDirect = conv.type === 'direct';
  const menu = document.createElement('div');
  menu.className = 'chat-ctx-menu';
  menu.id = 'chatCtxMenu';
  const muteBtn = `<button onclick="toggleMuteConversation('${convId}')">${conv.muted ? `🔔 ${T('chat_unmute')}` : `🔕 ${T('chat_mute')}`}</button>`;
  const selfBtn = `<button onclick="deleteConversationChat('${convId}','self')">🗑 ${T('chat_delete_for_me')}</button>`;
  const bothBtn = isDirect ? `<button class="danger" onclick="deleteConversationChat('${convId}','both')">🗑 ${T('chat_delete_for_both')}</button>` : '';
  menu.innerHTML = `${muteBtn}${selfBtn}${bothBtn}`;
  document.body.appendChild(menu);
  const x = ev.clientX; const y = ev.clientY;
  menu.style.left = `${  Math.min(x, window.innerWidth - 210)  }px`;
  menu.style.top = `${  Math.min(y, window.innerHeight - 150)  }px`;
  setTimeout(() => document.addEventListener('click', closeChatItemMenu, { once: true }), 0);
}

async function toggleMuteConversation(convId) {
  closeChatItemMenu();
  const conv = (lastConversations || []).find((c) => c.id === convId);
  if (!conv) return;
  const next = !conv.muted;
  try {
    await api(`/api/chats/${  convId  }/mute`, { method: 'PATCH', body: JSON.stringify({ muted: next }) });
    conv.muted = next;
    renderChatsList();
    showToast(next ? T('chat_muted_toast') : T('chat_unmuted_toast'));
  } catch (e) { showToast(`${T('err_generic')  } ${  e.message}`); }
}

async function deleteConversationChat(convId, mode) {
  closeChatItemMenu();
  const conv = (lastConversations || []).find((c) => c.id === convId);
  const partner = conv && conv.other_user ? (conv.other_user.username || T('default_user_word')) : T('default_user_word');
  const msg = mode === 'both'
    ? T('chat_confirm_delete_both').replace('{name}', partner)
    : T('chat_confirm_delete_self');
  if (!confirm(msg)) return;
  try {
    await api(`/api/chats/${  convId  }?mode=${  mode}`, { method: 'DELETE' });
    onConversationDeleted(convId);
    showToast(T('chat_deleted_toast'));
  } catch (e) { showToast(`${T('err_generic')  } ${  e.message}`); }
}

// Drop a conversation from the local list + close it if it's open. Reused by
// the delete action above and the chat:deleted socket event (partner deleted
// a direct chat for both of us).
function onConversationDeleted(convId) {
  lastConversations = (lastConversations || []).filter((c) => c.id !== convId);
  renderChatsList();
  if (typeof currentConvId !== 'undefined' && currentConvId === convId && typeof closeConv === 'function') closeConv();
}

function formatChatTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return `${d.getHours().toString().padStart(2,'0')  }:${  d.getMinutes().toString().padStart(2,'0')}`;
    }
    return `${(`${d.getDate()}`).padStart(2,'0')  }.${  (`${d.getMonth()+1}`).padStart(2,'0')}`;
  } catch(_) { return ''; }
}

function filterChatList(q) {
  const raw = q.trim();
  const ql = raw.toLowerCase();
  // 1. Local filter by DM partner name / group name (data already loaded).
  document.querySelectorAll('#dmList .chat-item, #groupList .chat-item').forEach((item) =>{
    const name = (item.querySelector('.chat-name') || {}).textContent || '';
    item.style.display = name.toLowerCase().indexOf(ql) !== -1 ? '' : 'none';
  });
  // 2. Debounced server-side search inside message bodies.
  scheduleMessageSearch(raw);
}

var _msgSearchTimer = null;
var _msgSearchSeq = 0;
function scheduleMessageSearch(q) {
  clearTimeout(_msgSearchTimer);
  const section = document.getElementById('msgSearchResultsSection');
  if (q.length < 2) { if (section) section.style.display = 'none'; return; }
  _msgSearchTimer = setTimeout(() =>{ runMessageSearch(q); }, 280);
}

async function runMessageSearch(q) {
  const section = document.getElementById('msgSearchResultsSection');
  const list = document.getElementById('msgSearchResults');
  if (!section || !list) return;
  const seq = ++_msgSearchSeq;
  try {
    const data = await api(`/api/chats/search?q=${  encodeURIComponent(q)}`);
    if (seq !== _msgSearchSeq) return; // a newer query superseded this one
    const results = data.results || [];
    section.style.display = results.length ? '' : 'none';
    if (!results.length) { list.innerHTML = ''; return; }
    list.innerHTML = results.map((m) =>{
      const conv = (lastConversations || []).find((c) =>c.id === m.conversation_id);
      const convName = conv
        ? (conv.other_user ? (conv.other_user.username || T('status_user')) : (conv.name || T('match_group')))
        : T('status_user');
      const who = (m.sender && m.sender.username) || '';
      const snippet = highlightMatch((m.text || '').slice(0, 80), q);
      const time = m.created_at ? formatChatTime(m.created_at) : '';
      const nameJs = convName.replace(/'/g, "\\'");
      return `<div class="chat-item msg-search-result" onclick="openConvToMessage('${  m.conversation_id  }','${  nameJs  }','${  escHtml(m.id)  }')">` +
        `<div class="chat-ava">🔎</div><div class="chat-item-body"><div class="chat-item-toprow">` +
        `<div class="chat-name">${  escHtml(convName)  }</div>${  time ? `<div class="chat-item-time">${  time  }</div>` : ''  }</div>` +
        `<div class="chat-sub">${  who ? `${escHtml(who)  }: ` : ''  }${snippet  }</div></div></div>`;
    }).join('');
  } catch (e) { console.error(e); }
}

function highlightMatch(text, q) {
  const esc = escHtml(text);
  try {
    const re = new RegExp(`(${  q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  })`, 'ig');
    return esc.replace(re, '<mark>$1</mark>');
  } catch (_) { return esc; }
}

// Opens a conversation and, once its history has loaded, scrolls to & flashes
// the matched message.
async function openConvToMessage(convId, name, messageId) {
  await openConv(convId, name);
  setTimeout(() =>{ if (typeof scrollToMsg === 'function') scrollToMsg(messageId); }, 350);
}

function switchToChatTab() {
  document.querySelectorAll('.page').forEach((p) =>{ p.classList.remove('active') });
  document.querySelectorAll('.nav-tab').forEach((t) =>{ t.classList.remove('active') });
  document.getElementById('page-chat').classList.add('active');
  document.querySelectorAll('.nav-tab')[2].classList.add('active');
  document.getElementById('globalChatBubble').style.display = 'none';
  const panel = document.getElementById('globalChatPanel');
  if (panel) panel.style.display = 'none';
}

// ── Saved Messages (a self-conversation, Telegram-style) ────────────────────
// Get-or-create the current user's saved conversation, then open it like any
// other chat. Forwarding a message to it, jotting a note, sending a voice/
// video note — all reuse the normal conversation pipeline.
async function openSavedMessages() {
  try {
    const data = await api('/api/chats/saved', { method: 'POST' });
    switchToChatTab();
    // The saved conversation is its own thing (not in the DM/group lists), so
    // no loadChats() refresh is needed — just open it directly.
    currentConvPartner = null;
    dmPartnersByConv[data.conversation.id] = null;
    openConv(data.conversation.id, T('saved_messages_title', 'Избранное'));
    // openConv defaults a partner-less chat to a 👥 group icon; give the
    // saved conversation its own bookmark identity instead (this runs after
    // openConv's synchronous header setup).
    const avaEl = document.getElementById('chatHeaderAva');
    if (avaEl) avaEl.innerHTML = '🔖';
    const stEl = document.getElementById('chatHeaderStatus');
    if (stEl) { stEl.classList.remove('chat-activity'); stEl.textContent = T('saved_messages_sub', 'Заметки и пересланное себе'); }
  } catch (e) { showToast(`${T('err_generic')  } ${  e.message}`); }
}

async function openDM(userId, username, emoji) {
  try {
    const data = await api('/api/chats/direct', { method: 'POST', body: JSON.stringify({ targetUserId: userId }) });
    switchToChatTab();
    await loadChats();
    openConv(data.conversation.id, username);
  } catch(e) { showToast(`${T('err_generic')  } ${  e.message}`); }
}

// Jump straight into the main chat after a trial/full call. If the server
// already created the conversation (mutual "yes" vote), reuse it; otherwise
// fall back to opening/creating a DM with the first participant.
async function goToChatAfterCall() {
  try {
    clearTimeout(window._trialPromoteTimeout);
    document.getElementById('trialOverlay').classList.remove('show');
    document.getElementById('fullCallOverlay').classList.remove('show');
    document.getElementById('postCallOverlay').classList.remove('show');

    const name = currentCallParticipants.length === 1
      ? participantDisplayName(currentCallParticipants[0])
      : T('match_group');

    if (pendingChatConversationId) {
      switchToChatTab();
      await loadChats();
      openConv(pendingChatConversationId, name);
    } else if (currentCallParticipants.length === 1) {
      await openDM(currentCallParticipants[0].id, name, currentCallParticipants[0].avatar_emoji);
    } else {
      showToast(T('chat_not_available_for_group'));
    }
  } catch(e) { showToast(`${T('err_generic')  } ${  e.message}`); }
}

// Refreshes the direct-chat partner's profile (most importantly their E2EE
// public_key) from GET /api/chats/:id/members. Called when the cached
// snapshot has no key — the partner may have just logged in for the first
// time since E2EE shipped and generated one. Fired from openConv() and from
// every plaintext-fallback send (chat-send.js), so it dedups in-flight
// requests per conversation.
var _partnerKeyRefreshInFlight = {};
async function refreshPartnerKey(convId) {
  if (_partnerKeyRefreshInFlight[convId]) return;
  _partnerKeyRefreshInFlight[convId] = true;
  try {
    const data = await api(`/api/chats/${  convId  }/members`);
    const other = (data.members || []).find((u) => u && u.id !== currentUser.id);
    if (!other || !other.public_key) return;
    dmPartnersByConv[convId] = other;
    // Only touch the live conversation if it's still the same one by the
    // time the response lands.
    if (currentConvId === convId) currentConvPartner = other;
  } catch (_) { /* non-fatal: sends just keep using the cached (key-less) snapshot */
  } finally { delete _partnerKeyRefreshInFlight[convId]; }
}

async function openConv(convId, name) {
  currentConvId = convId;
  currentConvPartner = dmPartnersByConv[convId] || null;
  document.querySelectorAll('.chat-item').forEach((i) =>{ i.classList.remove('active') });
  const activeItem = document.querySelector(`.chat-item[data-convid="${  convId  }"]`);
  if (activeItem) activeItem.classList.add('active');

  const layout = document.querySelector('.chat-layout');
  if (layout) layout.classList.add('show-chat');

  document.getElementById('chatHeader').style.display = 'flex';
  document.getElementById('chatHeaderName').textContent = currentConvPartner ? currentConvPartner.username : name;
  if (typeof updateChatHeaderPresence === 'function') updateChatHeaderPresence();
  else document.getElementById('chatHeaderStatus').textContent = currentConvPartner ? (currentConvPartner.status === 'online' ? T('status_online_lc') : T('status_offline_lc')) : T('match_group_chat');
  document.getElementById('chatHeaderAva').innerHTML = currentConvPartner ? avatarHtml(currentConvPartner.avatar_emoji, currentConvPartner.avatar_url) : '👥';
  // Reset per-conversation UI (pinned banner + background) until the
  // /messages response tells us the real values for this chat.
  resetConvExtrasUI();
  document.getElementById('chatInputRow').style.display = 'flex';
  const callBtn = document.querySelector('.call-btn-inline');
  if (callBtn) callBtn.style.display = currentConvPartner ? '' : 'none';

  // Lock button + send path: snapshot from the chats list now, refreshed
  // from the /messages response below (the partner may have toggled the
  // lock while this client was elsewhere).
  currentConvE2ee = Boolean(convE2eeById[convId]);
  updateE2eeToggleBtn();

  if (socket) {
    socket.emit('chat:join', { conversationId: convId });
  }

  // The partner's E2EE public key in dmPartnersByConv is a snapshot from
  // whenever the chats list was loaded. If they set up encryption AFTER that
  // (first login since E2EE shipped), the snapshot says "no key" and sends
  // would keep falling back to plaintext — so re-fetch the members on every
  // open (fire-and-forget; sends check the key at click time anyway).
  if (currentConvPartner && !currentConvPartner.public_key) refreshPartnerKey(convId);

  // Fresh conversation: reset per-conversation UI state.
  if (typeof clearReply === 'function') clearReply();
  partnerLastReadAt = null;
  convMessagesById = {};

  try {
    const data = await api(`/api/chats/${  convId  }/messages`);
    // Fresher than the chats-list snapshot — adopt it (guard against the
    // response landing after the user already switched conversations).
    if (typeof data.e2ee_enabled === 'boolean' && currentConvId === convId) {
      convE2eeById[convId] = data.e2ee_enabled;
      currentConvE2ee = data.e2ee_enabled;
      updateE2eeToggleBtn();
    }
    // Apply this member's saved wallpaper + the pinned message banner (guard
    // against the response landing after the user switched conversations).
    if (currentConvId === convId) applyConvExtras(data);
    const msgs = data.messages || [];
    // The partner's read watermark — own messages older than it render ✓✓.
    (data.reads || []).forEach((r) => {
      if (r.user_id !== currentUser.id && r.last_read_at) {
        if (!partnerLastReadAt || r.last_read_at > partnerLastReadAt) partnerLastReadAt = r.last_read_at;
      }
    });
    msgs.forEach((m) => { convMessagesById[m.id] = m; });
    const el = document.getElementById('chatMessages');
    if (!msgs.length) { el.innerHTML = '<div class="empty-chat"><div style="font-size:32px">💬</div><span data-i18n="chat_start_dialog">Начни диалог!</span></div>'; }
    else {
      el.innerHTML = (typeof chatHistoryHtml === 'function') ? chatHistoryHtml(msgs) : msgs.map((m) =>chatMsgHtml(m)).join('');
      el.scrollTop = el.scrollHeight;
      if (typeof updateChatDateFloat === 'function') updateChatDateFloat();
    }
    // Everything on screen is now read from OUR side — tell the sender(s).
    if (socket) socket.emit('chat:read', { conversationId: convId });
  } catch(e) { console.error(e); }
}

function closeConv() {
  const layout = document.querySelector('.chat-layout');
  if (layout) layout.classList.remove('show-chat');
  currentConvId = null;
  currentConvPartner = null;
  currentConvE2ee = false;
  if (typeof renderPinnedBanner === 'function') renderPinnedBanner(null);
  if (typeof applyChatBackground === 'function') applyChatBackground('none');
}

// ── E2EE toggle (the lock button next to message search) ────────────────────
// Conversations start unencrypted; either member of a direct chat can flip
// end-to-end encryption on/off for the whole conversation. The button state
// actually changes on the server's chat:e2ee broadcast (see socket.js), not
// optimistically — both members' UIs flip at the same moment.
function updateE2eeToggleBtn() {
  const btn = document.getElementById('e2eeToggleBtn');
  if (!btn) return;
  if (!currentConvPartner) { btn.style.display = 'none'; return; } // groups: no E2EE yet
  btn.style.display = '';
  btn.textContent = currentConvE2ee ? '🔒' : '🔓';
  btn.classList.toggle('e2ee-on', currentConvE2ee);
  btn.title = T(currentConvE2ee ? 'e2ee_btn_on_title' : 'e2ee_btn_off_title');
}

async function toggleConvE2ee() {
  if (!socket || !currentConvId || !currentConvPartner) return;
  const convId = currentConvId;
  const enable = !currentConvE2ee;

  if (enable) {
    if (!e2eeReady()) { showToast(`❌ ${  T('e2ee_not_ready')}`); return; }
    // The cached partner snapshot may predate their first key — refresh once
    // before giving up (the server re-checks anyway).
    if (!currentConvPartner.public_key) await refreshPartnerKey(convId);
    if (!currentConvPartner.public_key) { showToast(`🔓 ${  T('e2ee_partner_no_key')}`); return; }
  }

  socket.emit('chat:e2ee', { conversationId: convId, enabled: enable }, (res) => {
    if (res && res.error) { showToast(`❌ ${  res.error}`); return; }
    // Fresh partner key from the server — the next send can encrypt without
    // waiting for a members refetch. State/UI flip on the room broadcast.
    if (res && res.partnerPublicKey) {
      if (dmPartnersByConv[convId]) dmPartnersByConv[convId].public_key = res.partnerPublicKey;
      if (currentConvId === convId && currentConvPartner) currentConvPartner.public_key = res.partnerPublicKey;
    }
  });
}

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
    return `<div class="chat-item${  online  }" data-convid="${  c.id  }" onclick="openConv('${  c.id  }','${  dmName.replace(/'/g,"\\'")  }')"><div class="chat-ava">${  dmAva  }</div><div class="chat-item-body"><div class="chat-item-toprow"><div class="chat-name">${  escHtml(dmName)  }</div>${  time ? `<div class="chat-item-time">${  time  }</div>` : ''  }</div><div class="chat-sub">${  sub  }</div></div></div>`;
  }).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px"><span data-i18n="chat_no_dialogs">Нет диалогов</span></div>';

  document.getElementById('groupList').innerHTML = groups.length ? groups.map((c) =>`<div class="chat-item" data-convid="${  c.id  }" onclick="openConv('${  c.id  }','${  (c.name || T('match_group')).replace(/'/g,"\\'")  }')"><div class="chat-ava-group">👥</div><div class="chat-item-body"><div class="chat-item-toprow"><div class="chat-name">${  c.name || T('match_group')  }</div></div><div class="chat-sub"><span data-i18n="match_group_chat">Групповой чат</span></div></div></div>`).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px"><span data-i18n="chat_no_groups">Нет групп</span></div>';
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
  q = q.trim().toLowerCase();
  document.querySelectorAll('#dmList .chat-item, #groupList .chat-item').forEach((item) =>{
    const name = (item.querySelector('.chat-name') || {}).textContent || '';
    item.style.display = name.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
  });
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
  document.getElementById('chatHeaderStatus').textContent = currentConvPartner ? (currentConvPartner.status === 'online' ? T('status_online_lc') : T('status_offline_lc')) : T('match_group_chat');
  document.getElementById('chatHeaderAva').innerHTML = currentConvPartner ? avatarHtml(currentConvPartner.avatar_emoji, currentConvPartner.avatar_url) : '👥';
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
      el.innerHTML = msgs.map((m) =>chatMsgHtml(m)).join('');
      el.scrollTop = el.scrollHeight;
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

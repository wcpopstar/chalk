// ── FRIENDS LIST ────────────────────────────────────────────────────────────
var friendCallStatus = {};   // friendId -> { inCall, roomSize }
var lastOnlineFriends = [];  // cached for re-render on status push

async function loadFriends() {
  try {
    var data = await api('/api/friends');
    var all = data.friends || [];

    // Incoming pending requests (someone sent me a request)
    var incoming = all.filter(function(f){ return f.status === 'pending' && f.incoming === true; });
    renderFriendRequests(incoming);

    currentFriendIds = new Set((all || []).filter(function(f){ return f.status === 'accepted'; }).map(function(f){ return String(f.friend && f.friend.id); }).filter(Boolean));
    lastOnlineFriends = all
      .filter(function(f){ return f.status === 'accepted' && f.friend; })
      .sort(function(a,b){ return (b.friend.status === 'online') - (a.friend.status === 'online'); });
    renderFriendsList();

    if (socket) {
      socket.emit('friends:call_status', {}, function(status) {
        friendCallStatus = status || {};
        renderFriendsList();
      });
    }
  } catch(e) { console.error(e); }
}

function renderFriendsList() {
  var el = document.getElementById('friendsList');
  var online = lastOnlineFriends;
  if (!online.length) { el.innerHTML = '<div style="font-size:11px;color:var(--muted)"><span data-i18n="friends_none_yet">Пока нет друзей</span></div>'; return; }
  el.innerHTML = online.map(function(f){
    var isOnline = f.friend.status === 'online';
    var cs = isOnline ? (friendCallStatus[f.friend.id] || { inCall: false, roomSize: 0 }) : { inCall: false, roomSize: 0 };
    var statusLine = !isOnline ? '○ ' + T('status_offline') : (cs.inCall ? ('🔊 ' + T('match_call_in_progress') + ' · ' + cs.roomSize + ' ' + T('unit_people_dot')) : '● ' + T('status_online'));
    var rowClass = !isOnline ? 'friend-item friend-offline' : (cs.inCall ? 'friend-item friend-incall' : 'friend-item friend-online');
    var uname = escHtml(f.friend.username).replace(/'/g,"\\'");
    var emoji = (f.friend.avatar_emoji || '🎮');
    return '<div class="' + rowClass + '" onclick="openFriendMenu(event,\'' + f.friend.id + '\',\'' + uname + '\',\'' + emoji + '\',' + !!cs.inCall + ',' + (cs.roomSize||0) + ')"><div class="friend-ava" style="background:linear-gradient(135deg,#7c3aed,#ec4899)">' + avatarHtml(f.friend.avatar_emoji, f.friend.avatar_url) + '</div><div><div class="friend-name">' + escHtml(f.friend.username) + '</div><div class="friend-game">' + statusLine + '</div></div></div>';
  }).join('');
}

// ── Friend context menu: Позвонить / Написать / Профиль ────────────────────
var famTarget = null;

function openFriendMenu(e, id, username, emoji, inCall, roomSize) {
  e.stopPropagation();
  famTarget = { id: id, username: username, emoji: emoji, inCall: inCall, roomSize: roomSize };

  var menu = document.getElementById('friendActionMenu');
  var callLabel = inCall ? ('🔊 ' + T('btn_join') + ' (' + roomSize + ')') : '📞 ' + T('btn_call');
  menu.innerHTML =
    '<div class="fam-item" onclick="famCall()">' + callLabel + '</div>' +
    '<div class="fam-item" onclick="famMessage()">\ud83d\udcac ' + T('btn_write') + '</div>' +
    '<div class="fam-item" onclick="famProfile()">\ud83d\udc64 ' + T('profile_title') + '</div>' +
    '<div class="fam-divider"></div>' +
    '<div class="fam-item fam-danger" onclick="famUnfriend()">\ud83d\udeab ' + T('fam_unfriend') + '</div>' +
    '<div class="fam-item fam-danger" onclick="famBlock()">\u26d4 ' + T('fam_block') + '</div>' +
    '<div class="fam-item fam-danger" onclick="famReport()">\ud83d\udea9 ' + T('fam_report') + '</div>';

  var rect = e.currentTarget.getBoundingClientRect();
  menu.style.display = 'block';
  var top = rect.bottom + 4;
  var left = rect.left;
  if (left + 190 > window.innerWidth) left = window.innerWidth - 200;
  if (top + 260 > window.innerHeight) top = rect.top - 260;
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
}

document.addEventListener('click', function() {
  var m = document.getElementById('friendActionMenu');
  if (m) m.style.display = 'none';
  closeUserVolumeMenu();
});

function famCall() {
  if (!famTarget) return;
  document.getElementById('friendActionMenu').style.display = 'none';
  callFriend(famTarget.id, famTarget.username, famTarget.emoji, famTarget.inCall, famTarget.roomSize);
}
function famMessage() {
  if (!famTarget) return;
  document.getElementById('friendActionMenu').style.display = 'none';
  openDM(famTarget.id, famTarget.username, famTarget.emoji);
}
function famProfile() {
  if (!famTarget) return;
  document.getElementById('friendActionMenu').style.display = 'none';
  openUserProfilePopup(famTarget.id);
}
function famUnfriend() {
  if (!famTarget) return;
  document.getElementById('friendActionMenu').style.display = 'none';
  unfriendUser(famTarget.id, famTarget.username);
}
function famBlock() {
  if (!famTarget) return;
  document.getElementById('friendActionMenu').style.display = 'none';
  blockUserAction(famTarget.id, famTarget.username);
}
function famReport() {
  if (!famTarget) return;
  document.getElementById('friendActionMenu').style.display = 'none';
  openReportModal(famTarget.id, famTarget.username);
}

function callFriend(id, username, emoji, inCall, roomSize) {
  if (!socket) return;
  if (inCall) {
    socket.emit('call:request_join', { targetUserId: id });
    showToast('📞 ' + T('call_join_request_sent') + ' — ' + username + '...');
  } else {
    var roomId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('r-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    currentRoomId = roomId;
    currentCallParticipants = [{ id: id, username: username, avatar_emoji: emoji }];
    socket.emit('call:invite', { targetUserId: id, roomId: roomId });
    showToast('📞 ' + T('call_calling') + ' ' + username + '...');
  }
}

// ── Pending friend requests panel ───────────────────────────────────────────
var pendingFriendRequests = [];

function renderFriendRequests(requests) {
  pendingFriendRequests = requests || [];
  var count = pendingFriendRequests.length;

  var dotBadge = document.getElementById('friendReqBadge');
  if (dotBadge) {
    if (count > 0) { dotBadge.textContent = '+' + count; dotBadge.style.display = 'flex'; }
    else { dotBadge.style.display = 'none'; }
  }

  var tabBadge = document.getElementById('afTabBadge');
  if (tabBadge) {
    if (count > 0) { tabBadge.textContent = count; tabBadge.style.display = 'inline-block'; }
    else { tabBadge.style.display = 'none'; }
  }

  var listEl = document.getElementById('afRequestsList');
  if (!listEl) return;
  if (!count) { listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 4px"><span data-i18n="friends_no_new_requests">Нет новых заявок</span></div>'; return; }
  listEl.innerHTML = pendingFriendRequests.map(function(f){
    return '<div class="friend-request-item"><div class="friend-ava" style="background:linear-gradient(135deg,#7c3aed,#ec4899)">' + avatarHtml(f.friend.avatar_emoji, f.friend.avatar_url) + '</div><div><div class="friend-name">' + escHtml(f.friend.username) + '</div></div><div class="friend-request-actions"><button class="fr-accept-btn" onclick="acceptFriendRequest(\'' + f.id + '\')" title="Принять" data-i18n-title="friends_accept">✓</button><button class="fr-decline-btn" onclick="declineFriendRequest(\'' + f.id + '\')" title="Отклонить" data-i18n-title="friends_decline">✕</button></div></div>';
  }).join('');
}

async function acceptFriendRequest(requestId) {
  try {
    await api('/api/friends/' + requestId + '/accept', { method: 'PATCH' });
    showToast(T('friends_request_accepted') + ' \u2713');
    loadFriends();
  } catch(e) { showToast(e.message); }
}

async function declineFriendRequest(requestId) {
  try {
    await api('/api/friends/' + requestId, { method: 'DELETE' });
    loadFriends();
  } catch(e) { showToast(e.message); }
}

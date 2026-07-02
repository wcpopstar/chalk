// ── RATING MODAL ─────────────────────────────────────────────────────────────
var ratingQueue = [];        // [{ p, matchId }]
var ratingQueueIndex = 0;
var ratingSelectedStars = 0;
var ratingSubmittedCount = 0;

function rateParticipantsAfterCall() {
  var pts = currentCallParticipants || [];
  ratingQueue = pts
    .filter(function(p){ return !participantIsAlreadyFriend(p); }) // друзей оценивать не нужно
    .map(function(p){
      var pid = getParticipantId(p);
      return { p: p, matchId: pid ? currentCallMatchIds[pid] : null };
    })
    .filter(function(item){ return !!item.matchId; });

  if (!ratingQueue.length) {
    showToast(T('call_all_already_friends') + ' \u2014 ' + T('rating_no_rating_needed'));
    return;
  }

  ratingQueueIndex = 0;
  ratingSubmittedCount = 0;
  document.getElementById('ratingModalOverlay').classList.add('show');
  renderRatingCandidate();
}

function renderRatingCandidate() {
  var item = ratingQueue[ratingQueueIndex];
  if (!item) { finishRatingFlow(); return; }

  var p = item.p;
  document.getElementById('ratingModalProgress').textContent = (ratingQueueIndex + 1) + ' ' + T('unit_from') + ' ' + ratingQueue.length;
  document.getElementById('ratingModalAva').innerHTML = participantAvatarHtml(p);
  document.getElementById('ratingModalName').textContent = participantDisplayName(p);
  setRatingStars(0);
}

function setRatingStars(n) {
  ratingSelectedStars = n;
  document.querySelectorAll('#ratingStars .rating-star').forEach(function(star){
    star.classList.toggle('active', parseInt(star.dataset.star, 10) <= n);
  });
  document.getElementById('ratingModalSubmitBtn').disabled = n < 1;
}

async function submitCurrentRating() {
  var item = ratingQueue[ratingQueueIndex];
  if (!item || ratingSelectedStars < 1) return;
  var btn = document.getElementById('ratingModalSubmitBtn');
  btn.disabled = true;
  try {
    await api('/api/match/' + item.matchId + '/rate', { method: 'POST', body: JSON.stringify({ rating: ratingSelectedStars, comment: '' }) });
    ratingSubmittedCount++;
  } catch (e) {
    showToast(T('rating_err_save') + ' ' + e.message);
  }
  ratingQueueIndex++;
  renderRatingCandidate();
}

function skipCurrentRating() {
  ratingQueueIndex++;
  renderRatingCandidate();
}

function finishRatingFlow() {
  document.getElementById('ratingModalOverlay').classList.remove('show');
  showToast(ratingSubmittedCount ? T('rating_saved_for') + ' ' + ratingSubmittedCount + ' ' + T('unit_players_gen') : T('rating_not_saved'));
  closePostCall();
}

// ── FRIENDS ───────────────────────────────────────────────────────────────────
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

// ── PER-PARTICIPANT VOLUME (in-call) ───────────────────────────────────────
var uvmTarget = null;

function callParticipantVolumeOf(userId) {
  if (window.getUserVolume) {
    try { return window.getUserVolume(userId); } catch (_) { return 100; }
  }
  return 100;
}

function openUserVolumeMenu(e, userId, username) {
  e.stopPropagation();
  if (!userId) return;
  uvmTarget = { id: userId, username: username || T('games_player') };

  var current = callParticipantVolumeOf(userId);
  var menu = document.getElementById('userVolumeMenu');
  if (!menu) return;

  menu.innerHTML =
    '<div class="uvm-name">🔊 ' + escHtml(uvmTarget.username) + '</div>' +
    '<div class="uvm-row">' +
      '<span class="uvm-icon" onclick="uvmSetVolume(0)" title="Выключить" data-i18n-title="mute_title">🔈</span>' +
      '<input type="range" class="uvm-slider" id="uvmSlider" min="0" max="200" step="5" value="' + current + '" oninput="uvmOnSlide(this.value)">' +
      '<span class="uvm-icon" onclick="uvmSetVolume(200)" title="Максимум" data-i18n-title="match_max_label">🔊</span>' +
    '</div>' +
    '<div class="uvm-value" id="uvmValue" style="width:auto;text-align:center;margin-top:4px">' + current + '%</div>' +
    '<div class="uvm-reset" onclick="uvmSetVolume(100)"><span data-i18n="volume_reset_100">Сбросить до 100%</span></div>';

  var rect = e.currentTarget.getBoundingClientRect();
  menu.style.display = 'block';
  var top = rect.bottom + 6;
  var left = rect.left;
  if (left + 200 > window.innerWidth) left = window.innerWidth - 210;
  if (top + 130 > window.innerHeight) top = rect.top - 130;
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
}

function closeUserVolumeMenu() {
  var menu = document.getElementById('userVolumeMenu');
  if (menu) menu.style.display = 'none';
  uvmTarget = null;
}

function uvmOnSlide(val) {
  uvmSetVolume(val, true);
}

function uvmSetVolume(val, fromSlider) {
  if (!uvmTarget) return;
  var v = Math.max(0, Math.min(200, parseInt(val, 10) || 0));
  if (window.setUserVolume) window.setUserVolume(uvmTarget.id, v);

  var slider = document.getElementById('uvmSlider');
  if (slider && !fromSlider) slider.value = v;
  var label = document.getElementById('uvmValue');
  if (label) label.textContent = v + '%';
}


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

// ── UNFRIEND / BLOCK / REPORT (shared by the friend menu and the profile popup) ─
async function unfriendUser(userId, username) {
  var row = (lastOnlineFriends || []).find(function(f){ return f.friend && String(f.friend.id) === String(userId); });
  if (!confirm(T('confirm_unfriend').replace('{name}', username || T('default_user_word')))) return;
  try {
    if (row) {
      await api('/api/friends/' + row.id, { method: 'DELETE' });
    } else {
      // Fallback: look the pair up via a fresh /api/friends call in case
      // the local cache is stale (e.g. triggered straight from the profile popup).
      var data = await api('/api/friends');
      var match = (data.friends || []).find(function(f){ return f.friend && String(f.friend.id) === String(userId); });
      if (match) await api('/api/friends/' + match.id, { method: 'DELETE' });
    }
    showToast(T('msg_unfriended'));
    loadFriends();
    closeUserProfilePopup();
  } catch(e) { showToast(T('err_generic') + ' ' + e.message); }
}

async function blockUserAction(userId, username) {
  if (!confirm(T('confirm_block').replace('{name}', username || T('default_user_word')))) return;
  try {
    await api('/api/users/' + userId + '/block', { method: 'POST' });
    showToast('🚫 ' + T('msg_user_blocked'));
    loadFriends();
    closeUserProfilePopup();
    if (currentConvPartner && String(currentConvPartner.id) === String(userId)) closeConv();
  } catch(e) { showToast(T('err_generic') + ' ' + e.message); }
}

async function unblockUserAction(userId, username) {
  try {
    await api('/api/users/' + userId + '/block', { method: 'DELETE' });
    showToast(T('blocked_unblocked_msg') + ' ' + (username || ''));
    loadBlockedUsers();
  } catch(e) { showToast(T('err_generic') + ' ' + e.message); }
}

// ── REPORT MODAL ──────────────────────────────────────────────────────────
var reportTarget = null;

function openReportModal(userId, username) {
  reportTarget = { id: userId, username: username || T('default_user_word') };
  document.getElementById('reportTargetName').textContent = username || '';
  document.querySelectorAll('input[name="reportReason"]').forEach(function(r){ r.checked = false; });
  document.getElementById('reportDetails').value = '';
  document.getElementById('userProfilePopup').classList.remove('show');
  document.getElementById('reportUserOverlay').classList.add('show');
}

function closeReportModal() {
  document.getElementById('reportUserOverlay').classList.remove('show');
  reportTarget = null;
}

async function submitReport() {
  if (!reportTarget) return;
  var checked = document.querySelector('input[name="reportReason"]:checked');
  if (!checked) { showToast(T('report_choose_reason')); return; }
  var btn = document.getElementById('reportSubmitBtn');
  btn.disabled = true; btn.textContent = T('auth_sending');
  try {
    await api('/api/users/' + reportTarget.id + '/report', {
      method: 'POST',
      body: JSON.stringify({
        reason: checked.value,
        details: document.getElementById('reportDetails').value.trim(),
        context: 'profile',
      }),
    });
    showToast('✓ ' + T('report_sent_thanks'));
    closeReportModal();
  } catch(e) {
    showToast(T('err_generic') + ' ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = T('report_submit_btn');
  }
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

// ── ADD FRIEND ──────────────────────────────────────────────────────────────
function switchAddFriendTab(tab) {
  document.getElementById('afPaneAdd').style.display = tab === 'add' ? '' : 'none';
  document.getElementById('afPaneRequests').style.display = tab === 'requests' ? '' : 'none';
  document.getElementById('afPaneBlocked').style.display = tab === 'blocked' ? '' : 'none';
  document.getElementById('afTabAddBtn').classList.toggle('active', tab === 'add');
  document.getElementById('afTabReqBtn').classList.toggle('active', tab === 'requests');
  document.getElementById('afTabBlockedBtn').classList.toggle('active', tab === 'blocked');
  if (tab === 'blocked') loadBlockedUsers();
}

async function loadBlockedUsers() {
  var el = document.getElementById('afBlockedList');
  el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 4px"><span data-i18n="status_loading">Загрузка...</span></div>';
  try {
    var data = await api('/api/users/me/blocked');
    var rows = data.blocked || [];
    if (!rows.length) { el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 4px"><span data-i18n="blocked_none">Нет заблокированных пользователей</span></div>'; return; }
    el.innerHTML = rows.map(function(r){
      var b = r.blocked;
      var uname = escHtml(b.username).replace(/'/g,"\\'");
      return '<div class="blocked-list-item"><div class="friend-ava" style="width:30px;height:30px;font-size:13px;background:linear-gradient(135deg,#7c3aed,#ec4899)">' + avatarHtml(b.avatar_emoji, b.avatar_url) + '</div><span class="friend-name">' + escHtml(b.username) + '</span><button class="blocked-unblock-btn" onclick="unblockUserAction(\'' + b.id + '\',\'' + uname + '\')"><span data-i18n="blocked_unblock_btn">Разблокировать</span></button></div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 4px"><span data-i18n="blocked_err_load">Не удалось загрузить список</span></div>';
  }
}

var afSearchTimer = null;
var afSearchSeq = 0;
var afSelectedUser = null;   // { id, username } once picked from the dropdown
var afSearchResults = [];
var afSearchActiveIndex = -1;

function openAddFriend() {
  document.getElementById('afUsername').value = '';
  document.getElementById('afError').classList.remove('show');
  document.getElementById('addFriendOverlay').classList.add('show');
  afCloseSearchDropdown();
  afSelectedUser = null;
  switchAddFriendTab(pendingFriendRequests.length > 0 ? 'requests' : 'add');
  if (pendingFriendRequests.length === 0) {
    setTimeout(function(){ document.getElementById('afUsername').focus(); }, 50);
  }
}

function closeAddFriend() {
  document.getElementById('addFriendOverlay').classList.remove('show');
  afCloseSearchDropdown();
}

function afShowError(msg) {
  var el = document.getElementById('afError');
  el.textContent = msg;
  el.classList.add('show');
}

function afCloseSearchDropdown() {
  var dd = document.getElementById('afSearchDropdown');
  dd.classList.remove('open');
  dd.innerHTML = '';
  afSearchResults = [];
  afSearchActiveIndex = -1;
}

// Called on every keystroke in the nickname field: debounces, then asks the
// server for partial matches so results update live as letters are typed.
function afOnUsernameInput(value) {
  document.getElementById('afError').classList.remove('show');
  if (afSelectedUser && value.trim().toLowerCase() !== afSelectedUser.username.toLowerCase()) {
    afSelectedUser = null;
  }
  var q = value.trim();
  clearTimeout(afSearchTimer);
  if (q.length < 1) { afCloseSearchDropdown(); return; }
  afSearchTimer = setTimeout(function(){ afRunSearch(q); }, 220);
}

async function afRunSearch(q) {
  var seq = ++afSearchSeq;
  try {
    var data = await api('/api/users/search?username=' + encodeURIComponent(q) + '&limit=8');
    if (seq !== afSearchSeq) return; // a newer keystroke already superseded this request
    afSearchResults = data.users || [];
    afRenderSearchDropdown();
  } catch(e) {
    if (seq === afSearchSeq) afCloseSearchDropdown();
  }
}

function afRenderSearchDropdown() {
  var dd = document.getElementById('afSearchDropdown');
  afSearchActiveIndex = -1;
  if (!afSearchResults.length) {
    dd.innerHTML = '<div class="af-search-empty">' + T('user_not_found') + '</div>';
    dd.classList.add('open');
    return;
  }
  dd.innerHTML = afSearchResults.map(function(u, i){
    var already = currentFriendIds.has(String(u.id));
    var uname = escHtml(u.username).replace(/'/g,"\\'");
    return '<div class="af-search-item" data-idx="' + i + '" onclick="afSelectUser(\'' + u.id + '\',\'' + uname + '\')">'
      + '<div class="friend-ava" style="width:28px;height:28px;font-size:12px">' + avatarHtml(u.avatar_emoji, u.avatar_url) + '</div>'
      + '<div class="af-search-item-name">' + escHtml(u.username) + '</div>'
      + (already ? '<div class="af-search-item-tag">' + T('friends_already') + '</div>' : '')
      + '</div>';
  }).join('');
  dd.classList.add('open');
}

function afSelectUser(id, username) {
  afSelectedUser = { id: id, username: username };
  document.getElementById('afUsername').value = username;
  afCloseSearchDropdown();
}

function afUsernameKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (afSearchActiveIndex >= 0 && afSearchResults[afSearchActiveIndex]) {
      var u = afSearchResults[afSearchActiveIndex];
      afSelectUser(u.id, u.username);
    } else {
      sendFriendRequest();
    }
    return;
  }
  if (!afSearchResults.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    var items = document.querySelectorAll('#afSearchDropdown .af-search-item');
    afSearchActiveIndex += event.key === 'ArrowDown' ? 1 : -1;
    if (afSearchActiveIndex < 0) afSearchActiveIndex = items.length - 1;
    if (afSearchActiveIndex >= items.length) afSearchActiveIndex = 0;
    items.forEach(function(el, i){ el.classList.toggle('active', i === afSearchActiveIndex); });
  } else if (event.key === 'Escape') {
    afCloseSearchDropdown();
  }
}

document.addEventListener('click', function(e){
  var wrap = document.querySelector('.af-search-wrap');
  if (wrap && !wrap.contains(e.target)) afCloseSearchDropdown();
});

async function sendFriendRequest() {
  var username = document.getElementById('afUsername').value.trim();
  if (!username) return afShowError(T('friends_enter_nickname'));
  if (username.toLowerCase() === (currentUser.username || '').toLowerCase()) return afShowError(T('friends_this_is_you'));

  var btn = document.getElementById('afSendBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span>' + T('auth_sending');
  try {
    var targetId, targetUsername;
    if (afSelectedUser && afSelectedUser.username.toLowerCase() === username.toLowerCase()) {
      targetId = afSelectedUser.id;
      targetUsername = afSelectedUser.username;
    } else {
      var found = await api('/api/users/search?username=' + encodeURIComponent(username) + '&exact=1');
      targetId = found.user.id;
      targetUsername = found.user.username;
    }
    if (targetId && currentFriendIds.has(String(targetId))) {
      afShowError(T('friends_already_friends_user'));
      return;
    }
    await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ targetUserId: targetId }) });
    showToast(T('friends_request_sent') + ' ' + targetUsername + ' \u2713');
    closeAddFriend();
    loadFriends();
  } catch(e) {
    if (e.message === T('user_not_found')) afShowError(e.message);
    else if (/already exists|Cannot add yourself/i.test(e.message)) afShowError(T('friends_request_already_or_friends'));
    else afShowError(e.message || T('friends_err_send_request'));
  } finally {
    btn.disabled = false;
    btn.innerHTML = T('btn_send_request');
  }
}


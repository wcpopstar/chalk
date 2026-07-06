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

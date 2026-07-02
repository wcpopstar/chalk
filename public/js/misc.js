// ── USER PROFILE POPUP — click a user in global chat to view + add friend ──
async function openUserProfilePopup(userId) {
  if (currentUser && userId === currentUser.id) return; // don't open your own popup
  var overlay = document.getElementById('userProfilePopup');
  var body = document.getElementById('upBody');
  body.innerHTML = '<button class="gc-close-btn" style="float:right" onclick="closeUserProfilePopup()">✕</button><div style="font-size:11px;color:var(--muted);padding:30px 0"><span data-i18n="status_loading">Загрузка...</span></div>';
  overlay.classList.add('show');

  try {
    var data = await api('/api/users/' + userId);
    var u = data.user;
    var meta = [];
    if (u.age) meta.push(u.age + ' ' + T('unit_years'));
    if (u.country) meta.push('🌍 ' + u.country);
    if (u.gender) meta.push(genderLabel(u.gender));

    var alreadyFriend = !!(u.id && currentFriendIds.has(String(u.id)));
    var uname = escHtml(u.username).replace(/'/g,"\\'");

    if (u.blocked_by_me) {
      body.innerHTML =
        '<button class="gc-close-btn" style="float:right" onclick="closeUserProfilePopup()">✕</button>' +
        '<div class="up-avatar">' + avatarHtml(u.avatar_emoji, u.avatar_url) + '</div>' +
        '<div class="up-name">' + escHtml(u.username) + '</div>' +
        '<div class="up-meta" style="color:#f87171">🚫 ' + T('blocked_label') + '</div>' +
        '<div class="up-actions">' +
          '<button class="auth-btn" style="background:var(--surface2);color:var(--text)" onclick="unblockUserAction(\'' + u.id + '\',\'' + uname + '\');closeUserProfilePopup()"><span data-i18n="blocked_unblock_btn">Разблокировать</span></button>' +
        '</div>';
      return;
    }

    body.innerHTML =
      '<button class="gc-close-btn" style="float:right" onclick="closeUserProfilePopup()">✕</button>' +
      '<div class="up-avatar">' + avatarHtml(u.avatar_emoji, u.avatar_url) + '</div>' +
      '<div class="up-name">' + escHtml(u.username) + '</div>' +
      '<div class="up-meta">' + escHtml(meta.join(' · ') || T('default_player_name')) + '</div>' +
      '<div class="up-bio">' + escHtml(u.bio || T('looking_for_teammates_status')) + '</div>' +
      '<div class="up-actions">' +
        '<button class="auth-btn" id="upAddFriendBtn" ' + (alreadyFriend ? 'disabled style="opacity:.6"' : '') + ' onclick="sendFriendRequestFromPopup(\'' + u.id + '\',\'' + uname + '\')">' + (alreadyFriend ? '✓ ' + T('friends_already') : '+ ' + T('friends_add')) + '</button>' +
        '<button class="auth-btn" style="background:var(--surface2);color:var(--text)" onclick="callFriend(\'' + u.id + '\',\'' + uname + '\',\'' + (u.avatar_emoji || '🎮') + '\',' + !!(friendCallStatus[u.id] && friendCallStatus[u.id].inCall) + ',' + ((friendCallStatus[u.id] && friendCallStatus[u.id].roomSize) || 0) + ')">📞 ' + T('btn_call') + '</button>' +
        '<button class="auth-btn" style="background:var(--surface2);color:var(--text)" onclick="closeUserProfilePopup();openDM(\'' + u.id + '\',\'' + uname + '\',\'' + (u.avatar_emoji || '🎮') + '\')">💬 ' + T('btn_write') + '</button>' +
        '<div class="up-danger-row">' +
          (alreadyFriend ? '<button onclick="unfriendUser(\'' + u.id + '\',\'' + uname + '\')">🚫 ' + T('fam_unfriend') + '</button>' : '') +
          '<button onclick="blockUserAction(\'' + u.id + '\',\'' + uname + '\')">⛔ ' + T('fam_block') + '</button>' +
          '<button onclick="openReportModal(\'' + u.id + '\',\'' + uname + '\')">🚩 ' + T('fam_report') + '</button>' +
        '</div>' +
      '</div>';
  } catch(e) {
    body.innerHTML = '<button class="gc-close-btn" style="float:right" onclick="closeUserProfilePopup()">✕</button><div style="font-size:12px;color:var(--muted);padding:30px 0"><span data-i18n="profile_err_load">Не удалось загрузить профиль</span></div>';
  }
}

function closeUserProfilePopup() {
  document.getElementById('userProfilePopup').classList.remove('show');
}

async function sendFriendRequestFromPopup(userId, username) {
  if (userId && currentFriendIds.has(String(userId))) {
    showToast('✓ ' + T('friends_already'));
    return;
  }
  var btn = document.getElementById('upAddFriendBtn');
  if (btn) { btn.disabled = true; btn.textContent = T('auth_sending'); }
  try {
    await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ targetUserId: userId }) });
    if (btn) { btn.textContent = '✓ ' + T('friends_request_sent_short'); }
    showToast('✓ ' + T('friends_request_sent_msg') + ' ' + username);
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '+ ' + T('friends_add'); }
    showToast(e.message && e.message.indexOf('already') !== -1 ? T('friends_request_already_sent') : T('err_generic') + ' ' + e.message);
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var toastTimeout = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(function(){ t.classList.remove('show') }, 3000);
}


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

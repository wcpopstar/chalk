// ── NAV ───────────────────────────────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach((p) =>{ p.classList.remove('active') });
  document.querySelectorAll('.nav-tab').forEach((t) =>{ t.classList.remove('active') });
  document.getElementById(`page-${  name}`).classList.add('active');
  btn.classList.add('active');

  const bubble = document.getElementById('globalChatBubble');
  const panel = document.getElementById('globalChatPanel');
  if (name === 'match') {
    bubble.style.display = 'flex';
  } else {
    bubble.style.display = 'none';
    if (panel) panel.style.display = 'none';
  }
}

function goToMatchHome() {
  const matchTab = document.querySelector('.nav-tab');
  if (matchTab) showPage('match', matchTab);
}

// ── MATCH ─────────────────────────────────────────────────────────────────────
function toggleGameDropdown(e) {
  if (e) e.stopPropagation();
  const wrap = document.getElementById('gameSelectWrap');
  const opening = !wrap.classList.contains('open');
  wrap.classList.toggle('open');
  if (opening) {
    const search = document.getElementById('gameSelectSearch');
    search.value = '';
    filterGameDropdown('');
    setTimeout(() =>{ search.focus(); }, 50);
  }
}

function closeGameDropdown() {
  document.getElementById('gameSelectWrap').classList.remove('open');
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('gameSelectWrap');
  if (wrap && wrap.classList.contains('open') && !wrap.contains(e.target)) {
    closeGameDropdown();
  }
});

function filterGameDropdown(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('#gameSelectList .game-select-item').forEach((item) =>{
    const name = (item.dataset.name || '').toLowerCase();
    item.style.display = name.indexOf(q) !== -1 ? '' : 'none';
  });
}

function selectGameFromDropdown(el) {
  document.querySelectorAll('#gameSelectList .game-select-item').forEach((i) =>{ i.classList.remove('selected') });
  el.classList.add('selected');
  selectedGameId = el.dataset.value;
  document.getElementById('gameSelectEmoji').textContent = el.querySelector('span').textContent;
  document.getElementById('gameSelectName').textContent = el.dataset.name;
  closeGameDropdown();
}

function selectMode(el, mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) =>{ b.classList.remove('active') });
  el.classList.add('active');
  document.getElementById('squadPicker').classList.toggle('show', mode === 'group');
}

// Voice vs text matchmaking. Text is 1:1 only, so choosing it forces solo and
// hides the group / squad-size controls; the match will land in a chat.
var matchChatOnly = false;
function selectMatchType(type) {
  matchChatOnly = (type === 'text');
  const voiceBtn = document.getElementById('mttVoice');
  const textBtn = document.getElementById('mttText');
  if (voiceBtn) voiceBtn.classList.toggle('active', !matchChatOnly);
  if (textBtn) textBtn.classList.toggle('active', matchChatOnly);
  const modeSelect = document.querySelector('.mode-select');
  if (matchChatOnly) {
    const soloBtn = document.querySelector('.mode-btn');
    if (soloBtn) selectMode(soloBtn, 'solo');
    if (modeSelect) modeSelect.style.display = 'none';
  } else if (modeSelect) {
    modeSelect.style.display = '';
  }
}

function selectSquad(el, n) {
  squadSize = n;
  document.querySelectorAll('.squad-num').forEach((b) =>{ b.classList.remove('sel') });
  el.classList.add('sel');
}

function startMatch() {
  const btn = document.getElementById('matchBtn');
  const status = document.getElementById('searchStatus');
  if (isSearching) {
    isSearching = false;
    socket.emit('match:leave');
    btn.textContent = T('btn_find_caps');
    btn.classList.remove('searching');
    status.classList.remove('show');
    tetrisPause();
    return;
  }
  isSearching = true;
  btn.textContent = T('btn_stop_caps');
  btn.classList.add('searching');
  status.classList.add('show');
  const payload = {
    gameId: selectedGameId,
    mode: currentMode,
    squadSize,
    languages: currentUser.languages || ['ru'],
    region: 'eu',
    rankScore: 3,
  };
  // Optional pre-match filters (gender + age category).
  const gv = (document.getElementById('filterGender') || {}).value || '';
  if (gv) payload.genderPref = [gv];
  const av = (document.getElementById('filterAge') || {}).value || '';
  if (av) {
    const parts = av.split('-');
    payload.ageMin = Number(parts[0]);
    payload.ageMax = Number(parts[1]);
  }
  // Text matching is always 1:1 and lands in a chat instead of a call.
  if (matchChatOnly) {
    payload.chatOnly = true;
    payload.mode = 'solo';
    payload.squadSize = 2;
  }
  socket.emit('match:join', payload);
}

function showFoundOverlay(data) {
  isSearching = false;
  document.getElementById('matchBtn').textContent = T('btn_find_caps');
  document.getElementById('matchBtn').classList.remove('searching');
  document.getElementById('searchStatus').classList.remove('show');
  tetrisPause();

  const pts = currentCallParticipants;
  document.getElementById('foundBadge').textContent = `✓ ${  selectedGameId  } · ${  currentMode === 'group' ? T('match_group') : 'Solo'}`;
  document.getElementById('foundAvas').innerHTML = pts.map((p) =>`<div class="found-ava" style="background:linear-gradient(135deg,#7c3aed,#059669)">${  participantAvatarHtml(p)  }</div>`).join('');
  document.getElementById('foundName').textContent = pts.map((p) =>participantDisplayName(p)).join(', ');
  document.getElementById('foundRank').textContent = `🎮 ${  selectedGameId}`;
  document.getElementById('foundInfo').textContent = T('match_found_excl');
  document.getElementById('foundOverlay').classList.add('show');
}

function skipMatch() {
  document.getElementById('foundOverlay').classList.remove('show');
  showToast(`${T('status_skipped')  } \u2014 ${  T('msg_looking_for_next')}`);
  startMatch();
}

function acceptMatch() {
  document.getElementById('foundOverlay').classList.remove('show');
  startTrialCall(currentCallParticipants);
}

// ── TRIAL CALL ────────────────────────────────────────────────────────────────
function tickTrial() {
  trialSeconds--;
  document.getElementById('trialProgressFill').style.width = `${(trialSeconds / 120) * 100  }%`;
  const m = String(Math.floor(trialSeconds / 60)).padStart(2, '0');
  const s = String(trialSeconds % 60).padStart(2, '0');
  document.getElementById('trialTimer').textContent = `${m  }:${  s}`;
  if (trialSeconds <= 30 && !trialVoted) {
    document.getElementById('voteSection').classList.add('show');
    document.getElementById('trialTimer').classList.add('warning');
    document.getElementById('trialStatus').textContent = T('call_continue_chatting_q');
  }
  if (trialSeconds <= 0) {
    clearInterval(trialInterval);
    if (!trialVoted) endTrialCall();
  }
}

function voteYes() {
  trialVoted = true;
  const continueBtn = document.getElementById('trialContinueBtn');
  if (continueBtn) {
    continueBtn.textContent = '✓';
    continueBtn.classList.add('selected');
    continueBtn.disabled = true;
    continueBtn.title = T('status_confirmed');
  }
  if (socket && currentRoomId) {
    socket.emit('trial:vote', { roomId: currentRoomId, vote: 'yes' });
  }
  const voteEl = document.getElementById('voteSection');
  if (voteEl) {
    voteEl.innerHTML = `<div style="color:var(--accent3);font-size:13px;font-weight:600">\u2713 ${  T('match_waiting_others')  }</div>`;
  }
}

function voteNo() {
  trialVoted = true;
  socket.emit('trial:vote', { roomId: currentRoomId, vote: 'no' });
  clearInterval(trialInterval);
  endTrialCall();
}

// ── FULL CALL ────────────────────────────────────────────────────────────────
async function addFriendInCall(btn, userId, username) {
  if (btn.classList.contains('added')) return;
  try {
    await api('/api/friends/add-after-call', { method: 'POST', body: JSON.stringify({ targetUserId: userId }) });
    btn.textContent = `✓ ${  T('friend_label')}`; btn.classList.add('added');
    showToast(`✓ ${  username  } ${  T('msg_added_to_friends_excl')}`);
    loadFriends();
  } catch(e) { showToast(`${T('err_generic')  } ${  e.message}`); }
}

async function addFriendPost(btn, userId, username) {
  if (btn.classList.contains('added')) return;
  try {
    await api('/api/friends/add-after-call', { method: 'POST', body: JSON.stringify({ targetUserId: userId }) });
    btn.textContent = `✓ ${  T('friends_added_label')}`; btn.classList.add('added');
    showToast(`✓ ${  username  } ${  T('msg_now_friends_excl')}`);
    loadFriends();
  } catch(e) { showToast(`${T('err_generic')  } ${  e.message}`); }
}


function closePostCall() { document.getElementById('postCallOverlay').classList.remove('show'); }


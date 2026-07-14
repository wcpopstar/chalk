// ── FULL CALL ────────────────────────────────────────────────────────────────
function startFullCall(pts) {
  const fcWrap = document.getElementById('fcParticipants');
  fcWrap.innerHTML = `${pts.map((p) =>{
    const isFriend = participantIsAlreadyFriend(p);
    const pid = getParticipantId(p);
    const pname = escHtml(participantDisplayName(p)).replace(/'/g, "\\'");
    return `<div class="fp-item"><div class="fp-ava speaking" style="background:linear-gradient(135deg,#7c3aed,#059669);cursor:pointer" title="Громкость" data-i18n-title="call_volume" onclick="openUserVolumeMenu(event,'${  pid  }','${  pname  }')">${  participantAvatarHtml(p)  }</div><div class="fp-name">${  escHtml(participantDisplayName(p))  }</div>${  !isFriend ? `<button class="fp-add" onclick="addFriendInCall(this,'${  p.id  }','${  escHtml(participantDisplayName(p)).replace(/'/g, "\\'")  }')">+ ${  T('friend_label')  }</button>` : `<button class="fp-add added">✓ ${  T('friend_label')  }</button>`  }</div>`;
  }).join('')  }<div class="fp-item"><div class="fp-ava" style="background:linear-gradient(135deg,#7c3aed,#c8ff00)">${  avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url)  }</div><div class="fp-you"><span data-i18n="status_you">Ты</span></div></div>`;

  document.getElementById('fcTitle').textContent = pts.length > 1 ? `${T('match_group')  } · ${  pts.length + 1  } ${  T('unit_people_dot')}` : participantDisplayName(pts[0] || null);
  fcSeconds = 0; fcMuted = false; fcDeafened = false;
  document.getElementById('fcMuteBtn').textContent = '🎙️';
  document.getElementById('fcMuteBtn').classList.remove('muted');
  document.getElementById('fcDeafBtn').textContent = '🔊';
  document.getElementById('fcTimer').textContent = '00:00';
  if (typeof fcResetCollab === 'function') fcResetCollab();
  if (typeof fcResetVideo === 'function') fcResetVideo();
  if (typeof fcInitBoardListeners === 'function') fcInitBoardListeners();
  document.getElementById('fullCallOverlay').classList.add('show');
  clearInterval(fcInterval);
  fcInterval = setInterval(() =>{
    fcSeconds++;
    const m = String(Math.floor(fcSeconds / 60)).padStart(2, '0');
    const s = String(fcSeconds % 60).padStart(2, '0');
    document.getElementById('fcTimer').textContent = `${m  }:${  s}`;
  }, 1000);

  const channelName = currentRoomId ? `voice-${  currentRoomId}` : 'chalk-default';
  const joinFn = window.joinVoiceAndEnableMic || window.joinVoice;
  if (joinFn) {
    joinFn(channelName, currentUser && currentUser.id).catch(() => {
      showToast(T('call_couldnt_connect_voice'));
    });
  }

  // Speaking animation
  const avas = fcWrap.querySelectorAll('.fp-ava');
  let si = 0;
  setInterval(() =>{
    avas.forEach((a) =>{ a.classList.remove('speaking') });
    if (avas.length > 1) avas[si % (avas.length - 1)].classList.add('speaking');
    si++;
  }, 2000);
}

function toggleFCMute() {
  if (window.toggleVoiceMute) {
    window.toggleVoiceMute().catch(() => {
      showToast(T('call_couldnt_toggle_mic'));
    });
  }
  fcMuted = !fcMuted;
  const btn = document.getElementById('fcMuteBtn');
  btn.textContent = fcMuted ? '🔇' : '🎙️';
  btn.classList.toggle('muted', fcMuted);
  if (window.chalkSounds) (fcMuted ? window.chalkSounds.selfMute : window.chalkSounds.selfUnmute)();
}
function toggleFCDeaf() {
  fcDeafened = !fcDeafened;
  const btn = document.getElementById('fcDeafBtn');
  if (btn) btn.textContent = fcDeafened ? '🔕' : '🔊';
  btn && btn.classList.toggle('active', fcDeafened);
  if (window.toggleVoiceDeafen) {
    window.toggleVoiceDeafen().catch(() => {
      showToast(T('call_couldnt_toggle_others_sound'));
    });
  }
}
async function endFullCall(silent) {
  clearInterval(fcInterval);
  // Report this client's measured call time so the "most active users"
  // leaderboard advances for everyone in the call (fire-and-forget).
  const callSecs = fcSeconds;
  if (callSecs > 0) {
    api('/api/calls/activity', { method: 'POST', body: JSON.stringify({ seconds: callSecs }) }).catch(() => {});
  }
  if (!silent && socket && currentRoomId) socket.emit('call:end', { roomId: currentRoomId });
  if (window.leaveVoice) window.leaveVoice();
  if (typeof fcResetVideo === 'function') fcResetVideo();
  if (typeof resetWatchOnCallEnd === 'function') resetWatchOnCallEnd();
  document.getElementById('fullCallOverlay').classList.remove('show');
  currentCallMatchIds = {};
  try {
    const matches = await recordCallParticipants(currentCallParticipants);
    currentCallMatchIds = {};
    matches.forEach((match) =>{ if (match && match.participantId) currentCallMatchIds[match.participantId] = match.id; });
  } catch (_) {}
  showPostCall(currentCallParticipants);
}

async function recordCallParticipants(pts) {
  const ids = (pts || []).map((p) =>getParticipantId(p)).filter(Boolean);
  if (!ids.length) return [];
  const data = await api('/api/match/record-call', { method: 'POST', body: JSON.stringify({ participants: ids, mode: 'group', gameId: selectedGameId }) });
  return data.matches || [];
}

function showPostCall(pts) {
  if (!pts || !pts.length) return;
  document.getElementById('postCallParticipants').innerHTML = pts.map((p) =>{
    const alreadyFriend = participantIsAlreadyFriend(p);
    return `<div class="pc-item"><div class="pc-ava" style="background:linear-gradient(135deg,#7c3aed,#059669)">${  participantAvatarHtml(p)  }</div><div class="pc-name">${  escHtml(participantDisplayName(p))  }</div>${  !alreadyFriend ? `<button class="pc-add-btn" onclick="addFriendPost(this,'${  p.id  }','${  escHtml(participantDisplayName(p)).replace(/'/g, "\\'")  }')">+ ${  T('btn_add')  }</button>` : `<button class="pc-add-btn added">✓ ${  T('friends_already')  }</button>`  }</div>`;
  }).join('');

  // Rating only makes sense for people you're not already friends with.
  const ratableCount = pts.filter((p) =>!participantIsAlreadyFriend(p)).length;
  const rateBtn = document.getElementById('pcRateBtn');
  if (rateBtn) {
    rateBtn.disabled = ratableCount === 0;
    rateBtn.textContent = ratableCount === 0 ? `⭐ ${  T('call_you_already_friends')}` : `⭐ ${  T('rating_btn')}`;
  }

  document.getElementById('postCallOverlay').classList.add('show');
}

async function loadProfile() {
  if (!currentUser) return;
  document.getElementById('profileAva').innerHTML = avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url);
  document.getElementById('profileUsername').textContent = currentUser.username;
  document.getElementById('profileTagline').textContent = currentUser.bio || T('profile_no_description');
  document.getElementById('profileEmail').textContent = currentUser.email;
  document.getElementById('profileAge').textContent = currentUser.age ? (`${currentUser.age  } ${  T('unit_years')}`) : T('profile_not_specified');
  document.getElementById('profileGender').textContent = genderLabel(currentUser.gender);
  document.getElementById('profileCountry').textContent = currentUser.country || T('profile_not_specified_f');
  document.getElementById('profileLangs').textContent = (currentUser.languages || ['ru']).map((l) =>langLabel(l)).join(', ');

  try {
    const data = await api('/api/users/me/stats');
    document.getElementById('statMatches').textContent = data.matches_found || 0;
    document.getElementById('statRating').textContent = data.avg_rating ? data.avg_rating.toFixed(1) : '—';
    document.getElementById('statFriends').textContent = data.friends_count || 0;
  } catch(e) {}

  let gameNames = [];
  try {
    const meData = await api(`/api/users/${  currentUser.id}`);
    gameNames = (meData.user.user_games || []).map((g) =>(g.games && g.games.emoji ? `${g.games.emoji  } ` : '') + (g.games ? g.games.name : g.game_id));
  } catch(e) {}
  document.getElementById('profileGames').textContent = gameNames.length ? gameNames.join(', ') : T('status_none_selected');

  const tags = document.getElementById('profileTags');
  tags.innerHTML = (currentUser.languages || ['ru']).map((l) =>`<span class="ptag ptag-lang">${  langLabel(l)  }</span>`).join('');
  if (currentUser.age) tags.innerHTML += `<span class="ptag ptag-rank">🎂 ${  currentUser.age  }</span>`;
  if (currentUser.country) tags.innerHTML += `<span class="ptag ptag-rank">📍 ${  currentUser.country  }</span>`;
  gameNames.forEach((g) =>{ tags.innerHTML += `<span class="ptag ptag-game">${  g  }</span>`; });

  if (typeof loadPasskeys === 'function') loadPasskeys();
}


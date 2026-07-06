function startFriendCall() {
  if (!currentConvPartner || !currentConvPartner.id) {
    showToast(T('call_couldnt_determine_peer'));
    return;
  }
  if (!socket) {
    showToast(T('call_no_connection_server'));
    return;
  }
  // Reuse the exact same path as calling a friend from the friends sidebar:
  // call:invite → call:incoming → call:accept → call:accepted → startFullCall
  // (or call:request_join if they're already in a call). This rings the
  // other person and opens the normal full-call UI, instead of silently
  // joining a voice channel nobody else was told about.
  const cs = friendCallStatus[currentConvPartner.id] || { inCall: false, roomSize: 0 };
  callFriend(currentConvPartner.id, currentConvPartner.username, currentConvPartner.avatar_emoji, cs.inCall, cs.roomSize);
}

function startTrialCall(pts) {
  const wrap = document.getElementById('trialParticipants');
  wrap.innerHTML = `${pts.map((p) =>{
    const pid = getParticipantId(p);
    const pname = escHtml(participantDisplayName(p)).replace(/'/g, "\\'");
    return `<div class="tp-item"><div class="tp-ava speaking" style="background:linear-gradient(135deg,#7c3aed,#059669);cursor:pointer" title="Громкость" data-i18n-title="call_volume" onclick="openUserVolumeMenu(event,'${  pid  }','${  pname  }')">${  participantAvatarHtml(p)  }</div><div class="tp-name">${  escHtml(participantDisplayName(p))  }</div></div>`;
  }).join('')  }<div class="tp-item"><div class="tp-ava" style="background:linear-gradient(135deg,#7c3aed,#c8ff00)">${  avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url)  }</div><div class="tp-name"><span data-i18n="status_you">Ты</span></div></div>`;

  trialSeconds = 120; trialVoted = false; trialMuted = false;
  document.getElementById('trialMuteBtn').textContent = '🎙️';
  document.getElementById('trialMuteBtn').classList.remove('muted');
  const continueBtn = document.getElementById('trialContinueBtn');
  if (continueBtn) {
    continueBtn.textContent = '✓';
    continueBtn.classList.remove('selected');
    continueBtn.disabled = false;
    continueBtn.title = T('btn_continue');
  }
  document.getElementById('voteSection').classList.remove('show');
  document.getElementById('trialTimer').classList.remove('warning');
  document.getElementById('trialStatus').textContent = T('match_meet_and_decide');
  document.getElementById('trialProgressFill').style.width = '100%';
  document.getElementById('trialOverlay').classList.add('show');
  clearInterval(trialInterval);
  trialInterval = setInterval(tickTrial, 1000);

  const channelName = currentRoomId ? `voice-${  currentRoomId}` : 'chalk-default';
  const joinFn = window.joinVoiceAndEnableMic || window.joinVoice;
  if (joinFn) {
    joinFn(channelName, currentUser && currentUser.id).catch(() => {
      showToast(T('call_couldnt_connect_voice'));
    });
  }
}

function leaveTrialCall() { clearInterval(trialInterval); if (window.leaveVoice) window.leaveVoice(); endTrialCall(); }
function endTrialCall() { document.getElementById('trialOverlay').classList.remove('show'); showToast(`📝 ${  T('call_ended')}`); }
function toggleTrialMute() {
  if (window.toggleVoiceMute) {
    window.toggleVoiceMute().catch(() => {
      showToast(T('call_couldnt_toggle_mic'));
    });
  }
  trialMuted = !trialMuted;
  const btn = document.getElementById('trialMuteBtn');
  btn.textContent = trialMuted ? '🔇' : '🎙️';
  btn.classList.toggle('muted', trialMuted);
}

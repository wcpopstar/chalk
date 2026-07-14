// ── RATING MODAL ─────────────────────────────────────────────────────────────
var ratingQueue = [];        // [{ p, matchId }]
var ratingQueueIndex = 0;
var ratingSelectedStars = 0;
var ratingSubmittedCount = 0;

function rateParticipantsAfterCall() {
  const pts = currentCallParticipants || [];
  ratingQueue = pts
    .filter((p) =>!participantIsAlreadyFriend(p)) // друзей оценивать не нужно
    .map((p) =>{
      const pid = getParticipantId(p);
      return { p, matchId: pid ? currentCallMatchIds[pid] : null };
    })
    .filter((item) =>Boolean(item.matchId));

  if (!ratingQueue.length) {
    showToast(`${T('call_all_already_friends')  } \u2014 ${  T('rating_no_rating_needed')}`);
    return;
  }

  ratingQueueIndex = 0;
  ratingSubmittedCount = 0;
  document.getElementById('ratingModalOverlay').classList.add('show');
  renderRatingCandidate();
}

function renderRatingCandidate() {
  const item = ratingQueue[ratingQueueIndex];
  if (!item) { finishRatingFlow(); return; }

  const {p} = item;
  document.getElementById('ratingModalProgress').textContent = `${ratingQueueIndex + 1  } ${  T('unit_from')  } ${  ratingQueue.length}`;
  document.getElementById('ratingModalAva').innerHTML = participantAvatarHtml(p);
  document.getElementById('ratingModalName').textContent = participantDisplayName(p);
  const commentEl = document.getElementById('ratingModalComment');
  if (commentEl) commentEl.value = '';
  setRatingStars(0);
}

function setRatingStars(n) {
  ratingSelectedStars = n;
  document.querySelectorAll('#ratingStars .rating-star').forEach((star) =>{
    star.classList.toggle('active', parseInt(star.dataset.star, 10) <= n);
  });
  document.getElementById('ratingModalSubmitBtn').disabled = n < 1;
}

async function submitCurrentRating() {
  const item = ratingQueue[ratingQueueIndex];
  if (!item || ratingSelectedStars < 1) return;
  const btn = document.getElementById('ratingModalSubmitBtn');
  btn.disabled = true;
  const commentEl = document.getElementById('ratingModalComment');
  const comment = commentEl ? (commentEl.value || '').trim() : '';
  try {
    await api(`/api/match/${  item.matchId  }/rate`, { method: 'POST', body: JSON.stringify({ rating: ratingSelectedStars, comment }) });
    ratingSubmittedCount++;
  } catch (e) {
    showToast(`${T('rating_err_save')  } ${  e.message}`);
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
  showToast(ratingSubmittedCount ? `${T('rating_saved_for')  } ${  ratingSubmittedCount  } ${  T('unit_players_gen')}` : T('rating_not_saved'));
  closePostCall();
}

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

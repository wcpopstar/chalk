// ── DISCOVER / SWIPE ─────────────────────────────────────────────────────────
async function loadDiscover() {
  try {
    var data = await api('/api/users/discover?limit=10');
    discoverUsers = data.users || [];
    discoverIndex = 0;
    renderTinderCards();
  } catch(e) { console.error(e); }
}

function renderTinderCards() {
  var stack = document.getElementById('tinderStack');
  var slice = discoverUsers.slice(discoverIndex, discoverIndex + 3);
  if (!slice.length) {
    stack.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;flex-direction:column;gap:10px"><div style="font-size:38px">🎮</div><span data-i18n="discover_seen_everyone">Пока всех посмотрел!</span></div>';
    return;
  }
  stack.innerHTML = slice.map(function(u, i){
    var bg = ['linear-gradient(135deg,#1a0533,#0f172a)','linear-gradient(135deg,#0c1445,#1e3a5f)','linear-gradient(135deg,#1a1a2e,#16213e)'][i % 3];
    return '<div class="tinder-card" data-userid="' + u.id + '" data-username="' + escHtml(u.username) + '"><div class="tc-banner" style="background:' + bg + '">' + avatarHtml(u.avatar_emoji, u.avatar_url) + '<div class="tc-badges"><div class="tc-badge">🌍 ' + (u.country || '?') + '</div></div></div><div class="tc-body"><div class="tc-name">' + escHtml(u.username) + (u.age ? ', ' + u.age : '') + '</div><div class="tc-game">\ud83c\udfae ' + T('games_player') + '</div><div class="tc-details"><div class="tc-detail">' + (u.languages || ['ru']).join(', ').toUpperCase() + '</div>' + (u.gender ? '<div class="tc-detail">' + genderLabel(u.gender) + '</div>' : '') + '<div class="tc-detail">\u25cf ' + T('status_online') + '</div></div><div class="tc-bio">' + (u.bio ? escHtml(u.bio) : T('looking_for_teammates_status')) + '</div></div></div>';
  }).join('');
}

var swipeInFlight = false;
function swipe(dir) {
  var stack = document.getElementById('tinderStack');
  var top = stack.querySelector('.tinder-card:first-child');
  if (!top || swipeInFlight) return;
  swipeInFlight = true;
  setTimeout(function(){ swipeInFlight = false; }, 350);
  var userId = top.dataset.userid;
  var username = top.dataset.username;
  top.classList.add(dir === 'left' ? 'swiped-left' : 'swiped-right');
  if (socket && userId) socket.emit('swipe', { targetUserId: userId, direction: dir });
  setTimeout(function(){
    top.remove();
    discoverIndex++;
    if (!stack.querySelector('.tinder-card')) renderTinderCards();
  }, 420);
}

// ── DISCOVER / «Найти» ───────────────────────────────────────────────────────
// Reworked from left/super/right swipes into 👎 dislike / 💌 letter / ❤️ like
// (Leonardo-da-Vinci-bot style). Cards show a row of game icons for every game
// in the profile's анкета; tapping an icon swaps the shown per-game stats
// (rank + wins). Candidates arrive already ranked by shared interests.

var discoverGameSel = {}; // userId -> selected game_id for the stats view

async function loadDiscover() {
  try {
    const data = await api('/api/users/discover?limit=10');
    discoverUsers = data.users || [];
    discoverIndex = 0;
    discoverGameSel = {};
    renderTinderCards();
    refreshLikesBadge();
  } catch (e) { console.error(e); }
}
window.loadDiscover = loadDiscover;

// Builds the game-icon strip + the currently-selected game's stat block.
function discoverGamesBlock(u) {
  const games = (u.user_games || []).map((g) => ({
    id: g.game_id || (g.games && g.games.id),
    rank: g.rank || '',
    wins: g.wins || 0,
    hours: g.hours_played || 0,
  })).filter((g) => g.id);
  if (!games.length) return '';

  const sel = discoverGameSel[u.id] || games[0].id;
  discoverGameSel[u.id] = sel;

  const icons = games.map((g) => {
    const info = (window.gameById ? window.gameById(g.id) : { emoji: '🎮', name: g.id });
    return `<button class="tc-game-ico${g.id === sel ? ' active' : ''}" title="${escHtml(info.name)}" onclick="discoverPickGame(event,'${escHtml(u.id)}','${escHtml(g.id)}')">${info.emoji}</button>`;
  }).join('');

  const cur = games.find((g) => g.id === sel) || games[0];
  const info = (window.gameById ? window.gameById(cur.id) : { emoji: '🎮', name: cur.id });
  const stats = [];
  if (cur.rank) stats.push(`<span class="tc-stat">🏅 ${escHtml(cur.rank)}</span>`);
  stats.push(`<span class="tc-stat">🏆 ${cur.wins} ${T('settings_card_wins_short', 'побед')}</span>`);
  if (cur.hours) stats.push(`<span class="tc-stat">⏱ ${cur.hours}ч</span>`);

  return `<div class="tc-games-strip">${icons}</div>
    <div class="tc-game-stats"><div class="tc-game-title">${info.emoji} ${escHtml(info.name)}</div><div class="tc-stat-row">${stats.join('')}</div></div>`;
}

function discoverPickGame(ev, userId, gameId) {
  if (ev) ev.stopPropagation();
  discoverGameSel[userId] = gameId;
  // Re-render just the stats area of the top card in place.
  const card = document.querySelector(`.tinder-card[data-userid="${userId}"]`);
  if (!card) return;
  const u = discoverUsers.find((x) => String(x.id) === String(userId));
  if (!u) return;
  const holder = card.querySelector('.tc-games-holder');
  if (holder) holder.innerHTML = discoverGamesBlock(u);
}
window.discoverPickGame = discoverPickGame;

function renderTinderCards() {
  const stack = document.getElementById('tinderStack');
  const slice = discoverUsers.slice(discoverIndex, discoverIndex + 3);
  if (!slice.length) {
    stack.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;flex-direction:column;gap:10px"><div style="font-size:38px">🎮</div><span data-i18n="discover_seen_everyone">Пока всех посмотрел!</span></div>';
    return;
  }
  stack.innerHTML = slice.map((u, i) => {
    const bg = ['linear-gradient(135deg,#1a0533,#0f172a)', 'linear-gradient(135deg,#0c1445,#1e3a5f)', 'linear-gradient(135deg,#1a1a2e,#16213e)'][i % 3];
    const meta = [];
    if (u.age) meta.push(`${u.age}`);
    if (u.gender) meta.push(genderLabel(u.gender));
    const langs = (u.languages || ['ru']).map((l) => l.toUpperCase()).join(', ');
    return `<div class="tinder-card" data-userid="${u.id}" data-username="${escHtml(u.username)}">
      <div class="tc-banner" style="background:${bg}">${avatarHtml(u.avatar_emoji, u.avatar_url)}
        <div class="tc-badges"><div class="tc-badge">🌍 ${escHtml(u.country || '?')}</div></div>
      </div>
      <div class="tc-body">
        <div class="tc-name">${escHtml(u.username)}${u.age ? `, ${u.age}` : ''}</div>
        <div class="tc-games-holder">${discoverGamesBlock(u)}</div>
        <div class="tc-details">
          <div class="tc-detail">${langs}</div>
          ${u.gender ? `<div class="tc-detail">${genderLabel(u.gender)}</div>` : ''}
        </div>
        <div class="tc-bio">${u.bio ? escHtml(u.bio) : T('looking_for_teammates_status')}</div>
      </div>
    </div>`;
  }).join('');
}
window.renderTinderCards = renderTinderCards;

// ── ACTIONS: dislike / like / letter ────────────────────────────────────────
var discoverInFlight = false;

function currentDiscoverCard() {
  const stack = document.getElementById('tinderStack');
  return stack ? stack.querySelector('.tinder-card:first-child') : null;
}

async function discoverAct(action, message) {
  const top = currentDiscoverCard();
  if (!top || discoverInFlight) return;
  discoverInFlight = true;
  setTimeout(() => { discoverInFlight = false; }, 350);

  const userId = top.dataset.userid;
  const { username } = top.dataset;
  top.classList.add(action === 'dislike' ? 'swiped-left' : 'swiped-right');

  try {
    const data = await api('/api/users/discover/like', {
      method: 'POST',
      body: JSON.stringify({ targetUserId: userId, action, message: message || undefined }),
    });
    if (data.matched) {
      showToast(`🎉 ${T('discover_its_a_match', 'Взаимный лайк с')} ${username}!`);
    } else if (action === 'like') {
      showToast(`❤️ ${T('discover_liked', 'Лайк отправлен')}`);
    } else if (action === 'letter') {
      showToast(`💌 ${T('discover_letter_sent', 'Письмо отправлено')}`);
    }
  } catch (e) {
    showToast(`${T('err_generic', 'Ошибка')} ${e.message}`);
  }

  setTimeout(() => {
    top.remove();
    discoverIndex++;
    if (!currentDiscoverCard()) {
      // Fetch a fresh batch once the local stack drains.
      if (discoverIndex >= discoverUsers.length) loadDiscover();
      else renderTinderCards();
    }
  }, 420);
}
window.discoverAct = discoverAct;

// Backwards-compat shim: anything still calling swipe('left'/'right'/'super').
function swipe(dir) {
  discoverAct(dir === 'left' ? 'dislike' : dir === 'super' ? 'letter' : 'like');
}
window.swipe = swipe;

// ── LETTER COMPOSE (💌) ──────────────────────────────────────────────────────
function openLetterCompose() {
  const top = currentDiscoverCard();
  if (!top) { showToast(T('discover_no_more', 'Профилей больше нет')); return; }
  const target = document.getElementById('letterTarget');
  if (target) target.textContent = `${T('discover_letter_to', 'Кому')}: ${top.dataset.username}`;
  document.getElementById('letterText').value = '';
  document.getElementById('letterError').classList.remove('show');
  document.getElementById('letterOverlay').classList.add('show');
  setTimeout(() => document.getElementById('letterText').focus(), 50);
}
window.openLetterCompose = openLetterCompose;

function closeLetterCompose() {
  document.getElementById('letterOverlay').classList.remove('show');
}
window.closeLetterCompose = closeLetterCompose;

async function sendLetter() {
  const text = (document.getElementById('letterText').value || '').trim();
  const err = document.getElementById('letterError');
  if (!text) { err.textContent = T('discover_letter_empty', 'Напиши сообщение'); err.classList.add('show'); return; }
  closeLetterCompose();
  await discoverAct('letter', text);
}
window.sendLetter = sendLetter;

// ── LIKES INBOX (💖) ─────────────────────────────────────────────────────────
async function refreshLikesBadge() {
  try {
    const data = await api('/api/users/likes');
    const n = (data.likes || []).length;
    const badge = document.getElementById('likesBadge');
    if (badge) {
      badge.textContent = n > 9 ? '9+' : String(n);
      badge.style.display = n > 0 ? 'flex' : 'none';
    }
    window.__likesCache = data.likes || [];
  } catch (_) {}
}
window.refreshLikesBadge = refreshLikesBadge;

async function openLikesInbox() {
  const overlay = document.getElementById('likesInboxOverlay');
  const list = document.getElementById('likesInboxList');
  overlay.classList.add('show');
  list.innerHTML = `<div class="section-sub" style="text-align:center;padding:20px 0">${T('status_loading', 'Загрузка...')}</div>`;
  try {
    const data = await api('/api/users/likes');
    const likes = data.likes || [];
    window.__likesCache = likes;
    refreshLikesBadge();
    if (!likes.length) {
      list.innerHTML = `<div class="section-sub" style="text-align:center;padding:24px 0">${T('discover_likes_empty', 'Пока никто не лайкнул — но всё впереди!')}</div>`;
      return;
    }
    list.innerHTML = likes.map((like) => {
      const u = like.user || {};
      const uname = escHtml(u.username || '').replace(/'/g, "\\'");
      const games = (u.user_games || []).map((g) => (window.gameById ? window.gameById(g.game_id || (g.games && g.games.id)).emoji : '🎮')).join(' ');
      const badge = like.action === 'letter' ? `<span class="like-kind like-kind-letter">💌 ${T('discover_letter', 'Письмо')}</span>` : `<span class="like-kind">❤️ ${T('discover_like', 'Лайк')}</span>`;
      const msg = like.message ? `<div class="like-msg">💬 ${escHtml(like.message)}</div>` : '';
      return `<div class="like-row">
        <div class="like-ava" onclick="openUserProfilePopup('${escHtml(u.id)}')">${avatarHtml(u.avatar_emoji, u.avatar_url)}</div>
        <div class="like-info">
          <div class="like-top"><span class="like-name" onclick="openUserProfilePopup('${escHtml(u.id)}')">${escHtml(u.username || '')}${u.age ? `, ${u.age}` : ''}</span> ${badge}</div>
          <div class="like-meta">${u.country ? `🌍 ${escHtml(u.country)} · ` : ''}${escHtml((u.languages || []).map((l) => l.toUpperCase()).join(', '))} ${games}</div>
          ${msg}
          <div class="like-actions">
            <button class="like-back" onclick="likeBack('${escHtml(u.id)}','${uname}',this)">❤️ ${T('discover_like_back', 'Лайкнуть в ответ')}</button>
            <button class="like-pass" onclick="likePass('${escHtml(u.id)}',this)">👎</button>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div class="section-sub" style="text-align:center;padding:24px 0">${T('profile_err_load', 'Не удалось загрузить')}</div>`;
  }
}
window.openLikesInbox = openLikesInbox;

function closeLikesInbox() {
  document.getElementById('likesInboxOverlay').classList.remove('show');
}
window.closeLikesInbox = closeLikesInbox;

async function likeBack(userId, username, btn) {
  if (btn) btn.disabled = true;
  try {
    const data = await api('/api/users/discover/like', { method: 'POST', body: JSON.stringify({ targetUserId: userId, action: 'like' }) });
    if (btn) {
      const row = btn.closest('.like-row');
      if (row) row.remove();
    }
    refreshLikesBadge();
    if (data.matched) {
      showToast(`🎉 ${T('discover_its_a_match', 'Взаимный лайк с')} ${username}!`);
      // Offer to jump straight into a chat.
      if (typeof openDM === 'function') setTimeout(() => openDM(userId, username, '🎮'), 400);
    } else {
      showToast(`❤️ ${T('discover_liked', 'Лайк отправлен')}`);
    }
  } catch (e) {
    if (btn) btn.disabled = false;
    showToast(`${T('err_generic', 'Ошибка')} ${e.message}`);
  }
}
window.likeBack = likeBack;

async function likePass(userId, btn) {
  if (btn) btn.disabled = true;
  try {
    await api('/api/users/discover/like', { method: 'POST', body: JSON.stringify({ targetUserId: userId, action: 'dislike' }) });
    const row = btn && btn.closest('.like-row');
    if (row) row.remove();
    refreshLikesBadge();
  } catch (e) {
    if (btn) btn.disabled = false;
  }
}
window.likePass = likePass;

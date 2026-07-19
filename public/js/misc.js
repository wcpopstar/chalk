// ── USER PROFILE POPUP — click a user in global chat to view + add friend ──
async function openUserProfilePopup(userId) {
  if (currentUser && userId === currentUser.id) return; // don't open your own popup
  const overlay = document.getElementById('userProfilePopup');
  const body = document.getElementById('upBody');
  body.innerHTML = '<button class="gc-close-btn" style="float:right" onclick="closeUserProfilePopup()">✕</button><div style="font-size:11px;color:var(--muted);padding:30px 0"><span data-i18n="status_loading">Загрузка...</span></div>';
  overlay.classList.add('show');

  try {
    const data = await api(`/api/users/${  userId}`);
    const u = data.user;
    const meta = [];
    if (u.age) meta.push(`${u.age  } ${  T('unit_years')}`);
    if (u.country) meta.push(`🌍 ${  u.country}`);
    if (u.gender) meta.push(genderLabel(u.gender));

    const alreadyFriend = Boolean(u.id && currentFriendIds.has(String(u.id)));
    const uname = escHtml(u.username).replace(/'/g,"\\'");

    if (u.blocked_by_me) {
      body.innerHTML =
        `<button class="gc-close-btn" style="float:right" onclick="closeUserProfilePopup()">✕</button>` +
        `<div class="up-avatar">${  avatarHtml(u.avatar_emoji, u.avatar_url)  }</div>` +
        `<div class="up-name">${  escHtml(u.username)  }</div>` +
        `<div class="up-meta" style="color:#f87171">🚫 ${  T('blocked_label')  }</div>` +
        `<div class="up-actions">` +
          `<button class="auth-btn" style="background:var(--surface2);color:var(--text)" onclick="unblockUserAction('${  u.id  }','${  uname  }');closeUserProfilePopup()"><span data-i18n="blocked_unblock_btn">Разблокировать</span></button>` +
        `</div>`;
      return;
    }

    // External gaming profiles (Steam, PSN, tracker.gg, ...) — handles are
    // charset-validated server-side and the URL is built from a fixed
    // per-platform template, so these hrefs can't be arbitrary links.
    const gl = u.gaming_links || {};
    const linkBtns = GAMING_LINK_PLATFORMS
      .filter((p) => gl[p.key])
      .map((p) => `<a class="up-gaming-link" href="${  gamingLinkUrl(p.key, gl[p.key])  }" target="_blank" rel="noopener noreferrer" title="${  escHtml(gl[p.key])  }">${  p.ico  } ${  p.label  }</a>`)
      .join('');

    body.innerHTML =
      `<button class="gc-close-btn" style="float:right" onclick="closeUserProfilePopup()">✕</button>` +
      `<div class="up-avatar">${  avatarHtml(u.avatar_emoji, u.avatar_url)  }</div>` +
      `<div class="up-name">${  escHtml(u.username)  }</div>${ 
      u.status_text ? `<div class="up-status-text">💬 ${  escHtml(u.status_text)  }</div>` : '' 
      }<div class="up-meta">${  escHtml(meta.join(' · ') || T('default_player_name'))  }</div>` +
      `<div class="up-bio">${  escHtml(u.bio || T('looking_for_teammates_status'))  }</div>${ 
      linkBtns ? `<div class="up-gaming-links">${  linkBtns  }</div>` : '' 
      }<div class="up-actions">` +
        `<button class="auth-btn" id="upAddFriendBtn" ${  alreadyFriend ? 'disabled style="opacity:.6"' : ''  } onclick="sendFriendRequestFromPopup('${  u.id  }','${  uname  }')">${  alreadyFriend ? `✓ ${  T('friends_already')}` : `+ ${  T('friends_add')}`  }</button>` +
        `<button class="auth-btn" style="background:var(--surface2);color:var(--text)" onclick="callFriend('${  u.id  }','${  uname  }','${  u.avatar_emoji || '🎮'  }',${  Boolean(friendCallStatus[u.id] && friendCallStatus[u.id].inCall)  },${  (friendCallStatus[u.id] && friendCallStatus[u.id].roomSize) || 0  })">📞 ${  T('btn_call')  }</button>` +
        `<button class="auth-btn" style="background:var(--surface2);color:var(--text)" onclick="closeUserProfilePopup();openDM('${  u.id  }','${  uname  }','${  u.avatar_emoji || '🎮'  }')">💬 ${  T('btn_write')  }</button>` +
        `<div class="up-danger-row">${ 
          alreadyFriend ? `<button onclick="unfriendUser('${  u.id  }','${  uname  }')">🚫 ${  T('fam_unfriend')  }</button>` : '' 
          }<button onclick="blockUserAction('${  u.id  }','${  uname  }')">⛔ ${  T('fam_block')  }</button>` +
          `<button onclick="openReportModal('${  u.id  }','${  uname  }')">🚩 ${  T('fam_report')  }</button>` +
        `</div>` +
      `</div>` +
      `<div class="up-reviews" id="upReviews"></div>`;
    // Text reviews left after calls — fetched separately so the popup shows
    // immediately and fills in the reviews when they arrive.
    loadUserReviews(u.id);
  } catch(e) {
    body.innerHTML = '<button class="gc-close-btn" style="float:right" onclick="closeUserProfilePopup()">✕</button><div style="font-size:12px;color:var(--muted);padding:30px 0"><span data-i18n="profile_err_load">Не удалось загрузить профиль</span></div>';
  }
}

function closeUserProfilePopup() {
  document.getElementById('userProfilePopup').classList.remove('show');
}

// ── Most-active-users leaderboard (time in calls + rating) ──────────────────
// formatCallDuration() moved to public/web/utils/format.js (bridged onto window).

async function openLeaderboard() {
  const overlay = document.getElementById('leaderboardOverlay');
  const list = document.getElementById('leaderboardList');
  if (!overlay || !list) return;
  overlay.classList.add('show');
  list.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:20px 0;text-align:center">${  T('status_loading', 'Загрузка...')  }</div>`;
  try {
    const data = await api('/api/users/leaderboard');
    const leaders = data.leaders || [];
    if (!leaders.length) {
      list.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:20px 0;text-align:center">${  T('leaderboard_empty', 'Пока никто не набрал время в звонках')  }</div>`;
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    list.innerHTML = leaders.map((u, i) => {
      const rank = medals[i] || `${i + 1}`;
      const ava = avatarHtml(u.avatar_emoji, u.avatar_url);
      const rating = u.avg_rating ? `⭐ ${  Number(u.avg_rating).toFixed(1)}` : '';
      const time = formatCallDuration(u.total_call_seconds);
      const uname = escHtml(u.username || '').replace(/'/g, "\\'");
      const clickable = (currentUser && u.id === currentUser.id) ? '' : ` onclick="closeLeaderboard();openUserProfilePopup('${  escHtml(u.id)  }')" style="cursor:pointer"`;
      return `<div class="lb-row"${  clickable  }>` +
        `<div class="lb-rank">${  rank  }</div>` +
        `<div class="lb-ava">${  ava  }</div>` +
        `<div class="lb-info"><div class="lb-name">${  escHtml(u.username || '')  }</div>` +
        `<div class="lb-meta">🎧 ${  time  }${  rating ? ` · ${  rating}` : ''  }</div></div></div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:20px 0;text-align:center">${  T('profile_err_load', 'Не удалось загрузить')  }</div>`;
  }
}

function closeLeaderboard() {
  const overlay = document.getElementById('leaderboardOverlay');
  if (overlay) overlay.classList.remove('show');
}

// Loads and renders the text reviews a user has received after calls.
async function loadUserReviews(userId) {
  const box = document.getElementById('upReviews');
  if (!box) return;
  try {
    const data = await api(`/api/users/${  userId  }/reviews`);
    const reviews = data.reviews || [];
    if (!reviews.length) return; // no reviews → leave the section empty
    const starsFor = (n) => `${'★'.repeat(Math.max(0, Math.min(5, n)))  }${'☆'.repeat(5 - Math.max(0, Math.min(5, n)))}`;
    box.innerHTML =
      `<div class="up-reviews-title">💬 ${  T('reviews_title', 'Отзывы')  } · ${  reviews.length  }</div>${
      reviews.map((r) =>{
        const who = (r.rater && r.rater.username) ? escHtml(r.rater.username) : T('status_user');
        const ava = r.rater ? avatarHtml(r.rater.avatar_emoji, r.rater.avatar_url) : '🙂';
        const verified = r.verified_call
          ? `<span class="up-review-verified" title="${  escHtml(T('review_verified_call', 'Подтверждённый созвон'))  }">✓ ${  escHtml(T('review_verified_call', 'Подтверждённый созвон'))  }</span>`
          : '';
        return `<div class="up-review"><div class="up-review-head"><span class="up-review-ava">${  ava  }</span>` +
          `<span class="up-review-name">${  who  }</span>${  verified  }<span class="up-review-stars">${  starsFor(r.rating)  }</span></div>` +
          `<div class="up-review-text">${  escHtml(r.comment || '')  }</div></div>`;
      }).join('')}`;
  } catch (_) { /* non-fatal: just omit reviews */ }
}

async function sendFriendRequestFromPopup(userId, username) {
  if (userId && currentFriendIds.has(String(userId))) {
    showToast(`✓ ${  T('friends_already')}`);
    return;
  }
  const btn = document.getElementById('upAddFriendBtn');
  if (btn) { btn.disabled = true; btn.textContent = T('auth_sending'); }
  try {
    await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ targetUserId: userId }) });
    if (btn) { btn.textContent = `✓ ${  T('friends_request_sent_short')}`; }
    showToast(`✓ ${  T('friends_request_sent_msg')  } ${  username}`);
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = `+ ${  T('friends_add')}`; }
    showToast(e.message && e.message.indexOf('already') !== -1 ? T('friends_request_already_sent') : `${T('err_generic')  } ${  e.message}`);
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
// escHtml() and jsStr() moved to the first real ES module, public/web/utils/dom.js
// (bridged onto window by web/entry.js), as the opening step of the modules
// migration. They remain callable globally here exactly as before.

var toastTimeout = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() =>{ t.classList.remove('show') }, 3000);
}


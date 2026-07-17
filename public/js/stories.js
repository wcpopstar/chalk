// ── STORIES (Instagram/Telegram-style, 24h) ─────────────────────────────────
// Stories live directly on avatars — no separate strip:
//  • Your own sidebar avatar has a small ＋ badge (top-left) to post a story;
//    once you've posted, the avatar gets a highlight ring and clicking it
//    opens your own story.
//  • A friend who has an active story gets the same highlight ring on their
//    avatar in the friends list; clicking that avatar opens their story.
// Images are resized to a small JPEG client-side and stored as a data URL
// (same approach as avatars) — see /api/stories.

var storiesFeed = { me: null, friends: [] };
var _storyPendingImage = null;   // resized data URL awaiting post
var _storyFriendIndex = {};      // friend userId -> index into storiesFeed.friends

// ── Load + reflect story state onto avatars ─────────────────────────────────
async function loadStories() {
  try {
    const data = await api('/api/stories');
    storiesFeed = { me: data.me || null, friends: data.friends || [] };
    _storyFriendIndex = {};
    (storiesFeed.friends || []).forEach((g, i) => {
      if (g.user && g.user.id) _storyFriendIndex[g.user.id] = i;
    });
    refreshStoryUI();
  } catch (e) { /* non-fatal: avatars just render without a story ring */ }
}

// Re-apply story rings to the sidebar avatar and (re)render the friends list
// so their avatars pick up rings too.
function refreshStoryUI() {
  updateSidebarStoryUI();
  renderStoriesStrip();
  if (typeof renderFriendsList === 'function') { try { renderFriendsList(); } catch (_) {} }
}

// ── Stories strip at the top of the Chats tab ───────────────────────────────
// A horizontal tray (Instagram/Telegram-style) shown above the conversation
// list: your own story tile first, then every friend who has an active story.
// Tapping a tile opens the composer (yours, if empty) or the story viewer.
function renderStoriesStrip() {
  const strip = document.getElementById('storiesStrip');
  if (!strip) return;
  const friends = storiesFeed.friends || [];
  // Nothing to show and no way to post → hide the strip entirely.
  const tiles = [];

  // Your own tile: ＋ badge when you have no story, ring when you do.
  const meRing = iHaveStory() ? ' has-story' : '';
  const meAva = (typeof avatarHtml === 'function' && currentUser)
    ? avatarHtml(currentUser.avatar_emoji, currentUser.avatar_url) : '🙂';
  tiles.push(
    `<div class="story-tile" onclick="onOwnAvatarClick(event)">` +
    `<div class="story-tile-ava avatar-story${  meRing  }">${  meAva  }${  iHaveStory() ? '' : '<div class="story-tile-add">＋</div>'  }</div>` +
    `<div class="story-tile-name">${  T('stories_your', 'Ваша')  }</div></div>`
  );

  friends.forEach((g, idx) => {
    if (!g.user) return;
    const ringClass = g.all_viewed ? 'avatar-story has-story story-seen' : 'avatar-story has-story';
    const ava = (typeof avatarHtml === 'function') ? avatarHtml(g.user.avatar_emoji, g.user.avatar_url) : '🙂';
    // Caption prefers the friend's custom status text, falling back to name.
    const caption = (g.user.status_text && g.user.status_text.trim()) ? g.user.status_text : g.user.username;
    tiles.push(
      `<div class="story-tile" onclick="openStoryViewer('friends', ${  idx  })" title="${  escHtml(g.user.username || '')  }">` +
      `<div class="story-tile-ava ${  ringClass  }">${  ava  }</div>` +
      `<div class="story-tile-name">${  escHtml(caption || '')  }</div></div>`
    );
  });

  strip.innerHTML = tiles.join('');
  // Show the strip whenever there's a friend story to see (your own ＋ tile
  // alone would just duplicate the sidebar avatar's composer entry point).
  strip.style.display = friends.length ? 'flex' : 'none';
}

// ── Own sidebar avatar: ＋ badge + "has story" ring ─────────────────────────
function iHaveStory() {
  return Boolean(storiesFeed.me && storiesFeed.me.stories && storiesFeed.me.stories.length);
}

function updateSidebarStoryUI() {
  const av = document.getElementById('sidebarAvatar');
  if (!av) return;
  av.classList.add('avatar-story');
  av.classList.toggle('has-story', iHaveStory());
  // Clicking the avatar itself opens your own story (only meaningful when you
  // have one); the ＋ badge always opens the composer.
  av.onclick = onOwnAvatarClick;
  let badge = av.querySelector('.avatar-story-add');
  if (!badge) {
    // Appended as a child, so a later innerHTML reset of the avatar (edit
    // profile) drops it — callers re-run updateSidebarStoryUI() afterwards.
    badge = document.createElement('div');
    badge.className = 'avatar-story-add';
    badge.textContent = '＋';
    badge.title = T('stories_new', 'Новая история');
    badge.onclick = function (e) { e.stopPropagation(); openStoryComposer(); };
    av.appendChild(badge);
  }
}

function onOwnAvatarClick(e) {
  if (e) e.stopPropagation();
  if (iHaveStory()) openStoryViewer('me', 0);
  else openStoryComposer();
}

// ── Friend avatars: ring + click-to-open (used by friends-list.js) ──────────
// Returns null if this friend has no active story, otherwise { viewed }.
function friendStoryState(userId) {
  const idx = _storyFriendIndex[userId];
  if (idx === undefined) return null;
  const g = storiesFeed.friends[idx];
  if (!g || !g.stories || !g.stories.length) return null;
  return { viewed: Boolean(g.all_viewed) };
}

// Extra class for a friend avatar based on story state ('' if none).
function friendStoryRingClass(userId) {
  const s = friendStoryState(userId);
  if (!s) return '';
  return s.viewed ? 'avatar-story has-story story-seen' : 'avatar-story has-story';
}

// Click handler for a friend avatar: if they have a story, open it and stop
// the click from also opening the friend context menu; otherwise do nothing
// and let the click bubble up to the row (opens the menu, as before).
function onFriendAvatarClick(event, userId) {
  if (!friendStoryState(userId)) return;
  event.stopPropagation();
  const idx = _storyFriendIndex[userId];
  if (idx !== undefined) openStoryViewer('friends', idx);
}

// ── Composer (pick photo → resize → post) ───────────────────────────────────
function openStoryComposer() {
  _storyPendingImage = null;
  const prev = document.getElementById('storyComposePreview');
  if (prev) prev.innerHTML = `<span class="story-compose-hint">${  T('stories_pick_photo', 'Нажми, чтобы выбрать фото')  }</span>`;
  const cap = document.getElementById('storyCaption'); if (cap) cap.value = '';
  const err = document.getElementById('storyComposeError'); if (err) err.classList.remove('show');
  document.getElementById('storyComposerOverlay').classList.add('show');
}

function closeStoryComposer() {
  document.getElementById('storyComposerOverlay').classList.remove('show');
  _storyPendingImage = null;
}

// Resize an uploaded image to a portrait-friendly JPEG data URL (longest side
// capped) so the stored payload stays well under the API body limit.
function handleStoryFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file
  if (!file) return;
  if (!file.type.startsWith('image/')) { storyComposeError(T('profile_choose_image_file', 'Выбери изображение')); return; }
  if (file.size > 12 * 1024 * 1024) { storyComposeError(T('profile_file_too_large', 'Файл слишком большой')); return; }

  const reader = new FileReader();
  reader.onload = function () {
    const img = new Image();
    img.onload = function () {
      const maxSide = 1280;
      let w = img.width; let h = img.height;
      if (w > h && w > maxSide) { h = Math.round(h * maxSide / w); w = maxSide; }
      else if (h >= w && h > maxSide) { w = Math.round(w * maxSide / h); h = maxSide; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      _storyPendingImage = dataUrl;
      const prev = document.getElementById('storyComposePreview');
      if (prev) prev.innerHTML = `<img src="${  dataUrl  }" alt="">`;
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function storyComposeError(msg) {
  const el = document.getElementById('storyComposeError');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

async function postStory() {
  if (!_storyPendingImage) { storyComposeError(T('stories_need_photo', 'Сначала выбери фото')); return; }
  const caption = (document.getElementById('storyCaption').value || '').trim();
  const btn = document.getElementById('storyPostBtn');
  btn.disabled = true;
  try {
    await api('/api/stories', { method: 'POST', body: JSON.stringify({ image: _storyPendingImage, caption: caption || undefined }) });
    closeStoryComposer();
    showToast(`📸 ${  T('stories_posted', 'История опубликована')}`);
    loadStories();
  } catch (e) {
    storyComposeError(e.message || T('err_generic', 'Ошибка'));
  } finally {
    btn.disabled = false;
  }
}

// ── Viewer ──────────────────────────────────────────────────────────────────
var _storyViewGroups = [];
var _storyGroupIdx = 0;
var _storyIdx = 0;
var _storyTimer = null;
var _storyIsMine = false;
var STORY_DURATION_MS = 5000;

function openStoryViewer(which, groupIndex) {
  _storyIsMine = which === 'me';
  _storyViewGroups = _storyIsMine ? (storiesFeed.me ? [storiesFeed.me] : []) : (storiesFeed.friends || []);
  if (!_storyViewGroups.length) return;
  _storyGroupIdx = Math.max(0, Math.min(groupIndex || 0, _storyViewGroups.length - 1));
  _storyIdx = 0;
  document.getElementById('storyViewer').classList.add('show');
  renderCurrentStory();
}

function _currentStoryGroup() { return _storyViewGroups[_storyGroupIdx]; }
function _currentStory() { const g = _currentStoryGroup(); return g && g.stories ? g.stories[_storyIdx] : null; }

function renderCurrentStory() {
  const group = _currentStoryGroup();
  const story = _currentStory();
  if (!group || !story) { closeStoryViewer(); return; }
  const u = group.user || {};

  document.getElementById('storyViewerAva').innerHTML = avatarHtml(u.avatar_emoji, u.avatar_url);
  document.getElementById('storyViewerName').textContent = _storyIsMine ? T('stories_your_story', 'Ваша история') : (u.username || '');
  document.getElementById('storyViewerTime').textContent = storyTimeAgo(story.created_at);
  document.getElementById('storyViewerImg').src = story.image_url;
  const cap = document.getElementById('storyViewerCaption');
  cap.textContent = story.caption || '';
  cap.style.display = story.caption ? '' : 'none';
  document.getElementById('storyViewerDel').style.display = _storyIsMine ? '' : 'none';

  // Progress segments (one per story in this group; the current one animates).
  const prog = document.getElementById('storyViewerProgress');
  prog.innerHTML = group.stories.map((_, i) =>
    `<div class="story-prog-seg"><div class="story-prog-fill ${  i < _storyIdx ? 'done' : (i === _storyIdx ? 'active' : '')  }"></div></div>`
  ).join('');

  // Mark seen (best-effort) and reflect it in the strip ring once done.
  markStoryViewed(story);

  clearTimeout(_storyTimer);
  _storyTimer = setTimeout(() => storyNav(1), STORY_DURATION_MS);
}

function storyNav(dir) {
  clearTimeout(_storyTimer);
  const group = _currentStoryGroup();
  if (!group) { closeStoryViewer(); return; }
  const idx = _storyIdx + dir;
  if (idx >= 0 && idx < group.stories.length) { _storyIdx = idx; renderCurrentStory(); return; }

  // Ran off either end of this author's stories → move to the prev/next author.
  const gi = _storyGroupIdx + dir;
  if (gi < 0) { _storyIdx = 0; renderCurrentStory(); return; } // already at very first
  if (gi >= _storyViewGroups.length) { closeStoryViewer(); return; } // finished all
  _storyGroupIdx = gi;
  _storyIdx = dir > 0 ? 0 : (_storyViewGroups[gi].stories.length - 1);
  renderCurrentStory();
}

function closeStoryViewer() {
  clearTimeout(_storyTimer);
  document.getElementById('storyViewer').classList.remove('show');
  // Rings may have flipped to "seen" while viewing — refresh the avatars.
  refreshStoryUI();
}

var _storyViewedSent = {};
function markStoryViewed(story) {
  if (!story || story.viewed || _storyViewedSent[story.id]) return;
  _storyViewedSent[story.id] = true;
  story.viewed = true;
  // Recompute the group's all_viewed for the ring (only friends' rings care).
  const g = _currentStoryGroup();
  if (g && !_storyIsMine) g.all_viewed = g.stories.every((s) => s.viewed);
  api(`/api/stories/${  story.id  }/view`, { method: 'POST' }).catch(() => {});
}

async function deleteCurrentStory() {
  const story = _currentStory();
  if (!story) return;
  if (!confirm(T('stories_delete_confirm', 'Удалить эту историю?'))) return;
  try {
    await api(`/api/stories/${  story.id  }`, { method: 'DELETE' });
    closeStoryViewer();
    loadStories();
    showToast(T('stories_deleted', 'История удалена'));
  } catch (e) { showToast(`${T('err_generic', 'Ошибка')  } ${  e.message}`); }
}

function storyTimeAgo(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return T('last_seen_just_now', 'только что');
  if (diff < 3600) return `${Math.floor(diff / 60)  } ${  T('unit_min', 'мин')}`;
  return `${Math.floor(diff / 3600)  } ${  T('unit_hour', 'ч')}`;
}

// ── INIT ─────────────────────────────────────────────────────────────────────
window.addEventListener('voice:status', (event) => {
  showToast(event.detail && event.detail.message ? event.detail.message : 'Voice status updated');
});

(function checkResetLink() {
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get('reset');
  if (resetToken) {
    window.__resetToken = resetToken;
    switchAuthTab('reset', null);
  }
})();

checkAuth();
applyI18n();

// ── Re-render dynamic content on language change ────────────────────────────
// applyI18n() (triggered from setLang) only updates elements marked with
// [data-i18n]/[data-i18n-placeholder]/[data-i18n-title]. Lists that are built
// from JS templates (friends list, chat list, discover cards, profile page)
// bake translated strings straight into the HTML text and have no such
// attribute on the whole node, so they used to keep showing stale text —
// especially noticeable after switching languages a few times, since each
// screen only "catches up" once you happen to reload its data. This just
// re-renders whatever is currently on screen from data we already have in
// memory (no extra network calls), plus reloads the profile page if it's the
// active tab.
function rerenderFriendsOnLangChange() {
  if (typeof lastOnlineFriends !== 'undefined' && lastOnlineFriends.length && typeof renderFriendsList === 'function') renderFriendsList();
}

function rerenderChatsOnLangChange() {
  if (typeof lastConversations !== 'undefined' && lastConversations && typeof renderChatsList === 'function') renderChatsList();
}

function rerenderDiscoverOnLangChange() {
  if (typeof discoverUsers !== 'undefined' && discoverUsers.length && typeof renderTinderCards === 'function') renderTinderCards();
}

function rerenderChatHeaderOnLangChange() {
  if (!currentConvId || !currentConvPartner) return;
  const statusEl = document.getElementById('chatHeaderStatus');
  if (statusEl) statusEl.textContent = currentConvPartner.status === 'online' ? T('status_online_lc') : T('status_offline_lc');
}

function reloadProfileOnLangChange() {
  const profilePage = document.getElementById('page-profile');
  if (currentUser && profilePage && profilePage.classList.contains('active') && typeof loadProfile === 'function') loadProfile();
}

document.addEventListener('i18n:change', () => {
  // Each block is independent and best-effort: one screen failing to
  // re-render must not stop the others.
  try { rerenderFriendsOnLangChange(); } catch (_) {}
  try { rerenderChatsOnLangChange(); } catch (_) {}
  try { rerenderDiscoverOnLangChange(); } catch (_) {}
  try { rerenderChatHeaderOnLangChange(); } catch (_) {}
  try { reloadProfileOnLangChange(); } catch (_) {}
});


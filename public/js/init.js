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


// ── INIT ─────────────────────────────────────────────────────────────────────
window.addEventListener('voice:status', function (event) {
  showToast(event.detail && event.detail.message ? event.detail.message : 'Voice status updated');
});

(function checkResetLink() {
  var params = new URLSearchParams(window.location.search);
  var resetToken = params.get('reset');
  if (resetToken) {
    window.__resetToken = resetToken;
    switchAuthTab('reset', null);
  }
})();

checkAuth();
applyI18n();


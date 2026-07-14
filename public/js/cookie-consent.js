// ── COOKIE / STORAGE CONSENT ────────────────────────────────────────────────
// Shown once on first visit. "Essential only" keeps the app fully working
// (the auth token / language / theme in localStorage are strictly necessary),
// while "Allow" additionally opts into optional things — analytics and the
// desktop notifications permission prompt. The choice itself is remembered in
// localStorage so the banner never nags again.
var COOKIE_CONSENT_KEY = 'chalk_cookie_consent';

function cookieConsentValue() {
  try { return localStorage.getItem(COOKIE_CONSENT_KEY); } catch (_) { return null; }
}

function cookieConsentGranted() {
  return cookieConsentValue() === 'accepted';
}

function showCookieBanner() {
  const b = document.getElementById('cookieBanner');
  if (b) b.style.display = 'flex';
}

function hideCookieBanner() {
  const b = document.getElementById('cookieBanner');
  if (b) b.style.display = 'none';
}

function setCookieConsent(accepted) {
  try { localStorage.setItem(COOKIE_CONSENT_KEY, accepted ? 'accepted' : 'declined'); } catch (_) {}
  hideCookieBanner();
  if (accepted && typeof requestNotificationPermission === 'function') {
    // Runs inside the click handler, so it counts as a user gesture and the
    // browser will actually show the permission prompt.
    requestNotificationPermission();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!cookieConsentValue()) {
    showCookieBanner();
  } else if (cookieConsentGranted() && typeof maybeInitNotifications === 'function') {
    maybeInitNotifications();
  }
});

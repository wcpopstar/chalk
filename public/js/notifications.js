// ── DESKTOP NOTIFICATIONS ───────────────────────────────────────────────────
// Web Notifications for new messages and incoming calls. Gated on the cookie
// consent (notifications are one of the "optional" things the banner asks
// about) AND the browser permission. Permission is requested from the
// consent-accept click (a real user gesture, which browsers require).

function notificationsAllowed() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  if (typeof cookieConsentGranted === 'function' && !cookieConsentGranted()) return false;
  return true;
}

function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    try {
      const r = Notification.requestPermission();
      // Older callback-style API returns undefined; the promise form returns a
      // thenable — swallow rejections either way.
      if (r && typeof r.then === 'function') r.catch(() => {});
    } catch (_) { /* unsupported permission model — ignore */ }
  }
}

// Placeholder hook: nothing to eagerly initialise (permission is only ever
// requested from a user gesture), but keeping the name lets cookie-consent.js
// call it unconditionally.
function maybeInitNotifications() {}

function showAppNotification(title, body) {
  if (!notificationsAllowed()) return;
  try {
    const n = new Notification(title, { body: body || '', tag: 'chalk', icon: '/favicon.ico' });
    n.onclick = function () { try { window.focus(); } catch (_) {} n.close(); };
    setTimeout(() => { try { n.close(); } catch (_) {} }, 8000);
  } catch (_) { /* some browsers throw if constructed without a service worker on mobile */ }
}

// Only notify for messages when the tab isn't focused — an on-screen chat
// doesn't need an OS popup on top of the bubble that just appeared.
function notifyNewMessage(senderName) {
  if (!document.hidden) return;
  showAppNotification(T('notif_new_message'), senderName || '');
}

// Calls are time-sensitive, so notify regardless of focus (the in-app confirm
// dialog only helps if the tab is already in front).
function notifyIncomingCall(fromName) {
  showAppNotification(T('notif_incoming_call'), fromName || '');
}

// ── CONFIG ──────────────────────────────────────────────────────────────────
var API = window.location.origin;
var token = localStorage.getItem('chalk_token');
var refreshToken = localStorage.getItem('chalk_refresh_token');
var currentUser = null;
var socket = null;
var friendsPollInterval = null;
var currentMode = 'solo';
var squadSize = 4;
var selectedGameId = 'valorant';
var isSearching = false;
var currentRoomId = null;
var currentCallParticipants = [];
var currentConvId = null;
var dmPartnersByConv = {};   // convId -> { id, username, avatar_emoji, avatar_url, status }
var currentConvPartner = null;
var pendingChatConversationId = null;
var trialSeconds = 120;
var trialInterval = null;
var trialVoted = false;
var trialMuted = false;
var fcSeconds = 0;
var fcInterval = null;
var fcMuted = false;
var fcDeafened = false;
var discoverUsers = [];
var discoverIndex = 0;
var currentFriendIds = new Set();
var currentCallMatchIds = {};

// ── SESSION HELPERS ──────────────────────────────────────────────────────────
// Access token: short-lived JWT (15 min), kept in memory + localStorage.
// Refresh token: long-lived opaque secret, only ever used to hit /api/auth/refresh.
function setSession(data) {
  token = data.token || token;
  refreshToken = data.refreshToken || refreshToken;
  if (data.user) currentUser = data.user;
  if (token) localStorage.setItem('chalk_token', token);
  if (refreshToken) localStorage.setItem('chalk_refresh_token', refreshToken);
}

function clearSession() {
  token = null;
  refreshToken = null;
  currentUser = null;
  localStorage.removeItem('chalk_token');
  localStorage.removeItem('chalk_refresh_token');
}

// Exchanges the stored refresh token for a new access+refresh pair.
// Concurrent callers share one in-flight request so a burst of 401s doesn't
// fire a burst of refresh calls. Returns false if the session can no longer
// be renewed (refresh token missing/expired/reused) — treat that as logged out.
var _refreshInFlight = null;
function refreshSession() {
  if (!refreshToken) return false;
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    try {
      const r = await fetch(`${API  }/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return false;
      setSession(data);
      return true;
    } catch (_) {
      return false;
    } finally {
      _refreshInFlight = null;
    }
  })();

  return _refreshInFlight;
}

// Session can't be renewed — drop back to the login screen without another
// round trip to the server.
function forceLogout() {
  clearSession();
  if (typeof socket !== 'undefined' && socket) { try { socket.disconnect(); } catch (_) {} }
  const authScreen = document.getElementById('authScreen');
  if (authScreen) authScreen.classList.remove('hidden');
  const mainNav = document.getElementById('mainNav');
  const mainApp = document.getElementById('mainApp');
  if (mainNav) mainNav.style.display = 'none';
  if (mainApp) mainApp.style.display = 'none';
  const bubble = document.getElementById('globalChatBubble');
  const panel = document.getElementById('globalChatPanel');
  if (bubble) bubble.style.display = 'none';
  if (panel) panel.style.display = 'none';
}

// ── API HELPER ───────────────────────────────────────────────────────────────
// On a 401 caused by an expired/revoked access token, transparently refreshes
// the session once and retries the original request. If the refresh itself
// fails (refresh token expired/revoked/reused), the user is logged out.
async function api(path, opts, _isRetry) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' });
  if (token) opts.headers['Authorization'] = `Bearer ${  token}`;

  const r = await fetch(API + path, opts);
  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const tokenStale = r.status === 401 && (data.code === 'TOKEN_EXPIRED' || data.code === 'TOKEN_REVOKED');
    if (tokenStale && !_isRetry) {
      const renewed = await refreshSession();
      if (renewed) return api(path, opts, true);
      forceLogout();
    }
    throw new Error(data.error || T('auth_err_server'));
  }
  return data;
}


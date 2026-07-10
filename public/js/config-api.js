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
// Concurrent callers *within this tab* share one in-flight request so a
// burst of 401s doesn't fire a burst of refresh calls (see _refreshInFlight
// below). That alone isn't enough, though: refresh tokens are single-use
// (rotate-on-use) and any two tabs/devices that both fire /refresh with the
// SAME still-valid token — e.g. because a deploy just dropped every open
// socket at once and each tab independently reconnects — will have one of
// them "win" the rotation and the other get treated as token reuse, which
// server-side revokes the *entire* session family (see
// services/refreshTokens.js), logging out every tab, including the one that
// just won. The Web Locks API below serializes refreshes ACROSS tabs (same
// origin, shared with no server round trip), and — crucially — after
// acquiring the lock we re-read localStorage rather than trusting our
// possibly-stale in-memory copy: if another tab already refreshed while we
// were waiting, we just adopt its result instead of racing it.
var _refreshInFlight = null;
function refreshSession() {
  if (!refreshToken && !localStorage.getItem('chalk_refresh_token')) return false;
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    try {
      if (window.navigator && navigator.locks && navigator.locks.request) {
        return await navigator.locks.request('chalk-refresh-lock', doRefreshExchange);
      }
      return await doRefreshExchange();
    } finally {
      _refreshInFlight = null;
    }
  })();

  return _refreshInFlight;
}

async function doRefreshExchange() {
  // Snapshot what THIS call believes is the current token, then re-check
  // storage — if another tab won the race while we waited for the lock (or
  // even before we started), localStorage will already have moved on.
  const attempted = refreshToken;
  const stored = localStorage.getItem('chalk_refresh_token');
  if (stored && stored !== attempted) {
    token = localStorage.getItem('chalk_token') || token;
    refreshToken = stored;
    return true;
  }

  const tokenToSend = stored || refreshToken;
  if (!tokenToSend) return false;

  try {
    const r = await fetch(`${API  }/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokenToSend }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return false;
    setSession(data);
    return true;
  } catch (_) {
    return false;
  }
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
    // Any 401 gets ONE transparent refresh attempt (guarded by _isRetry +
    // having a refresh token at all). Previously this matched only
    // `data.code === 'TOKEN_EXPIRED' | 'TOKEN_REVOKED'` — but the server
    // nests machine-readable codes under `details` (see src/utils/http.ts
    // sendError: `{ error, details: { code } }`), so the check NEVER
    // matched, no refresh was attempted, and any page load with a
    // >15-min-old access token logged the user out. Being code-agnostic
    // also survives a JWT_SECRET rotation, where the server answers a
    // generic 401 with no code — the refresh token is opaque and
    // DB-backed, so it renews the session either way.
    if (r.status === 401 && !_isRetry && refreshToken) {
      const renewed = await refreshSession();
      if (renewed) return api(path, opts, true);
      forceLogout();
    }
    throw new Error(data.error || T('auth_err_server'));
  }
  return data;
}


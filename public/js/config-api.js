// ── CONFIG ──────────────────────────────────────────────────────────────────
var API = window.location.origin;
var token = localStorage.getItem('chalk_token');
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

// ── API HELPER ───────────────────────────────────────────────────────────────
async function api(path, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['Content-Type'] = 'application/json';
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  var r = await fetch(API + path, opts);
  var data = await r.json();
  if (!r.ok) throw new Error(data.error || T('auth_err_server'));
  return data;
}


const { supabaseAdmin } = require('../services/supabase');

/**
 * In-memory realtime state shared by every socket handler module.
 *
 * rooms:               roomId -> { participants, mode, gameId, trialStart, promoted, votes }
 * online:              userId -> socketId  (who is currently connected)
 * userCurrentRoom:     userId -> roomId    (who is currently "in a call" right now)
 * pendingInvites:      "roomId:targetUserId" -> { inviterId, createdAt }
 *                      (set by call:invite, consumed by call:accept/call:reject)
 * pendingJoinRequests: "roomId:requesterId" -> { createdAt }
 *                      (set by call:request_join, consumed by call:join_response)
 * recentCallPartners:  "userIdA:userIdB" (sorted) -> lastSeenTimestamp
 *                      (marked whenever two users are co-participants of a
 *                      room; lets us verify "did these two actually call
 *                      each other?" after the room itself is gone)
 */
const rooms = new Map();
const online = new Map();
const userCurrentRoom = new Map();
const pendingInvites = new Map();
const pendingJoinRequests = new Map();
const recentCallPartners = new Map();

// Invites/join-requests older than this are treated as expired, so a stale
// entry can't be replayed long after the real invite would have timed out
// on the client.
const INVITE_TTL_MS = 2 * 60 * 1000;

// How long after being in a call together two users can still "quick add"
// each other as friends via the post-call button.
const CALL_PARTNER_TTL_MS = 30 * 60 * 1000;

function pairKey(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join(':');
}

// Record that these users are (or just were) co-participants of the same
// call room. Call this any time a room's participant list changes.
function markCallPartners(participantIds) {
  const ids = [...new Set(participantIds)].filter(Boolean);
  const now = Date.now();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      recentCallPartners.set(pairKey(ids[i], ids[j]), now);
    }
  }
}

// True if userIdA and userIdB are currently in the same room together, or
// were within the last CALL_PARTNER_TTL_MS.
function wereRecentCallPartners(userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;
  const roomA = userCurrentRoom.get(userIdA);
  if (roomA && roomA === userCurrentRoom.get(userIdB)) return true;

  const seenAt = recentCallPartners.get(pairKey(userIdA, userIdB));
  return !!seenAt && (Date.now() - seenAt) <= CALL_PARTNER_TTL_MS;
}

function addPendingInvite(roomId, targetUserId, inviterId) {
  pendingInvites.set(`${roomId}:${targetUserId}`, { inviterId, createdAt: Date.now() });
}

// Returns true (and consumes the entry) only if a matching, non-expired
// invite from `inviterId` to `targetUserId` for `roomId` actually exists.
function consumePendingInvite(roomId, targetUserId, inviterId) {
  const key = `${roomId}:${targetUserId}`;
  const entry = pendingInvites.get(key);
  pendingInvites.delete(key);
  if (!entry || entry.inviterId !== inviterId) return false;
  if (Date.now() - entry.createdAt > INVITE_TTL_MS) return false;
  return true;
}

function addPendingJoinRequest(roomId, requesterId) {
  pendingJoinRequests.set(`${roomId}:${requesterId}`, { createdAt: Date.now() });
}

// Returns true (and consumes the entry) only if a matching, non-expired
// join request from `requesterId` for `roomId` actually exists.
function consumePendingJoinRequest(roomId, requesterId) {
  const key = `${roomId}:${requesterId}`;
  const entry = pendingJoinRequests.get(key);
  pendingJoinRequests.delete(key);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > INVITE_TTL_MS) return false;
  return true;
}

function roomSize(roomId) {
  const room = rooms.get(roomId);
  return room ? room.participants.length : 0;
}

// ── Tell online friends whether this user just entered/left a call ─────────
async function broadcastCallStatus(io, userId) {
  try {
    const { data: friendRows } = await supabaseAdmin
      .from('friends')
      .select('user_a, user_b')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .eq('status', 'accepted');
    if (!friendRows) return;

    const roomId = userCurrentRoom.get(userId);
    const payload = { userId, inCall: !!roomId, roomSize: roomId ? roomSize(roomId) : 0 };

    for (const row of friendRows) {
      const friendId = row.user_a === userId ? row.user_b : row.user_a;
      const fSocket  = online.get(friendId);
      if (fSocket) io.to(fSocket).emit('friend:call_status', payload);
    }
  } catch (_) { /* ignore */ }
}

function setUserRoom(io, userId, roomId) {
  userCurrentRoom.set(userId, roomId);
  broadcastCallStatus(io, userId);
}

function clearUserRoom(io, userId) {
  if (!userCurrentRoom.has(userId)) return;
  userCurrentRoom.delete(userId);
  broadcastCallStatus(io, userId);
}

module.exports = {
  rooms,
  online,
  userCurrentRoom,
  roomSize,
  broadcastCallStatus,
  setUserRoom,
  clearUserRoom,
  addPendingInvite,
  consumePendingInvite,
  addPendingJoinRequest,
  consumePendingJoinRequest,
  markCallPartners,
  wereRecentCallPartners,
};

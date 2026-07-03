const { supabaseAdmin } = require('../services/supabase');
const { redis } = require('./redisClient');

/**
 * Realtime state shared by every socket handler module — now backed by
 * Redis instead of in-process Maps, so it's shared across every server
 * instance behind the load balancer.
 *
 * Redis layout:
 *   chalk:online              hash   userId    -> socketId
 *   chalk:rooms               hash   roomId    -> JSON { participants, mode, gameId, trialStart, promoted, votes }
 *   chalk:user_room           hash   userId    -> roomId          (who is currently "in a call")
 *   chalk:invite:{roomId}:{targetUserId}   string(inviterId), PX INVITE_TTL_MS
 *                              (set by call:invite, consumed by call:accept/call:reject)
 *   chalk:joinreq:{roomId}:{requesterId}   string('1'), PX INVITE_TTL_MS
 *                              (set by call:request_join, consumed by call:join_response)
 *   chalk:callpartners:{sortedPairKey}     string(timestamp), PX CALL_PARTNER_TTL_MS
 *                              (marked whenever two users are co-participants of a
 *                              room; lets us verify "did these two actually call
 *                              each other?" after the room itself is gone)
 *
 * Every previous export is preserved (setUserRoom, clearUserRoom,
 * markCallPartners, wereRecentCallPartners, addPendingInvite,
 * consumePendingInvite, addPendingJoinRequest, consumePendingJoinRequest,
 * roomSize, broadcastCallStatus) — they just return Promises now.
 *
 * Because `rooms`/`online`/`userCurrentRoom` used to be exported as raw
 * Maps and mutated directly by calls.js/match.js/presence.js/swipe.js/
 * index.js, those call sites now use the small async accessor functions
 * below (getOnlineSocket, setOnline, removeOnline, onlineCount, getRoom,
 * hasRoom, saveRoom, deleteRoom, updateRoom, getUserCurrentRoom) instead of
 * touching a Map. There's no way around this: a truly shared, cross-instance
 * store is inherently async, so a synchronous `.get()`/`.set()` API can't be
 * kept.
 */

const NS = 'chalk';
const KEY_ONLINE = `${NS}:online`;
const KEY_ROOMS = `${NS}:rooms`;
const KEY_USER_ROOM = `${NS}:user_room`;

// Invites/join-requests older than this are treated as expired. With Redis
// this is enforced natively via key TTL instead of a manually-checked
// createdAt timestamp.
const INVITE_TTL_MS = 2 * 60 * 1000;

// How long after being in a call together two users can still "quick add"
// each other as friends via the post-call button.
const CALL_PARTNER_TTL_MS = 30 * 60 * 1000;

function inviteKey(roomId, targetUserId) {
  return `${NS}:invite:${roomId}:${targetUserId}`;
}
function joinReqKey(roomId, requesterId) {
  return `${NS}:joinreq:${roomId}:${requesterId}`;
}
function pairKey(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join(':');
}
function callPartnersKey(userIdA, userIdB) {
  return `${NS}:callpartners:${pairKey(userIdA, userIdB)}`;
}

// Atomic GET-then-DELETE, so two concurrent consumers (e.g. duplicate
// call:accept events, or the odd chance of two server instances racing)
// can't both "win" on the same invite/join-request.
const GETDEL_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;
async function atomicGetDel(key) {
  return redis.eval(GETDEL_SCRIPT, 1, key);
}

// ── Online presence ─────────────────────────────────────────────────────
async function setOnline(userId, socketId) {
  await redis.hset(KEY_ONLINE, userId, socketId);
}

async function getOnlineSocket(userId) {
  return redis.hget(KEY_ONLINE, userId);
}

async function removeOnline(userId) {
  await redis.hdel(KEY_ONLINE, userId);
}

async function onlineCount() {
  return redis.hlen(KEY_ONLINE);
}

// ── Rooms ────────────────────────────────────────────────────────────────
async function getRoom(roomId) {
  const raw = await redis.hget(KEY_ROOMS, roomId);
  return raw ? JSON.parse(raw) : null;
}

async function hasRoom(roomId) {
  return (await redis.hexists(KEY_ROOMS, roomId)) === 1;
}

async function saveRoom(roomId, room) {
  await redis.hset(KEY_ROOMS, roomId, JSON.stringify(room));
  return room;
}

async function deleteRoom(roomId) {
  await redis.hdel(KEY_ROOMS, roomId);
}

// Optimistic-locking read-modify-write for a room.
//
// In the old in-memory code, `room.participants.push(x)` and
// `room.votes[userId] = vote` were safe because JS is single-threaded — no
// other handler could run between the read and the write. With Redis as
// shared storage, a plain getRoom()+saveRoom() from two concurrent events
// (e.g. two people accepting a group-call join request at nearly the same
// moment, possibly on two different server instances) could race and one
// write would silently clobber the other.
//
// `updateRoom` fixes that with WATCH/MULTI/EXEC: it re-reads and re-applies
// `updater` if another writer commits in between. `updater` must be a pure,
// synchronous function — (currentRoomOrNull) => nextRoomOrNull — since it
// may run more than once under contention. Return `null` to delete the room.
//
// Uses a dedicated connection (redis.duplicate()) per call: WATCH is
// connection-scoped, and the shared `redis` client is used concurrently by
// unrelated commands throughout this module, so reusing it here would let
// unrelated transactions interfere with each other's watched keys.
async function updateRoom(roomId, updater, retries = 5) {
  const conn = redis.duplicate();
  try {
    for (let attempt = 0; attempt < retries; attempt++) {
      await conn.watch(KEY_ROOMS);
      const raw = await conn.hget(KEY_ROOMS, roomId);
      const current = raw ? JSON.parse(raw) : null;
      const next = updater(current);

      const tx = conn.multi();
      if (next === null || next === undefined) {
        tx.hdel(KEY_ROOMS, roomId);
      } else {
        tx.hset(KEY_ROOMS, roomId, JSON.stringify(next));
      }
      const result = await tx.exec(); // null => a watched key changed, retry
      if (result !== null) return next;
    }
    throw new Error(`updateRoom: too many conflicting writers for room "${roomId}"`);
  } finally {
    conn.disconnect();
  }
}

async function roomSize(roomId) {
  const room = await getRoom(roomId);
  return room ? room.participants.length : 0;
}

// ── userCurrentRoom ──────────────────────────────────────────────────────
async function getUserCurrentRoom(userId) {
  return redis.hget(KEY_USER_ROOM, userId);
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

    const roomId = await getUserCurrentRoom(userId);
    const payload = { userId, inCall: !!roomId, roomSize: roomId ? await roomSize(roomId) : 0 };

    await Promise.all(friendRows.map(async (row) => {
      const friendId = row.user_a === userId ? row.user_b : row.user_a;
      const fSocket = await getOnlineSocket(friendId);
      if (fSocket) io.to(fSocket).emit('friend:call_status', payload);
    }));
  } catch (_) { /* ignore */ }
}

async function setUserRoom(io, userId, roomId) {
  await redis.hset(KEY_USER_ROOM, userId, roomId);
  await broadcastCallStatus(io, userId);
}

async function clearUserRoom(io, userId) {
  const removed = await redis.hdel(KEY_USER_ROOM, userId);
  if (!removed) return;
  await broadcastCallStatus(io, userId);
}

// ── Pending invites ──────────────────────────────────────────────────────
async function addPendingInvite(roomId, targetUserId, inviterId) {
  await redis.set(inviteKey(roomId, targetUserId), inviterId, 'PX', INVITE_TTL_MS);
}

// Returns true (and consumes the entry) only if a matching, non-expired
// invite from `inviterId` to `targetUserId` for `roomId` actually exists.
async function consumePendingInvite(roomId, targetUserId, inviterId) {
  const stored = await atomicGetDel(inviteKey(roomId, targetUserId));
  return stored === inviterId;
}

// ── Pending join requests ────────────────────────────────────────────────
async function addPendingJoinRequest(roomId, requesterId) {
  await redis.set(joinReqKey(roomId, requesterId), '1', 'PX', INVITE_TTL_MS);
}

// Returns true (and consumes the entry) only if a matching, non-expired
// join request from `requesterId` for `roomId` actually exists.
async function consumePendingJoinRequest(roomId, requesterId) {
  const stored = await atomicGetDel(joinReqKey(roomId, requesterId));
  return stored === '1';
}

// ── Recent call partners ─────────────────────────────────────────────────
// Record that these users are (or just were) co-participants of the same
// call room. Call this any time a room's participant list changes.
async function markCallPartners(participantIds) {
  const ids = [...new Set(participantIds)].filter(Boolean);
  if (ids.length < 2) return;

  const now = Date.now().toString();
  const pipeline = redis.pipeline();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pipeline.set(callPartnersKey(ids[i], ids[j]), now, 'PX', CALL_PARTNER_TTL_MS);
    }
  }
  await pipeline.exec();
}

// True if userIdA and userIdB are currently in the same room together, or
// were within the last CALL_PARTNER_TTL_MS.
async function wereRecentCallPartners(userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;

  const [roomA, roomB] = await Promise.all([
    getUserCurrentRoom(userIdA),
    getUserCurrentRoom(userIdB),
  ]);
  if (roomA && roomA === roomB) return true;

  const exists = await redis.exists(callPartnersKey(userIdA, userIdB));
  return exists === 1;
}

module.exports = {
  // online presence
  setOnline,
  getOnlineSocket,
  removeOnline,
  onlineCount,
  // rooms
  getRoom,
  hasRoom,
  saveRoom,
  deleteRoom,
  updateRoom,
  roomSize,
  // current room / call status
  getUserCurrentRoom,
  broadcastCallStatus,
  setUserRoom,
  clearUserRoom,
  // invites & join requests
  addPendingInvite,
  consumePendingInvite,
  addPendingJoinRequest,
  consumePendingJoinRequest,
  // call partners
  markCallPartners,
  wereRecentCallPartners,
};

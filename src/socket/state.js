const { supabaseAdmin } = require('../services/supabase');

/**
 * In-memory realtime state shared by every socket handler module.
 *
 * rooms:           roomId -> { participants, mode, gameId, trialStart, promoted, votes }
 * online:          userId -> socketId  (who is currently connected)
 * userCurrentRoom: userId -> roomId    (who is currently "in a call" right now)
 */
const rooms = new Map();
const online = new Map();
const userCurrentRoom = new Map();

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
};

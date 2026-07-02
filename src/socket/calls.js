const { supabaseAdmin } = require('../services/supabase');
const { areUsersBlocked } = require('../services/blockHelper');
const {
  rooms, online, userCurrentRoom, roomSize, setUserRoom, clearUserRoom,
  addPendingInvite, consumePendingInvite,
  addPendingJoinRequest, consumePendingJoinRequest,
  markCallPartners,
} = require('./state');
const { isFlooding } = require('./rateLimit');

function registerCallHandlers(io, socket, userId, username) {
  // ── CALL CONTROL ──────────────────────────────────────────────────────
  socket.on('call:end', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    io.to(roomId).emit('call:ended', { by: userId });
    room.participants.forEach(pid => clearUserRoom(io, pid));
    rooms.delete(roomId);
  });

  socket.on('call:invite', async ({ targetUserId, roomId }) => {
    if (isFlooding(socket, 'call:invite', 30_000, 8)) {
      return socket.emit('call:invite_failed', { reason: 'Слишком много звонков подряд, подожди немного' });
    }
    if (await areUsersBlocked(userId, targetUserId)) {
      return socket.emit('call:invite_failed', { reason: 'Невозможно позвонить — пользователь заблокирован' });
    }
    const targetSocket = online.get(targetUserId);
    if (!targetSocket) {
      return socket.emit('call:invite_failed', { reason: 'Пользователь сейчас офлайн' });
    }
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_emoji, avatar_url')
      .eq('id', userId)
      .single();
    addPendingInvite(roomId, targetUserId, userId);
    io.to(targetSocket).emit('call:incoming', {
      roomId,
      from: {
        id: userId,
        username: profile?.username || username,
        avatar_emoji: profile?.avatar_emoji || '🎮',
        avatar_url: profile?.avatar_url || null,
      }
    });
  });

  socket.on('call:accept', ({ roomId, inviterId }) => {
    if (!roomId || !inviterId) return;
    if (!consumePendingInvite(roomId, userId, inviterId)) return;

    const inviterSocket = online.get(inviterId);
    if (inviterSocket) io.to(inviterSocket).emit('call:accepted', { roomId, by: userId });
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { participants: [inviterId, userId], mode: 'direct', votes: {} });
    } else {
      const room = rooms.get(roomId);
      if (!room.participants.includes(userId)) room.participants.push(userId);
    }
    setUserRoom(io, inviterId, roomId);
    setUserRoom(io, userId, roomId);
    markCallPartners([inviterId, userId]);
  });

  socket.on('call:reject', ({ roomId, inviterId }) => {
    consumePendingInvite(roomId, userId, inviterId);
    const inviterSocket = online.get(inviterId);
    if (inviterSocket) io.to(inviterSocket).emit('call:rejected', { roomId, by: userId });
  });

  // ── JOIN AN ONGOING CALL (e.g. friend is in a group call already) ──────
  socket.on('call:request_join', async ({ targetUserId }) => {
    if (isFlooding(socket, 'call:request_join', 30_000, 8)) {
      return socket.emit('call:join_failed', { reason: 'Слишком много запросов подряд, подожди немного' });
    }
    const targetRoomId = userCurrentRoom.get(targetUserId);
    if (!targetRoomId) {
      return socket.emit('call:join_failed', { reason: 'Пользователь сейчас не в звонке' });
    }
    const room = rooms.get(targetRoomId);
    if (!room) return socket.emit('call:join_failed', { reason: 'Звонок уже завершён' });

    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_emoji, avatar_url')
      .eq('id', userId)
      .single();

    addPendingJoinRequest(targetRoomId, userId);
    room.participants.forEach(pid => {
      const pSocket = online.get(pid);
      if (pSocket) io.to(pSocket).emit('call:join_requested', {
        roomId: targetRoomId,
        from: {
          id: userId,
          username: profile?.username || username,
          avatar_emoji: profile?.avatar_emoji || '🎮',
          avatar_url: profile?.avatar_url || null,
        }
      });
    });
    socket.emit('call:join_request_sent', { roomId: targetRoomId });
  });

  socket.on('call:join_response', ({ roomId, requesterId, accept }) => {
    if (!roomId || !requesterId) return;
    const room = rooms.get(roomId);
    const requesterSocket = online.get(requesterId);

    // Only a genuine participant of this room may approve/deny a join
    // request, and only for a request that was actually made.
    if (!room || !room.participants.includes(userId) || !consumePendingJoinRequest(roomId, requesterId)) {
      return;
    }

    if (!accept) {
      if (requesterSocket) io.to(requesterSocket).emit('call:join_rejected', { roomId, by: userId });
      return;
    }
    if (!room.participants.includes(requesterId)) room.participants.push(requesterId);
    if (requesterSocket) {
      const rSock = io.sockets.sockets.get(requesterSocket);
      if (rSock) rSock.join(roomId);
    }
    setUserRoom(io, requesterId, roomId);
    markCallPartners(room.participants);
    io.to(roomId).emit('call:participant_joined', { roomId, userId: requesterId });
    if (requesterSocket) {
      io.to(requesterSocket).emit('call:join_accepted', { roomId, participants: room.participants });
    }
  });

  // ── FRIENDS' CURRENT CALL STATUS (one-shot request with ack) ───────────
  socket.on('friends:call_status', async (_payload, callback) => {
    try {
      const { data: friendRows } = await supabaseAdmin
        .from('friends')
        .select('user_a, user_b')
        .or(`user_a.eq.${userId},user_b.eq.${userId}`)
        .eq('status', 'accepted');

      const result = {};
      (friendRows || []).forEach(row => {
        const friendId = row.user_a === userId ? row.user_b : row.user_a;
        const roomId = userCurrentRoom.get(friendId);
        if (roomId) result[friendId] = { inCall: true, roomSize: roomSize(roomId) };
      });
      if (typeof callback === 'function') callback(result);
    } catch (_) {
      if (typeof callback === 'function') callback({});
    }
  });
}

module.exports = { registerCallHandlers };

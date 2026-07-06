export {};
const { supabaseAdmin } = require('../services/supabase');
const { areUsersBlocked } = require('../services/blockHelper');
const {
  getRoom, deleteRoom, updateRoom, roomSize,
  getOnlineSocket, getUserCurrentRoom,
  setUserRoom, clearUserRoom,
  addPendingInvite, consumePendingInvite,
  addPendingJoinRequest, consumePendingJoinRequest,
  markCallPartners,
} = require('./state');
const { secureOn } = require('./validation');

// All handlers below go through secureOn() — see chat.js/globalChat.js for
// what that centralizes (global + per-event rate limiting, Zod payload
// validation against validation/socketSchemas.js). call:accept/call:reject/
// call:end/call:join_response previously had NO rate limit at all; they're
// covered now via DEFAULT_RATE_LIMITS in socket/validation.js.
//
// Room/presence state lives in Redis (see state.js) so it's shared across
// every server instance — every read/write below is async.
function registerCallHandlers(io: any, socket: any, userId: any, username: any) {
  // ── CALL CONTROL ──────────────────────────────────────────────────────
  secureOn(io, socket, userId, 'call:end', async ({ roomId }: any) => {
    const room = await getRoom(roomId);
    if (!room) return;
    io.to(roomId).emit('call:ended', { by: userId });
    await Promise.all(room.participants.map((pid: any) => clearUserRoom(io, pid)));
    await deleteRoom(roomId);
  });

  const emitInviteFailed = (sock: any, ack: any, error: any) => sock.emit('call:invite_failed', { reason: error });
  secureOn(io, socket, userId, 'call:invite', async ({ targetUserId, roomId }: any) => {
    if (await areUsersBlocked(userId, targetUserId)) {
      return socket.emit('call:invite_failed', { reason: 'Невозможно позвонить — пользователь заблокирован' });
    }
    const targetSocket = await getOnlineSocket(targetUserId);
    if (!targetSocket) {
      return socket.emit('call:invite_failed', { reason: 'Пользователь сейчас офлайн' });
    }
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_emoji, avatar_url')
      .eq('id', userId)
      .single();
    await addPendingInvite(roomId, targetUserId, userId);
    io.to(targetSocket).emit('call:incoming', {
      roomId,
      from: {
        id: userId,
        username: profile?.username || username,
        avatar_emoji: profile?.avatar_emoji || '🎮',
        avatar_url: profile?.avatar_url || null,
      }
    });
  }, { onRateLimited: emitInviteFailed, onInvalid: emitInviteFailed });

  secureOn(io, socket, userId, 'call:accept', async ({ roomId, inviterId }: any) => {
    if (!(await consumePendingInvite(roomId, userId, inviterId))) return;

    const inviterSocket = await getOnlineSocket(inviterId);
    if (inviterSocket) io.to(inviterSocket).emit('call:accepted', { roomId, by: userId });
    socket.join(roomId);

    await updateRoom(roomId, (room: any) => {
      if (!room) return { participants: [inviterId, userId], mode: 'direct', votes: {} };
      if (!room.participants.includes(userId)) room.participants.push(userId);
      return room;
    });
    await setUserRoom(io, inviterId, roomId);
    await setUserRoom(io, userId, roomId);
    await markCallPartners([inviterId, userId]);
  });

  secureOn(io, socket, userId, 'call:reject', async ({ roomId, inviterId }: any) => {
    await consumePendingInvite(roomId, userId, inviterId);
    const inviterSocket = await getOnlineSocket(inviterId);
    if (inviterSocket) io.to(inviterSocket).emit('call:rejected', { roomId, by: userId });
  });

  // ── JOIN AN ONGOING CALL (e.g. friend is in a group call already) ──────
  const emitJoinFailed = (sock: any, ack: any, error: any) => sock.emit('call:join_failed', { reason: error });
  secureOn(io, socket, userId, 'call:request_join', async ({ targetUserId }: any) => {
    const targetRoomId = await getUserCurrentRoom(targetUserId);
    if (!targetRoomId) {
      return socket.emit('call:join_failed', { reason: 'Пользователь сейчас не в звонке' });
    }
    const room = await getRoom(targetRoomId);
    if (!room) return socket.emit('call:join_failed', { reason: 'Звонок уже завершён' });

    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_emoji, avatar_url')
      .eq('id', userId)
      .single();

    await addPendingJoinRequest(targetRoomId, userId);
    await Promise.all(room.participants.map(async (pid: any) => {
      const pSocket = await getOnlineSocket(pid);
      if (pSocket) io.to(pSocket).emit('call:join_requested', {
        roomId: targetRoomId,
        from: {
          id: userId,
          username: profile?.username || username,
          avatar_emoji: profile?.avatar_emoji || '🎮',
          avatar_url: profile?.avatar_url || null,
        }
      });
    }));
    socket.emit('call:join_request_sent', { roomId: targetRoomId });
  }, { onRateLimited: emitJoinFailed, onInvalid: emitJoinFailed });

  secureOn(io, socket, userId, 'call:join_response', async ({ roomId, requesterId, accept }: any) => {
    const room = await getRoom(roomId);
    const requesterSocket = await getOnlineSocket(requesterId);

    // Only a genuine participant of this room may approve/deny a join
    // request, and only for a request that was actually made.
    if (!room || !room.participants.includes(userId) || !(await consumePendingJoinRequest(roomId, requesterId))) {
      return;
    }

    if (!accept) {
      if (requesterSocket) io.to(requesterSocket).emit('call:join_rejected', { roomId, by: userId });
      return;
    }

    const updatedRoom = await updateRoom(roomId, (r: any) => {
      if (!r) return null; // room vanished between our read above and now
      if (!r.participants.includes(requesterId)) r.participants.push(requesterId);
      return r;
    });
    if (!updatedRoom) return; // room was torn down concurrently, nothing to join

    if (requesterSocket) {
      // IMPORTANT: the requester's socket may be connected to a *different*
      // server instance than this one. `io.sockets.sockets.get(id)` only
      // finds sockets local to this process, so it silently no-ops on
      // another instance and the requester would never actually join the
      // room. `io.in(socketId).socketsJoin(room)` goes through the adapter
      // (Redis adapter included) and works across instances.
      await io.in(requesterSocket).socketsJoin(roomId);
    }
    await setUserRoom(io, requesterId, roomId);
    await markCallPartners(updatedRoom.participants);
    io.to(roomId).emit('call:participant_joined', { roomId, userId: requesterId });
    if (requesterSocket) {
      io.to(requesterSocket).emit('call:join_accepted', { roomId, participants: updatedRoom.participants });
    }
  });

  // ── FRIENDS' CURRENT CALL STATUS (one-shot request with ack) ───────────
  secureOn(io, socket, userId, 'friends:call_status', async (_payload: any, ack: any) => {
    // No local try/catch here on purpose: secureOn() (see socket/validation.ts)
    // already wraps every handler with centralized error handling — log +
    // Sentry + socket_errors_total — and acks { error } to the client. A
    // local catch here used to swallow failures before that ever ran,
    // silently acking `{}` (looking identical to "you have no friends in
    // calls") instead of surfacing the failure anywhere.
    const { data: friendRows } = await supabaseAdmin
      .from('friends')
      .select('user_a, user_b')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .eq('status', 'accepted');

    const result: Record<string, any> = {};
    await Promise.all((friendRows || []).map(async (row: any) => {
      const friendId = row.user_a === userId ? row.user_b : row.user_a;
      const roomId = await getUserCurrentRoom(friendId);
      if (roomId) result[friendId] = { inCall: true, roomSize: await roomSize(roomId) };
    }));
    ack(result);
  });
}

module.exports = { registerCallHandlers };

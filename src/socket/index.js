const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { enqueue, dequeue, runMatchCycle, queueSize } = require('./matchmaking');
const { supabaseAdmin } = require('../services/supabase');
const { addFriendPairInstant } = require('../services/friendsHelper');

/**
 * Active rooms: roomId -> { participants, mode, gameId, trialStart, promoted, votes }
 * Active sockets: userId -> socketId
 */
const rooms  = new Map();
const online = new Map(); // userId -> socketId
const userCurrentRoom = new Map(); // userId -> roomId (whoever is "in a call" right now)

function roomSize(roomId) {
  const room = rooms.get(roomId);
  return room ? room.participants.length : 0;
}

// ── On unanimous trial-call promotion: befriend everyone in the room and
//    get-or-create the conversation they'll chat in ─────────────────────────
async function promoteRoomToFriends(participantIds) {
  const ids = [...new Set(participantIds)];

  // Pairwise befriend everyone in the room (covers group trial calls too).
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      try { await addFriendPairInstant(ids[i], ids[j]); }
      catch (err) { console.error('[trial:promote] friend insert failed', err.message); }
    }
  }

  // Get-or-create the conversation.
  try {
    if (ids.length === 2) {
      const [a, b] = ids;
      const { data: existing } = await supabaseAdmin.rpc('find_direct_conversation', {
        user_a: a,
        user_b: b,
      });
      if (existing && existing.length) return existing[0].id;

      const convId = uuid();
      const { error: convErr } = await supabaseAdmin
        .from('conversations')
        .insert({ id: convId, type: 'direct', created_at: new Date().toISOString() });
      if (convErr) throw convErr;

      await supabaseAdmin.from('conversation_members').insert(
        ids.map(user_id => ({ conversation_id: convId, user_id }))
      );
      return convId;
    }

    // Group trial call (3+ participants)
    const convId = uuid();
    const { error: convErr } = await supabaseAdmin
      .from('conversations')
      .insert({ id: convId, type: 'group', name: 'Группа', created_at: new Date().toISOString() });
    if (convErr) throw convErr;

    await supabaseAdmin.from('conversation_members').insert(
      ids.map(user_id => ({ conversation_id: convId, user_id }))
    );
    return convId;
  } catch (err) {
    console.error('[trial:promote] conversation creation failed', err.message);
    return null;
  }
}


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

// ── Authenticate socket via handshake token ───────────────────────────────
function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (_) {
    next(new Error('Invalid token'));
  }
}

// ── Persist chat message to DB ────────────────────────────────────────────
async function saveMessage({ conversationId, senderId, text }) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert({
      id: uuid(),
      conversation_id: conversationId,
      sender_id: senderId,
      text,
      created_at: new Date().toISOString(),
    })
    .select('id, conversation_id, sender_id, text, created_at, sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )')
    .single();
  if (error) console.error('[saveMessage]', error);
  return data;
}

// ── Persist a global (platform-wide) chat message ─────────────────────────
async function saveGlobalMessage({ senderId, text }) {
  const { data, error } = await supabaseAdmin
    .from('global_messages')
    .insert({
      id: uuid(),
      sender_id: senderId,
      text,
      created_at: new Date().toISOString(),
    })
    .select(`
      id, text, created_at,
      sender:users!global_messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )
    `)
    .single();
  if (error) console.error('[saveGlobalMessage]', error);
  return data;
}

// ── Persist match to history ──────────────────────────────────────────────
async function saveMatchHistory(participants, gameId, mode) {
  const rows = [];
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      rows.push({
        id: uuid(),
        user_a: participants[i].userId,
        user_b: participants[j].userId,
        game_id: gameId,
        mode,
        created_at: new Date().toISOString(),
      });
    }
  }
  await supabaseAdmin.from('match_history').insert(rows);
}

// ── Main socket initialiser ───────────────────────────────────────────────
function initSocket(io) {
  io.use(authenticateSocket);

  // Run matchmaking every second
  setInterval(() => {
    const { soloMatch, groupMatch } = runMatchCycle();
    if (soloMatch)  handleMatch(io, soloMatch,  'solo');
    if (groupMatch) handleMatch(io, groupMatch, 'group');
    io.emit('queue:size', queueSize());
  }, 1000);

  io.on('connection', (socket) => {
    const { id: userId, username } = socket.user;
    online.set(userId, socket.id);
    socket.join('global');

    console.log(`[socket] ${username} connected (${socket.id})`);

    // Mark user online in DB (fire and forget)
    supabaseAdmin.from('users')
      .update({ status: 'online', last_seen: new Date().toISOString() })
      .eq('id', userId);

    // Notify friends
    notifyFriendsPresence(io, userId, 'online');
    io.emit('online:count', online.size);

    // ── MATCHMAKING ────────────────────────────────────────────────────────

    socket.on('match:join', (data) => {
      enqueue({
        userId,
        socketId:  socket.id,
        gameId:    data.gameId,
        mode:      data.mode      || 'solo',
        squadSize: data.squadSize || 2,
        rank:      data.rank,
        rankScore: data.rankScore || 0,
        languages: data.languages || ['en'],
        region:    data.region    || 'eu',
      });
      socket.emit('match:searching', { position: queueSize() });
    });

    socket.on('match:leave', () => {
      dequeue(userId);
      socket.emit('match:cancelled');
    });

    // ── TRIAL CALL VOTING ──────────────────────────────────────────────────

    socket.on('trial:vote', async ({ roomId, vote }) => {
      const room = rooms.get(roomId);
      if (!room) return;

      if (!room.votes) room.votes = {};
      room.votes[userId] = vote; // 'yes' | 'no'

      io.to(roomId).emit('trial:voted', { userId, vote });

      const total    = room.participants.length;
      const yesCount = Object.values(room.votes).filter(v => v === 'yes').length;
      const noCount  = Object.values(room.votes).filter(v => v === 'no').length;

      // FIX: resolve only when ALL participants have voted (not on first 'no').
      // Previously `noCount > 0` triggered resolution before everyone voted.
      const allVoted = yesCount + noCount === total;
      if (!allVoted) return;

      const promote = yesCount === total; // unanimous yes required
      io.to(roomId).emit('trial:result', { promote });

      if (promote) {
        room.promoted = true;
        // Actually persist the friendship(s) + conversation before telling
        // the clients "you're friends now" — this used to be announced to
        // the user without ever touching the database.
        const conversationId = await promoteRoomToFriends(room.participants);
        io.to(roomId).emit('call:promoted', { roomId, conversationId });
      } else {
        room.participants.forEach(pid => clearUserRoom(io, pid));
        rooms.delete(roomId);
      }
    });

    // ── CALL CONTROL ──────────────────────────────────────────────────────

    socket.on('call:end', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      io.to(roomId).emit('call:ended', { by: userId });
      room.participants.forEach(pid => clearUserRoom(io, pid));
      rooms.delete(roomId);
    });

    socket.on('call:invite', async ({ targetUserId, roomId }) => {
      const targetSocket = online.get(targetUserId);
      if (!targetSocket) {
        return socket.emit('call:invite_failed', { reason: 'Пользователь сейчас офлайн' });
      }
      const { data: profile } = await supabaseAdmin
        .from('users')
        .select('id, username, avatar_emoji, avatar_url')
        .eq('id', userId)
        .single();
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
    });

    socket.on('call:reject', ({ roomId, inviterId }) => {
      const inviterSocket = online.get(inviterId);
      if (inviterSocket) io.to(inviterSocket).emit('call:rejected', { roomId, by: userId });
    });

    // ── JOIN AN ONGOING CALL (e.g. friend is in a group call already) ──────

    socket.on('call:request_join', async ({ targetUserId }) => {
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
      const requesterSocket = online.get(requesterId);
      if (!accept) {
        if (requesterSocket) io.to(requesterSocket).emit('call:join_rejected', { roomId, by: userId });
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        if (requesterSocket) io.to(requesterSocket).emit('call:join_failed', { reason: 'Звонок уже завершён' });
        return;
      }
      if (!room.participants.includes(requesterId)) room.participants.push(requesterId);
      if (requesterSocket) {
        const rSock = io.sockets.sockets.get(requesterSocket);
        if (rSock) rSock.join(roomId);
      }
      setUserRoom(io, requesterId, roomId);
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

    // ── CHAT ──────────────────────────────────────────────────────────────

    socket.on('chat:join',  ({ conversationId }) => socket.join(`chat:${conversationId}`));
    socket.on('chat:leave', ({ conversationId }) => socket.leave(`chat:${conversationId}`));

    socket.on('chat:message', async ({ conversationId, text }) => {
      if (!text || !text.trim() || text.length > 2000) return;
      const msg = await saveMessage({ conversationId, senderId: userId, text: text.trim() });
      if (msg) io.to(`chat:${conversationId}`).emit('chat:message', msg);
    });

    socket.on('chat:typing', ({ conversationId }) => {
      socket.to(`chat:${conversationId}`).emit('chat:typing', { userId, username });
    });

    // ── GLOBAL CHAT (platform-wide public room) ─────────────────────────────

    socket.on('global:message', async ({ text }) => {
      if (!text || !text.trim() || text.length > 500) return;

      // Simple per-socket flood guard: max 1 message per second.
      const now = Date.now();
      if (socket._lastGlobalMsg && now - socket._lastGlobalMsg < 1000) return;
      socket._lastGlobalMsg = now;

      const msg = await saveGlobalMessage({ senderId: userId, text: text.trim() });
      if (msg) io.to('global').emit('global:message', msg);
    });

    // ── SWIPE ─────────────────────────────────────────────────────────────

    socket.on('swipe', async ({ targetUserId, direction }) => {
      await supabaseAdmin.from('swipes').upsert({
        user_id:        userId,
        target_user_id: targetUserId,
        direction,
        created_at:     new Date().toISOString(),
      });

      if (direction === 'right' || direction === 'super') {
        const { data: mutual } = await supabaseAdmin
          .from('swipes')
          .select('id')
          .eq('user_id', targetUserId)
          .eq('target_user_id', userId)
          .in('direction', ['right', 'super'])
          .maybeSingle();

        if (mutual) {
          socket.emit('swipe:match', { with: targetUserId });
          const targetSocket = online.get(targetUserId);
          if (targetSocket) io.to(targetSocket).emit('swipe:match', { with: userId });
        }
      }
    });

    // ── PRESENCE ──────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      online.delete(userId);
      dequeue(userId);
      clearUserRoom(io, userId);
      supabaseAdmin.from('users')
        .update({ status: 'offline', last_seen: new Date().toISOString() })
        .eq('id', userId);
      notifyFriendsPresence(io, userId, 'offline');
      io.emit('online:count', online.size);
      console.log(`[socket] ${username} disconnected`);
    });
  });
}

// ── Emit a match to the matched players ──────────────────────────────────
async function handleMatch(io, participants, mode) {
  const roomId = uuid();
  const gameId = participants[0].gameId;

  rooms.set(roomId, {
    participants: participants.map(p => p.userId),
    mode,
    gameId,
    trialStart: Date.now(),
    promoted: false,
    votes: {},
  });

  await saveMatchHistory(participants, gameId, mode);

  const participantIds = participants.map(p => p.userId);
  const { data: profiles } = await supabaseAdmin
    .from('users')
    .select('id, username, avatar_emoji, avatar_url')
    .in('id', participantIds);

  const profileMap = new Map((profiles || []).map(profile => [profile.id, profile]));
  const payload = {
    roomId,
    mode,
    gameId,
    participants: participants.map(p => {
      const profile = profileMap.get(p.userId) || {};
      return {
        userId: p.userId,
        socketId: p.socketId,
        username: profile.username || null,
        avatar_emoji: profile.avatar_emoji || '🎮',
        avatar_url: profile.avatar_url || null,
      };
    }),
  };

  for (const p of participants) {
    io.to(p.socketId).emit('match:found', payload);
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.join(roomId);
    setUserRoom(io, p.userId, roomId);
  }

  console.log(`[match] ${mode} room ${roomId} → ${participants.map(p => p.userId).join(', ')}`);
}

// ── Tell online friends about presence change ─────────────────────────────
async function notifyFriendsPresence(io, userId, status) {
  try {
    const { data: friendRows } = await supabaseAdmin
      .from('friends')
      .select('user_a, user_b')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .eq('status', 'accepted');

    if (!friendRows) return;

    for (const row of friendRows) {
      const friendId = row.user_a === userId ? row.user_b : row.user_a;
      const fSocket  = online.get(friendId);
      if (fSocket) io.to(fSocket).emit('presence', { userId, status });
    }
  } catch (_) { /* ignore */ }
}

module.exports = { initSocket };

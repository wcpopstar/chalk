const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { enqueue, dequeue, runMatchCycle, queueSize } = require('./matchmaking');
const { supabaseAdmin } = require('./supabase');

/**
 * Active rooms: roomId -> { participants, mode, gameId, trialStart, promoted, votes }
 * Active sockets: userId -> socketId
 */
const rooms  = new Map();
const online = new Map(); // userId -> socketId

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
    .select('id, conversation_id, sender_id, text, created_at')
    .single();
  if (error) console.error('[saveMessage]', error);
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

    console.log(`[socket] ${username} connected (${socket.id})`);

    // Mark user online in DB (fire and forget)
    supabaseAdmin.from('users')
      .update({ status: 'online', last_seen: new Date().toISOString() })
      .eq('id', userId);

    // Notify friends
    notifyFriendsPresence(io, userId, 'online');

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

    socket.on('trial:vote', ({ roomId, vote }) => {
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
        io.to(roomId).emit('call:promoted', { roomId });
      } else {
        rooms.delete(roomId);
      }
    });

    // ── WEBRTC SIGNALING ──────────────────────────────────────────────────

    socket.on('signal:offer', ({ roomId, to, offer }) => {
      const targetSocket = online.get(to);
      if (targetSocket) io.to(targetSocket).emit('signal:offer', { from: userId, offer, roomId });
    });

    socket.on('signal:answer', ({ roomId, to, answer }) => {
      const targetSocket = online.get(to);
      if (targetSocket) io.to(targetSocket).emit('signal:answer', { from: userId, answer, roomId });
    });

    socket.on('signal:ice', ({ roomId, to, candidate }) => {
      const targetSocket = online.get(to);
      if (targetSocket) io.to(targetSocket).emit('signal:ice', { from: userId, candidate, roomId });
    });

    // ── CALL CONTROL ──────────────────────────────────────────────────────

    socket.on('call:end', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      io.to(roomId).emit('call:ended', { by: userId });
      rooms.delete(roomId);
    });

    socket.on('call:invite', ({ targetUserId, roomId }) => {
      const targetSocket = online.get(targetUserId);
      if (!targetSocket) {
        return socket.emit('call:invite_failed', { reason: 'User is offline' });
      }
      io.to(targetSocket).emit('call:incoming', { roomId, from: { id: userId, username } });
    });

    socket.on('call:accept', ({ roomId, inviterId }) => {
      const inviterSocket = online.get(inviterId);
      if (inviterSocket) io.to(inviterSocket).emit('call:accepted', { roomId, by: userId });
      socket.join(roomId);
    });

    socket.on('call:reject', ({ roomId, inviterId }) => {
      const inviterSocket = online.get(inviterId);
      if (inviterSocket) io.to(inviterSocket).emit('call:rejected', { roomId, by: userId });
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
      supabaseAdmin.from('users')
        .update({ status: 'offline', last_seen: new Date().toISOString() })
        .eq('id', userId);
      notifyFriendsPresence(io, userId, 'offline');
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

  const payload = {
    roomId,
    mode,
    gameId,
    participants: participants.map(p => ({ userId: p.userId, socketId: p.socketId })),
  };

  for (const p of participants) {
    io.to(p.socketId).emit('match:found', payload);
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.join(roomId);
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

const { v4: uuid } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { addFriendPairInstant } = require('../services/friendsHelper');
const { enqueue, dequeue, runMatchCycle, queueSize } = require('./matchmaking');
const { rooms, setUserRoom, clearUserRoom, markCallPartners } = require('./state');
const { isFlooding } = require('./rateLimit');

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
  markCallPartners(participants.map(p => p.userId));

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

// ── Runs matchmaking once a second, pairing up whoever is in the queue ─────
function startMatchLoop(io) {
  setInterval(() => {
    const { soloMatch, groupMatch } = runMatchCycle();
    if (soloMatch)  handleMatch(io, soloMatch,  'solo');
    if (groupMatch) handleMatch(io, groupMatch, 'group');
    io.emit('queue:size', queueSize());
  }, 1000);
}

// ── MATCHMAKING + TRIAL CALL VOTING socket events ───────────────────────────
function registerMatchHandlers(io, socket, userId) {
  socket.on('match:join', (data) => {
    if (isFlooding(socket, 'match:join', 10_000, 8)) {
      return socket.emit('match:error', { error: 'Слишком часто, подожди немного' });
    }
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

  socket.on('trial:vote', async ({ roomId, vote }) => {
    if (isFlooding(socket, 'trial:vote', 10_000, 10)) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (!room.participants.includes(userId)) return;

    if (!room.votes) room.votes = {};
    room.votes[userId] = vote; // 'yes' | 'no'

    io.to(roomId).emit('trial:voted', { userId, vote });

    const total    = room.participants.length;
    const yesCount = Object.values(room.votes).filter(v => v === 'yes').length;
    const noCount  = Object.values(room.votes).filter(v => v === 'no').length;

    // Resolve only when ALL participants have voted (not on first 'no').
    const allVoted = yesCount + noCount === total;
    if (!allVoted) return;

    const promote = yesCount === total; // unanimous yes required
    io.to(roomId).emit('trial:result', { promote });

    if (promote) {
      room.promoted = true;
      // Actually persist the friendship(s) + conversation before telling
      // the clients "you're friends now".
      const conversationId = await promoteRoomToFriends(room.participants);
      io.to(roomId).emit('call:promoted', { roomId, conversationId });
    } else {
      room.participants.forEach(pid => clearUserRoom(io, pid));
      rooms.delete(roomId);
    }
  });
}

module.exports = { startMatchLoop, registerMatchHandlers };

import type { TypedServer, TypedSocket } from './types';
import { v4 as uuid } from 'uuid';
import { supabaseAdmin } from '../services/supabase';
import { addFriendPairInstant } from '../services/friendsHelper';
import { enqueue, dequeue, runMatchCycle, queueSize } from './matchmaking';
import { saveRoom, deleteRoom, updateRoom, setUserRoom, clearUserRoom, markCallPartners } from './state';
import { secureOn } from './validation';
import loggerBase from '../utils/logger';
import * as analytics from '../services/analytics';
import type { QueueEntry } from '../services/matchmakingRedis';
const logger = loggerBase.child({ module: 'match' });

// ── Persist match to history ──────────────────────────────────────────────
async function saveMatchHistory(participants: QueueEntry[], gameId: string, mode: string) {
  const rows = [];
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      rows.push({
        id: uuid(),
        user_a: participants[i]!.userId,
        user_b: participants[j]!.userId,
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
async function promoteRoomToFriends(participantIds: string[]) {
  const ids = [...new Set(participantIds)];

  // Pairwise befriend everyone in the room (covers group trial calls too).
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i]!, ids[j]!];
      try { await addFriendPairInstant(a, b); }
      catch (err: any) { logger.error({ err, userA: a, userB: b }, 'Failed to add friend pair during trial promotion'); }
    }
  }

  // Get-or-create the conversation.
  try {
    if (ids.length === 2) {
      const [a, b] = [ids[0]!, ids[1]!]; // guarded by the length check
      const { data: existing } = await supabaseAdmin.rpc('find_direct_conversation', {
        user_a: a,
        user_b: b,
      });
      if (existing && existing.length && existing[0]) return existing[0].id;

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
  } catch (err: any) {
    logger.error({ err }, 'Failed to create conversation during trial promotion');
    return null;
  }
}

// ── Emit a match to the matched players ──────────────────────────────────
async function handleMatch(io: TypedServer, participants: QueueEntry[], mode: 'solo' | 'group') {
  const roomId = uuid();
  const gameId = participants[0]!.gameId; // a match always has >= 2 participants

  await saveRoom(roomId, {
    participants: participants.map((p) => p.userId),
    mode,
    gameId,
    trialStart: Date.now(),
    promoted: false,
    votes: {},
  });

  await saveMatchHistory(participants, gameId, mode);
  await markCallPartners(participants.map((p) => p.userId));
  for (const p of participants) analytics.capture(p.userId, 'match_found', { mode, gameId });

  const participantIds = participants.map((p) => p.userId);
  const { data: profiles } = await supabaseAdmin
    .from('users')
    .select('id, username, avatar_emoji, avatar_url')
    .in('id', participantIds);

  const profileMap: Map<string, any> = new Map((profiles || []).map((profile: any) => [profile.id, profile]));
  const payload = {
    roomId,
    mode,
    gameId,
    participants: participants.map((p: any) => {
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
    // p.socketId may belong to a different server instance than the one
    // running this match cycle — socketsJoin() goes through the adapter
    // (Redis adapter in prod) so the join works regardless of which
    // instance actually holds that socket.
    await io.in(p.socketId).socketsJoin(roomId);
    await setUserRoom(io, p.userId, roomId);
  }

  logger.info({ mode, roomId, participantIds: participants.map((p) => p.userId) }, 'Match room created');
}

// ── Runs matchmaking once a second, pairing up whoever is in the queue ─────
// NOTE: this interval fires on every server instance, but runMatchCycle()
// takes a cluster-wide Redis lock internally, so only one instance actually
// processes the queues on any given tick — see matchmaking.js.
function startMatchLoop(io: TypedServer) {
  const interval = setInterval(async () => {
    try {
      const { soloMatch, groupMatch } = await runMatchCycle();
      if (soloMatch) await handleMatch(io, soloMatch, 'solo');
      if (groupMatch) await handleMatch(io, groupMatch, 'group');
      const size = await queueSize();
      io.emit('queue:size', typeof size === 'number' ? size : size.solo + size.group);
    } catch (err: any) {
      logger.error({ err }, 'Match cycle failed');
    }
  }, 1000);

  // Returned so callers (graceful shutdown) can stop the tick from firing
  // again once the process is going down — no point starting a new match
  // cycle against Redis connections that are themselves being closed.
  return () => clearInterval(interval);
}

// ── MATCHMAKING + TRIAL CALL VOTING socket events ───────────────────────────
// All handlers below go through secureOn() — payloads are Zod-validated
// against validation/socketSchemas.js (e.g. squadSize/rankScore are numeric
// and clamped, languages is a bounded array, region is a bounded string) —
// clients can no longer send e.g. squadSize: 999999 or mode: '<script>' and
// have it land in the queue. The 'match:error' shape on rate-limit/invalid-
// payload is preserved via options.onRateLimited/onInvalid so existing
// client listeners still work.
function registerMatchHandlers(io: TypedServer, socket: TypedSocket, userId: string) {
  const emitMatchError = (sock: TypedSocket, ack: (response: any) => void, error: string) => {
    ack({ error });
    sock.emit('match:error', { error });
  };
  secureOn(io, socket, userId, 'match:join', async (data) => {
    await enqueue({
      userId,
      socketId:  socket.id,
      gameId:    data.gameId,
      mode:      data.mode,
      squadSize: data.squadSize,
      rank:      data.rank,
      rankScore: data.rankScore,
      languages: data.languages,
      region:    data.region,
    });
    socket.emit('match:searching', { position: await queueSize() });
  }, { onRateLimited: emitMatchError, onInvalid: emitMatchError });

  secureOn(io, socket, userId, 'match:leave', async () => {
    await dequeue(userId);
    socket.emit('match:cancelled');
  });

  secureOn(io, socket, userId, 'trial:vote', async ({ roomId, vote }) => {
    // Record this vote atomically — concurrent voters (each hitting a
    // different server instance, potentially) must not clobber each other's
    // votes.votes[otherUserId] via a naive read-modify-write.
    const room = await updateRoom(roomId, (r) => {
      if (!r) return null;
      if (!r.participants.includes(userId)) return r;
      if (!r.votes) r.votes = {};
      r.votes[userId] = vote; // 'yes' | 'no'
      return r;
    });
    if (!room || !room.participants.includes(userId)) return;

    io.to(roomId).emit('trial:voted', { userId, vote });

    const total    = room.participants.length;
    const votes    = room.votes ?? {};
    const yesCount = Object.values(votes).filter(v => v === 'yes').length;
    const noCount  = Object.values(votes).filter(v => v === 'no').length;

    // Resolve only when ALL participants have voted (not on first 'no').
    const allVoted = yesCount + noCount === total;
    if (!allVoted) return;

    const promote = yesCount === total; // unanimous yes required
    io.to(roomId).emit('trial:result', { promote });

    if (promote) {
      await updateRoom(roomId, (r) => {
        if (!r) return null;
        r.promoted = true;
        return r;
      });
      // Actually persist the friendship(s) + conversation before telling
      // the clients "you're friends now".
      const conversationId = await promoteRoomToFriends(room.participants);
      io.to(roomId).emit('call:promoted', { roomId, conversationId });
    } else {
      await Promise.all(room.participants.map((pid) => clearUserRoom(io, pid)));
      await deleteRoom(roomId);
    }
  });
}

export { startMatchLoop, registerMatchHandlers };

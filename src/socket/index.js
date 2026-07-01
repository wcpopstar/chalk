const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { enqueue, dequeue, runMatchCycle, queueSize } = require('./matchmaking');

const socketRateLimiter = new Map();

function applySocketRateLimit(socket, key, windowMs, max) {
  const now = Date.now();
  const bucket = socketRateLimiter.get(socket.id + ':' + key);
  if (!bucket || now - bucket.start > windowMs) {
    socketRateLimiter.set(socket.id + ':' + key, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return true;
  }
  return false;
}
const { supabaseAdmin } = require('../services/supabase');
const { addFriendPairInstant } = require('../services/friendsHelper');
const { areUsersBlocked } = require('../services/blockHelper');
const { isYouTubeUrl, getYouTubePreviewData } = require('../utils/links');

/**
 * Active rooms: roomId -> { participants, mode, gameId, trialStart, promoted, votes }
 * Active sockets: userId -> socketId
 */
const rooms  = new Map();
const online = new Map(); // userId -> socketId
const userCurrentRoom = new Map(); // userId -> roomId (whoever is "in a call" right now)

// ── Per-socket flood guard ──────────────────────────────────────────────────
// Fixed-window rate limiter scoped to a single socket connection. Used to stop
// someone from mashing a button (or scripting an emit loop) and hammering the
// database / other users' clients — e.g. sending 100 messages/sec, swiping
// nonstop, or spamming call invites. Returns true when the caller is OVER
// the limit and should be rejected.
function isFlooding(socket, key, windowMs, max) {
  return applySocketRateLimit(socket, key, windowMs, max);
}

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

const MESSAGE_SELECT = 'id, conversation_id, sender_id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at, sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )';
const GLOBAL_MESSAGE_SELECT = `
  id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
  sender:users!global_messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )
`;

// ── Persist chat message to DB ────────────────────────────────────────────
async function saveMessage({ conversationId, senderId, text, type, mediaUrl, duration }) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert({
      id: uuid(),
      conversation_id: conversationId,
      sender_id: senderId,
      text: text || null,
      type: type || 'text',
      media_url: mediaUrl || null,
      duration_seconds: duration || null,
      created_at: new Date().toISOString(),
    })
    .select(MESSAGE_SELECT)
    .single();
  if (error) { console.error('[saveMessage]', error); throw new Error(error.message || 'Не удалось отправить сообщение'); }
  return data;
}

// ── Persist a global (platform-wide) chat message ─────────────────────────
async function saveGlobalMessage({ senderId, text, type, mediaUrl, duration }) {
  const { data, error } = await supabaseAdmin
    .from('global_messages')
    .insert({
      id: uuid(),
      sender_id: senderId,
      text: text || null,
      type: type || 'text',
      media_url: mediaUrl || null,
      duration_seconds: duration || null,
      created_at: new Date().toISOString(),
    })
    .select(GLOBAL_MESSAGE_SELECT)
    .single();
  if (error) { console.error('[saveGlobalMessage]', error); throw new Error(error.message || 'Не удалось отправить сообщение'); }
  return data;
}

// ── Edit / delete (soft) for either message table ─────────────────────────
async function editMessageRow(table, select, id, senderId, text) {
  const { data, error } = await supabaseAdmin
    .from(table)
    .update({ text, edited_at: new Date().toISOString() })
    .eq('id', id)
    .eq('sender_id', senderId)
    .eq('type', 'text')
    .is('deleted_at', null)
    .select(select)
    .single();
  if (error) { console.error(`[edit:${table}]`, error.message); throw new Error(error.message || 'Не удалось отредактировать сообщение'); }
  if (!data) throw new Error('Сообщение не найдено — возможно, оно уже удалено или это не ваше сообщение');
  return data;
}

async function deleteMessageRow(table, id, senderId) {
  const { data, error } = await supabaseAdmin
    .from(table)
    .update({ deleted_at: new Date().toISOString(), text: null, media_url: null })
    .eq('id', id)
    .eq('sender_id', senderId)
    .is('deleted_at', null)
    .select('id')
    .single();
  if (error) { console.error(`[delete:${table}]`, error.message); throw new Error(error.message || 'Не удалось удалить сообщение'); }
  if (!data) throw new Error('Сообщение не найдено — возможно, оно уже удалено или это не ваше сообщение');
  return data;
}

// ── Voice notes: upload raw audio bytes to Supabase Storage, return URL ────
const VOICE_BUCKET = 'voice-notes';
const MAX_VOICE_BYTES = 4 * 1024 * 1024; // ~4MB (roughly a couple of minutes of compressed audio)

async function uploadVoiceNote(senderId, buffer, mime) {
  if (!buffer || !buffer.length) throw new Error('Пустая запись');
  if (buffer.length > MAX_VOICE_BYTES) throw new Error('Голосовое сообщение слишком длинное');

  const ext = mime && mime.includes('ogg') ? 'ogg' : (mime && mime.includes('mp4') ? 'm4a' : 'webm');
  const path = `${senderId}/${uuid()}.${ext}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(VOICE_BUCKET)
    .upload(path, buffer, { contentType: mime || 'audio/webm', upsert: false });
  if (uploadErr) throw uploadErr;

  const { data } = supabaseAdmin.storage.from(VOICE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ── Video notes ("video kruzhki"): upload raw video bytes to Supabase Storage ─
const VIDEO_BUCKET = 'video-notes';
const MAX_VIDEO_BYTES = 8 * 1024 * 1024; // ~8MB — plenty for a ~30s low-bitrate circular clip

async function uploadVideoNote(senderId, buffer, mime) {
  if (!buffer || !buffer.length) throw new Error('Пустая запись');
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('Видеосообщение слишком длинное');

  const ext = mime && mime.includes('mp4') ? 'mp4' : 'webm';
  const path = `${senderId}/${uuid()}.${ext}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .upload(path, buffer, { contentType: mime || 'video/webm', upsert: false });
  if (uploadErr) throw uploadErr;

  const { data } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ── Is the *other* member of a direct conversation blocked (either way)? ───
// Group conversations aren't checked — blocking only affects 1:1 DMs here.
async function directPartnerBlocked(conversationId, senderId) {
  const { data: conv } = await supabaseAdmin
    .from('conversations')
    .select('type')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || conv.type !== 'direct') return false;

  const { data: members } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .neq('user_id', senderId);

  const otherId = members && members[0] && members[0].user_id;
  if (!otherId) return false;
  return areUsersBlocked(senderId, otherId);
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

    // ── TRIAL CALL VOTING ──────────────────────────────────────────────────

    socket.on('trial:vote', async ({ roomId, vote }) => {
      if (isFlooding(socket, 'trial:vote', 10_000, 10)) return;
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

    socket.on('chat:message', async ({ conversationId, text }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (isFlooding(socket, 'chat:message', 10_000, 20)) return ack({ error: 'Слишком часто, подожди немного' });
        if (!text || !text.trim() || text.length > 2000) return ack({ error: 'Пустое сообщение' });
        if (await directPartnerBlocked(conversationId, userId)) {
          socket.emit('chat:blocked', { conversationId });
          return ack({ error: 'Пользователь заблокирован' });
        }

        const trimmedText = text.trim();
        const youtubeLink = isYouTubeUrl(trimmedText);
        const payload = youtubeLink
          ? {
              conversationId,
              senderId: userId,
              text: trimmedText,
              type: 'youtube',
              mediaUrl: null,
            }
          : {
              conversationId,
              senderId: userId,
              text: trimmedText,
              type: 'text',
            };

        const msg = await saveMessage(payload);
        if (youtubeLink) {
          const preview = await getYouTubePreviewData(trimmedText);
          if (preview) {
            msg.preview_title = preview.title;
            msg.preview_url = preview.url;
            msg.preview_thumbnail = preview.thumbnail;
            msg.preview_video_id = preview.videoId;
          }
        }
        io.to(`chat:${conversationId}`).emit('chat:message', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[chat:message]', err.message);
        ack({ error: err.message || 'Не удалось отправить сообщение' });
      }
    });

    // ── Send a GIF (client picks the URL from a GIF search, e.g. Giphy/Tenor) ─
    socket.on('chat:gif', async ({ conversationId, gifUrl }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (isFlooding(socket, 'chat:gif', 10_000, 12)) return ack({ error: 'Слишком часто, подожди немного' });
        if (!conversationId || !gifUrl || !/^https:\/\//.test(gifUrl)) return ack({ error: 'Некорректная ссылка на GIF' });
        if (await directPartnerBlocked(conversationId, userId)) {
          socket.emit('chat:blocked', { conversationId });
          return ack({ error: 'Пользователь заблокирован' });
        }
        const msg = await saveMessage({ conversationId, senderId: userId, type: 'gif', mediaUrl: gifUrl });
        io.to(`chat:${conversationId}`).emit('chat:message', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[chat:gif]', err.message);
        ack({ error: err.message || 'Не удалось отправить GIF' });
      }
    });

    // ── Send a voice note: client streams the recorded audio as raw bytes ────
    socket.on('chat:voice', async ({ conversationId, audio, mime, duration }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (isFlooding(socket, 'chat:voice', 30_000, 6)) return ack({ error: 'Слишком часто, подожди немного' });
        if (!conversationId || !audio) return ack({ error: 'Нет аудио' });
        if (await directPartnerBlocked(conversationId, userId)) {
          return ack({ error: 'Нельзя отправить сообщение — пользователь заблокирован' });
        }
        const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
        const url = await uploadVoiceNote(userId, buffer, mime);
        const msg = await saveMessage({
          conversationId, senderId: userId, type: 'voice',
          mediaUrl: url, duration: Math.round(duration) || null,
        });
        io.to(`chat:${conversationId}`).emit('chat:message', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[chat:voice]', err.message);
        ack({ error: err.message || 'Не удалось отправить голосовое сообщение' });
      }
    });

    // ── Send a video note ("video kruzhok"): client streams raw video bytes ──
    socket.on('chat:video_note', async ({ conversationId, video, mime, duration }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (isFlooding(socket, 'chat:video_note', 30_000, 6)) return ack({ error: 'Слишком часто, подожди немного' });
        if (!conversationId || !video) return ack({ error: 'Нет видео' });
        if (await directPartnerBlocked(conversationId, userId)) {
          return ack({ error: 'Нельзя отправить сообщение — пользователь заблокирован' });
        }
        const buffer = Buffer.isBuffer(video) ? video : Buffer.from(video);
        const url = await uploadVideoNote(userId, buffer, mime);
        const msg = await saveMessage({
          conversationId, senderId: userId, type: 'video_note',
          mediaUrl: url, duration: Math.round(duration) || null,
        });
        io.to(`chat:${conversationId}`).emit('chat:message', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[chat:video_note]', err.message);
        ack({ error: err.message || 'Не удалось отправить видеосообщение' });
      }
    });

    // ── Edit a previously-sent text message (own messages only) ──────────────
    socket.on('chat:edit', async ({ conversationId, messageId, text }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (isFlooding(socket, 'chat:edit', 10_000, 15)) return ack({ error: 'Слишком часто, подожди немного' });
        if (!conversationId || !messageId || !text || !text.trim() || text.length > 2000) {
          return ack({ error: 'Некорректные данные для редактирования' });
        }
        const msg = await editMessageRow('messages', MESSAGE_SELECT, messageId, userId, text.trim());
        io.to(`chat:${conversationId}`).emit('chat:message:edited', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[chat:edit]', err.message);
        ack({ error: err.message || 'Не удалось отредактировать сообщение' });
      }
    });

    // ── Delete (soft) a message you sent ──────────────────────────────────────
    socket.on('chat:delete', async ({ conversationId, messageId }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (isFlooding(socket, 'chat:delete', 10_000, 15)) return ack({ error: 'Слишком часто, подожди немного' });
        if (!conversationId || !messageId) return ack({ error: 'Некорректные данные для удаления' });
        await deleteMessageRow('messages', messageId, userId);
        io.to(`chat:${conversationId}`).emit('chat:message:deleted', { conversationId, messageId });
        ack({ ok: true });
      } catch (err) {
        console.error('[chat:delete]', err.message);
        ack({ error: err.message || 'Не удалось удалить сообщение' });
      }
    });

    socket.on('chat:typing', ({ conversationId }) => {
      if (isFlooding(socket, 'chat:typing', 5_000, 15)) return;
      socket.to(`chat:${conversationId}`).emit('chat:typing', { userId, username });
    });

    // ── GLOBAL CHAT (platform-wide public room) ─────────────────────────────

    socket.on('global:message', async ({ text }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (!text || !text.trim() || text.length > 500) return ack({ error: 'Пустое сообщение' });
        if (isFlooding(socket, 'global:message', 10_000, 20)) return ack({ error: 'Слишком часто' });

        const trimmedText = text.trim();
        const youtubeLink = isYouTubeUrl(trimmedText);
        const payload = youtubeLink
          ? { senderId: userId, text: trimmedText, type: 'youtube', mediaUrl: null }
          : { senderId: userId, text: trimmedText, type: 'text' };

        const msg = await saveGlobalMessage(payload);
        if (youtubeLink) {
          const preview = await getYouTubePreviewData(trimmedText);
          if (preview) {
            msg.preview_title = preview.title;
            msg.preview_url = preview.url;
            msg.preview_thumbnail = preview.thumbnail;
            msg.preview_video_id = preview.videoId;
          }
        }
        io.to('global').emit('global:message', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[global:message]', err.message);
        ack({ error: err.message || 'Не удалось отправить сообщение' });
      }
    });

    socket.on('global:gif', async ({ gifUrl }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (!gifUrl || !/^https:\/\//.test(gifUrl)) return ack({ error: 'Некорректная ссылка на GIF' });
        if (isFlooding(socket, 'global:gif', 10_000, 12)) return ack({ error: 'Слишком часто' });

        const msg = await saveGlobalMessage({ senderId: userId, type: 'gif', mediaUrl: gifUrl });
        io.to('global').emit('global:message', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[global:gif]', err.message);
        ack({ error: err.message || 'Не удалось отправить GIF' });
      }
    });

    socket.on('global:voice', async ({ audio, mime, duration }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (!audio) return ack({ error: 'Нет аудио' });
        if (isFlooding(socket, 'global:voice', 30_000, 6)) return ack({ error: 'Слишком часто' });

        const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
        const url = await uploadVoiceNote(userId, buffer, mime);
        const msg = await saveGlobalMessage({
          senderId: userId, type: 'voice', mediaUrl: url, duration: Math.round(duration) || null,
        });
        io.to('global').emit('global:message', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[global:voice]', err.message);
        ack({ error: err.message || 'Не удалось отправить голосовое сообщение' });
      }
    });

    socket.on('global:video_note', async ({ video, mime, duration }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (!video) return ack({ error: 'Нет видео' });
        if (isFlooding(socket, 'global:video_note', 30_000, 6)) return ack({ error: 'Слишком часто' });

        const buffer = Buffer.isBuffer(video) ? video : Buffer.from(video);
        const url = await uploadVideoNote(userId, buffer, mime);
        const msg = await saveGlobalMessage({
          senderId: userId, type: 'video_note', mediaUrl: url, duration: Math.round(duration) || null,
        });
        io.to('global').emit('global:message', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[global:video_note]', err.message);
        ack({ error: err.message || 'Не удалось отправить видеосообщение' });
      }
    });

    socket.on('global:edit', async ({ messageId, text }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (isFlooding(socket, 'global:edit', 10_000, 15)) return ack({ error: 'Слишком часто' });
        if (!messageId || !text || !text.trim() || text.length > 500) return ack({ error: 'Некорректные данные' });
        const msg = await editMessageRow('global_messages', GLOBAL_MESSAGE_SELECT, messageId, userId, text.trim());
        io.to('global').emit('global:message:edited', msg);
        ack({ ok: true });
      } catch (err) {
        console.error('[global:edit]', err.message);
        ack({ error: err.message || 'Не удалось отредактировать сообщение' });
      }
    });

    socket.on('global:delete', async ({ messageId }, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        if (isFlooding(socket, 'global:delete', 10_000, 15)) return ack({ error: 'Слишком часто' });
        if (!messageId) return ack({ error: 'Некорректные данные' });
        await deleteMessageRow('global_messages', messageId, userId);
        io.to('global').emit('global:message:deleted', { messageId });
        ack({ ok: true });
      } catch (err) {
        console.error('[global:delete]', err.message);
        ack({ error: err.message || 'Не удалось удалить сообщение' });
      }
    });

    // ── SWIPE ─────────────────────────────────────────────────────────────

    socket.on('swipe', async ({ targetUserId, direction }) => {
      if (isFlooding(socket, 'swipe', 10_000, 40)) {
        return socket.emit('swipe:error', { error: 'Слишком быстро, притормози немного' });
      }
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
      for (const [key] of socketRateLimiter.entries()) {
        if (key.startsWith(socket.id + ':')) socketRateLimiter.delete(key);
      }
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

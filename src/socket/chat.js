const { isYouTubeUrl, getYouTubePreviewData } = require('../utils/links');
const { isFlooding } = require('./rateLimit');
const { uploadVoiceNote, uploadVideoNote } = require('./media');
const { withAckHandler } = require('./ackHandler');
const {
  MESSAGE_SELECT,
  saveMessage,
  editMessageRow,
  deleteMessageRow,
  directPartnerBlocked,
  isConversationMember,
} = require('./messages');

function registerChatHandlers(io, socket, userId, username) {
  socket.on('chat:join', async ({ conversationId }) => {
    if (!(await isConversationMember(conversationId, userId))) return;
    socket.join(`chat:${conversationId}`);
  });
  socket.on('chat:leave', ({ conversationId }) => socket.leave(`chat:${conversationId}`));

  socket.on('chat:message', withAckHandler('chat:message', 'Не удалось отправить сообщение', async ({ conversationId, text }, ack) => {
    if (isFlooding(socket, 'chat:message', 10_000, 20)) return ack({ error: 'Слишком часто, подожди немного' });
    if (!text || !text.trim() || text.length > 2000) return ack({ error: 'Пустое сообщение' });
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    if (await directPartnerBlocked(conversationId, userId)) {
      socket.emit('chat:blocked', { conversationId });
      return ack({ error: 'Пользователь заблокирован' });
    }

    const trimmedText = text.trim();
    const youtubeLink = isYouTubeUrl(trimmedText);
    const preview = youtubeLink ? await getYouTubePreviewData(trimmedText) : null;
    const payload = youtubeLink
      ? {
          conversationId,
          senderId: userId,
          text: trimmedText,
          type: 'youtube',
          mediaUrl: null,
          preview,
        }
      : {
          conversationId,
          senderId: userId,
          text: trimmedText,
          type: 'text',
        };

    const msg = await saveMessage(payload);
    io.to(`chat:${conversationId}`).emit('chat:message', msg);
    ack({ ok: true });
  }));

  // ── Send a GIF (client picks the URL from a GIF search, e.g. Giphy/Tenor) ─
  socket.on('chat:gif', withAckHandler('chat:gif', 'Не удалось отправить GIF', async ({ conversationId, gifUrl }, ack) => {
    if (isFlooding(socket, 'chat:gif', 10_000, 12)) return ack({ error: 'Слишком часто, подожди немного' });
    if (!conversationId || !gifUrl || !/^https:\/\//.test(gifUrl)) return ack({ error: 'Некорректная ссылка на GIF' });
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    if (await directPartnerBlocked(conversationId, userId)) {
      socket.emit('chat:blocked', { conversationId });
      return ack({ error: 'Пользователь заблокирован' });
    }
    const msg = await saveMessage({ conversationId, senderId: userId, type: 'gif', mediaUrl: gifUrl });
    io.to(`chat:${conversationId}`).emit('chat:message', msg);
    ack({ ok: true });
  }));

  // ── Send a voice note: client streams the recorded audio as raw bytes ────
  socket.on('chat:voice', withAckHandler('chat:voice', 'Не удалось отправить голосовое сообщение', async ({ conversationId, audio, mime, duration }, ack) => {
    if (isFlooding(socket, 'chat:voice', 30_000, 6)) return ack({ error: 'Слишком часто, подожди немного' });
    if (!conversationId || !audio) return ack({ error: 'Нет аудио' });
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
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
  }));

  // ── Send a video note ("video kruzhok"): client streams raw video bytes ──
  socket.on('chat:video_note', withAckHandler('chat:video_note', 'Не удалось отправить видеосообщение', async ({ conversationId, video, mime, duration }, ack) => {
    if (isFlooding(socket, 'chat:video_note', 30_000, 6)) return ack({ error: 'Слишком часто, подожди немного' });
    if (!conversationId || !video) return ack({ error: 'Нет видео' });
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
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
  }));

  // ── Edit a previously-sent text message (own messages only) ──────────────
  socket.on('chat:edit', withAckHandler('chat:edit', 'Не удалось отредактировать сообщение', async ({ conversationId, messageId, text }, ack) => {
    if (isFlooding(socket, 'chat:edit', 10_000, 15)) return ack({ error: 'Слишком часто, подожди немного' });
    if (!conversationId || !messageId || !text || !text.trim() || text.length > 2000) {
      return ack({ error: 'Некорректные данные для редактирования' });
    }
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    const msg = await editMessageRow('messages', MESSAGE_SELECT, messageId, userId, text.trim());
    io.to(`chat:${conversationId}`).emit('chat:message:edited', msg);
    ack({ ok: true });
  }));

  // ── Delete (soft) a message you sent ──────────────────────────────────────
  socket.on('chat:delete', withAckHandler('chat:delete', 'Не удалось удалить сообщение', async ({ conversationId, messageId }, ack) => {
    if (isFlooding(socket, 'chat:delete', 10_000, 15)) return ack({ error: 'Слишком часто, подожди немного' });
    if (!conversationId || !messageId) return ack({ error: 'Некорректные данные для удаления' });
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    await deleteMessageRow('messages', messageId, userId);
    io.to(`chat:${conversationId}`).emit('chat:message:deleted', { conversationId, messageId });
    ack({ ok: true });
  }));

  socket.on('chat:typing', ({ conversationId }) => {
    if (isFlooding(socket, 'chat:typing', 5_000, 15)) return;
    socket.to(`chat:${conversationId}`).emit('chat:typing', { userId, username });
  });
}

module.exports = { registerChatHandlers };

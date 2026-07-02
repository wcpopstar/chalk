const { isYouTubeUrl, getYouTubePreviewData } = require('../utils/links');
const { isFlooding } = require('./rateLimit');
const { uploadVoiceNote, uploadVideoNote } = require('./media');
const {
  MESSAGE_SELECT,
  saveMessage,
  editMessageRow,
  deleteMessageRow,
  directPartnerBlocked,
} = require('./messages');

function registerChatHandlers(io, socket, userId, username) {
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
}

module.exports = { registerChatHandlers };

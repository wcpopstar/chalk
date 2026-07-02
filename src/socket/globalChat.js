const { isYouTubeUrl, getYouTubePreviewData } = require('../utils/links');
const { isFlooding } = require('./rateLimit');
const { uploadVoiceNote, uploadVideoNote } = require('./media');
const {
  GLOBAL_MESSAGE_SELECT,
  saveGlobalMessage,
  editMessageRow,
  deleteMessageRow,
} = require('./messages');

// ── GLOBAL CHAT (platform-wide public room) ─────────────────────────────
function registerGlobalChatHandlers(io, socket, userId) {
  socket.on('global:message', async ({ text }, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!text || !text.trim() || text.length > 500) return ack({ error: 'Пустое сообщение' });
      if (isFlooding(socket, 'global:message', 10_000, 20)) return ack({ error: 'Слишком часто' });

      const trimmedText = text.trim();
      const youtubeLink = isYouTubeUrl(trimmedText);
      const preview = youtubeLink ? await getYouTubePreviewData(trimmedText) : null;
      const payload = youtubeLink
        ? { senderId: userId, text: trimmedText, type: 'youtube', mediaUrl: null, preview }
        : { senderId: userId, text: trimmedText, type: 'text' };

      const msg = await saveGlobalMessage(payload);
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
}

module.exports = { registerGlobalChatHandlers };

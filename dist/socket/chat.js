"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { isYouTubeUrl, getYouTubePreviewData } = require('../utils/links');
const { secureOn } = require('./validation');
const { uploadVoiceNote, uploadVideoNote } = require('./media');
const { MESSAGE_SELECT, saveMessage, editMessageRow, deleteMessageRow, directPartnerBlocked, isConversationMember, } = require('./messages');
// All handlers below go through secureOn(), which — before this code ever
// runs — checks the global per-user event budget, the per-event rate limit
// (see DEFAULT_RATE_LIMITS in socket/validation.js), and Zod-validates the
// payload against validation/socketSchemas.js. The manual isFlooding()/
// length/regex checks that used to open each handler are gone because
// that's now handled centrally. chat:join/chat:leave/chat:typing previously
// had NO rate limit at all (chat:typing did) — they're covered now too.
function registerChatHandlers(io, socket, userId, username) {
    secureOn(io, socket, userId, 'chat:join', async ({ conversationId }) => {
        if (!(await isConversationMember(conversationId, userId)))
            return;
        socket.join(`chat:${conversationId}`);
    });
    secureOn(io, socket, userId, 'chat:leave', async ({ conversationId }) => {
        socket.leave(`chat:${conversationId}`);
    });
    secureOn(io, socket, userId, 'chat:message', async ({ conversationId, text }, ack) => {
        if (!(await isConversationMember(conversationId, userId)))
            return ack({ error: 'Не участник этого чата' });
        if (await directPartnerBlocked(conversationId, userId)) {
            socket.emit('chat:blocked', { conversationId });
            return ack({ error: 'Пользователь заблокирован' });
        }
        const youtubeLink = isYouTubeUrl(text);
        const preview = youtubeLink ? await getYouTubePreviewData(text) : null;
        const payload = youtubeLink
            ? { conversationId, senderId: userId, text, type: 'youtube', mediaUrl: null, preview }
            : { conversationId, senderId: userId, text, type: 'text' };
        const msg = await saveMessage(payload);
        io.to(`chat:${conversationId}`).emit('chat:message', msg);
        ack({ ok: true });
    });
    // ── Send a GIF (client picks the URL from a GIF search, e.g. Giphy/Tenor) ─
    secureOn(io, socket, userId, 'chat:gif', async ({ conversationId, gifUrl }, ack) => {
        if (!(await isConversationMember(conversationId, userId)))
            return ack({ error: 'Не участник этого чата' });
        if (await directPartnerBlocked(conversationId, userId)) {
            socket.emit('chat:blocked', { conversationId });
            return ack({ error: 'Пользователь заблокирован' });
        }
        const msg = await saveMessage({ conversationId, senderId: userId, type: 'gif', mediaUrl: gifUrl });
        io.to(`chat:${conversationId}`).emit('chat:message', msg);
        ack({ ok: true });
    });
    // ── Send a voice note: client streams the recorded audio as raw bytes ────
    secureOn(io, socket, userId, 'chat:voice', async ({ conversationId, audio, mime, duration }, ack) => {
        if (!(await isConversationMember(conversationId, userId)))
            return ack({ error: 'Не участник этого чата' });
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
    });
    // ── Send a video note ("video kruzhok"): client streams raw video bytes ──
    secureOn(io, socket, userId, 'chat:video_note', async ({ conversationId, video, mime, duration }, ack) => {
        if (!(await isConversationMember(conversationId, userId)))
            return ack({ error: 'Не участник этого чата' });
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
    });
    // ── Edit a previously-sent text message (own messages only) ──────────────
    secureOn(io, socket, userId, 'chat:edit', async ({ conversationId, messageId, text }, ack) => {
        if (!(await isConversationMember(conversationId, userId)))
            return ack({ error: 'Не участник этого чата' });
        const msg = await editMessageRow('messages', MESSAGE_SELECT, messageId, userId, text);
        io.to(`chat:${conversationId}`).emit('chat:message:edited', msg);
        ack({ ok: true });
    });
    // ── Delete (soft) a message you sent ──────────────────────────────────────
    secureOn(io, socket, userId, 'chat:delete', async ({ conversationId, messageId }, ack) => {
        if (!(await isConversationMember(conversationId, userId)))
            return ack({ error: 'Не участник этого чата' });
        await deleteMessageRow('messages', messageId, userId);
        io.to(`chat:${conversationId}`).emit('chat:message:deleted', { conversationId, messageId });
        ack({ ok: true });
    });
    secureOn(io, socket, userId, 'chat:typing', async ({ conversationId }) => {
        socket.to(`chat:${conversationId}`).emit('chat:typing', { userId, username });
    });
}
module.exports = { registerChatHandlers };
//# sourceMappingURL=chat.js.map
import type { TypedServer, TypedSocket } from './types';
import { isYouTubeUrl, getYouTubePreviewData } from '../utils/links';
import { secureOn } from './validation';
import { uploadVoiceNote, uploadVideoNote } from './media';
import {
  GLOBAL_MESSAGE_SELECT,
  saveGlobalMessage,
  editMessageRow,
  deleteMessageRow,
} from './messages';

// ── GLOBAL CHAT (platform-wide public room) ─────────────────────────────
// All handlers below go through secureOn(), which — before this code ever
// runs — checks the global per-user event budget, the per-event rate limit
// (see DEFAULT_RATE_LIMITS in socket/validation.js), and Zod-validates the
// payload against socket/../validation/socketSchemas.js. The manual
// isFlooding()/length/regex checks that used to open each handler are gone
// because that's now handled centrally.
function registerGlobalChatHandlers(io: TypedServer, socket: TypedSocket, userId: string) {
  secureOn(io, socket, userId, 'global:message', async ({ text }, ack) => {
    const youtubeLink = isYouTubeUrl(text);
    const preview = youtubeLink ? await getYouTubePreviewData(text) : null;
    const payload = youtubeLink
      ? { senderId: userId, text, type: 'youtube', mediaUrl: null, preview }
      : { senderId: userId, text, type: 'text' };

    const msg = await saveGlobalMessage(payload);
    io.to('global').emit('global:message', msg);
    ack({ ok: true });
  });

  secureOn(io, socket, userId, 'global:gif', async ({ gifUrl }, ack) => {
    const msg = await saveGlobalMessage({ senderId: userId, type: 'gif', mediaUrl: gifUrl });
    io.to('global').emit('global:message', msg);
    ack({ ok: true });
  });

  secureOn(io, socket, userId, 'global:voice', async ({ audio, mime, duration }, ack) => {
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio as any);
    const url = await uploadVoiceNote(userId, buffer, mime);
    const msg = await saveGlobalMessage({
      senderId: userId, type: 'voice', mediaUrl: url, duration: Math.round(duration ?? 0) || null,
    });
    io.to('global').emit('global:message', msg);
    ack({ ok: true });
  });

  secureOn(io, socket, userId, 'global:video_note', async ({ video, mime, duration }, ack) => {
    const buffer = Buffer.isBuffer(video) ? video : Buffer.from(video as any);
    const url = await uploadVideoNote(userId, buffer, mime);
    const msg = await saveGlobalMessage({
      senderId: userId, type: 'video_note', mediaUrl: url, duration: Math.round(duration ?? 0) || null,
    });
    io.to('global').emit('global:message', msg);
    ack({ ok: true });
  });

  secureOn(io, socket, userId, 'global:edit', async ({ messageId, text }, ack) => {
    const msg = await editMessageRow('global_messages', GLOBAL_MESSAGE_SELECT, messageId, userId, text);
    io.to('global').emit('global:message:edited', msg);
    ack({ ok: true });
  });

  secureOn(io, socket, userId, 'global:delete', async ({ messageId }, ack) => {
    await deleteMessageRow('global_messages', messageId, userId);
    io.to('global').emit('global:message:deleted', { messageId });
    ack({ ok: true });
  });
}

export { registerGlobalChatHandlers };

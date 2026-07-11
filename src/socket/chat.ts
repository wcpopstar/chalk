import type { TypedServer, TypedSocket } from './types';
import { isYouTubeUrl, getYouTubePreviewData } from '../utils/links';
import { supabaseAdmin } from '../services/supabase';
import { secureOn } from './validation';
import { uploadVoiceNote, uploadVideoNote } from './media';
import {
  MESSAGE_SELECT,
  saveMessage,
  editMessageRow,
  deleteMessageRow,
  directPartnerBlocked,
  getDirectPartnerId,
  isConversationMember,
  getPublicKey,
  getConversationE2ee,
  setConversationE2ee,
} from './messages';

// All handlers below go through secureOn(), which — before this code ever
// runs — checks the global per-user event budget, the per-event rate limit
// (see DEFAULT_RATE_LIMITS in socket/validation.js), and Zod-validates the
// payload against validation/socketSchemas.js. The manual isFlooding()/
// length/regex checks that used to open each handler are gone because
// that's now handled centrally. chat:join/chat:leave/chat:typing previously
// had NO rate limit at all (chat:typing did) — they're covered now too.
//
// NOTE on typing: every `secureOn(io, socket, userId, 'chat:xyz', handler)`
// call below has its handler's `data`/`ack` parameter types inferred
// automatically from ClientToServerEvents['chat:xyz'] (see
// socket/validation.ts + socket/types.ts) — no `: any` needed, and no way to
// typo the event name or destructure a field that isn't actually on the
// Zod-validated payload.
function registerChatHandlers(io: TypedServer, socket: TypedSocket, userId: string, username: string) {
  secureOn(io, socket, userId, 'chat:join', async ({ conversationId }) => {
    if (!(await isConversationMember(conversationId, userId))) return;
    socket.join(`chat:${conversationId}`);
  });

  secureOn(io, socket, userId, 'chat:leave', async ({ conversationId }) => {
    socket.leave(`chat:${conversationId}`);
  });

  secureOn(io, socket, userId, 'chat:message', async ({ conversationId, text, ciphertext, nonce, replyToId }, ack) => {
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    if (await directPartnerBlocked(conversationId, userId)) {
      socket.emit('chat:blocked', { conversationId });
      return ack({ error: 'Пользователь заблокирован' });
    }

    // A reply may only quote a message from THIS conversation — silently
    // drop the reference otherwise (don't fail the send over a stale quote).
    let verifiedReplyTo: string | null = null;
    if (replyToId) {
      const { data: quoted } = await supabaseAdmin
        .from('messages')
        .select('id')
        .eq('id', replyToId)
        .eq('conversation_id', conversationId)
        .maybeSingle();
      verifiedReplyTo = quoted ? replyToId : null;
    }

    // ── E2EE path ────────────────────────────────────────────────────────
    // The client sends ciphertext instead of text for encrypted (direct)
    // conversations — see public/js/e2ee.js. We can't parse a YouTube link
    // or generate a preview out of something we can't decrypt, so that
    // feature simply doesn't apply here; the server just stores/relays the
    // opaque blob. senderPublicKey is looked up from `users`, never trusted
    // from the client payload.
    if (ciphertext) {
      const senderPublicKey = await getPublicKey(userId);
      if (!senderPublicKey) return ack({ error: 'Нет ключа шифрования — перезайди в приложение' });
      const msg = await saveMessage({ conversationId, senderId: userId, ciphertext, nonce, senderPublicKey, type: 'text', replyToId: verifiedReplyTo });
      io.to(`chat:${conversationId}`).emit('chat:message', msg);
      return ack({ ok: true, message: msg });
    }

    // ── E2EE downgrade guard ─────────────────────────────────────────────
    // Encryption is opt-in per conversation (the lock button → chat:e2ee,
    // migration 018). Plaintext is fine while the flag is off; once it's ON,
    // the server rejects plaintext so one stale client can't silently
    // downgrade a conversation both sides chose to encrypt. The fresh
    // partner key rides back on the ack so the client can re-encrypt and
    // resend immediately.
    if (await getConversationE2ee(conversationId)) {
      const partnerId = await getDirectPartnerId(conversationId, userId);
      const partnerPublicKey = partnerId ? await getPublicKey(partnerId) : null;
      return ack({
        error: 'В этом чате включено шифрование — сообщение нужно зашифровать',
        code: 'e2ee_required',
        partnerPublicKey,
      });
    }

    const youtubeLink = isYouTubeUrl(text!);
    const preview = youtubeLink ? await getYouTubePreviewData(text!) : null;
    const payload = youtubeLink
      ? { conversationId, senderId: userId, text, type: 'youtube' as const, mediaUrl: null, preview, replyToId: verifiedReplyTo }
      : { conversationId, senderId: userId, text, type: 'text' as const, replyToId: verifiedReplyTo };

    const msg = await saveMessage(payload);
    io.to(`chat:${conversationId}`).emit('chat:message', msg);
    // The saved message rides back on the ack so the sender can swap its
    // optimistic "sending…" bubble for the real one (delivered) without
    // waiting for the room broadcast echo.
    ack({ ok: true, message: msg });
  });

  // ── Send a GIF (client picks the URL from a GIF search, e.g. Giphy/Tenor) ─
  secureOn(io, socket, userId, 'chat:gif', async ({ conversationId, gifUrl }, ack) => {
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
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
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    if (await directPartnerBlocked(conversationId, userId)) {
      return ack({ error: 'Нельзя отправить сообщение — пользователь заблокирован' });
    }
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio as any);
    const url = await uploadVoiceNote(userId, buffer, mime ?? '');
    const msg = await saveMessage({
      conversationId, senderId: userId, type: 'voice',
      mediaUrl: url, duration: Math.round(duration ?? 0) || null,
    });
    io.to(`chat:${conversationId}`).emit('chat:message', msg);
    ack({ ok: true });
  });

  // ── Send a video note ("video kruzhok"): client streams raw video bytes ──
  secureOn(io, socket, userId, 'chat:video_note', async ({ conversationId, video, mime, duration }, ack) => {
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    if (await directPartnerBlocked(conversationId, userId)) {
      return ack({ error: 'Нельзя отправить сообщение — пользователь заблокирован' });
    }
    const buffer = Buffer.isBuffer(video) ? video : Buffer.from(video as any);
    const url = await uploadVideoNote(userId, buffer, mime ?? '');
    const msg = await saveMessage({
      conversationId, senderId: userId, type: 'video_note',
      mediaUrl: url, duration: Math.round(duration ?? 0) || null,
    });
    io.to(`chat:${conversationId}`).emit('chat:message', msg);
    ack({ ok: true });
  });

  // ── Edit a previously-sent text message (own messages only) ──────────────
  secureOn(io, socket, userId, 'chat:edit', async ({ conversationId, messageId, text, ciphertext, nonce }, ack) => {
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });

    let msg;
    if (ciphertext) {
      const senderPublicKey = await getPublicKey(userId);
      if (!senderPublicKey) return ack({ error: 'Нет ключа шифрования — перезайди в приложение' });
      msg = await editMessageRow('messages', MESSAGE_SELECT, messageId, userId, { ciphertext, nonce: nonce!, senderPublicKey });
    } else {
      msg = await editMessageRow('messages', MESSAGE_SELECT, messageId, userId, { text: text! });
    }
    io.to(`chat:${conversationId}`).emit('chat:message:edited', msg);
    ack({ ok: true });
  });

  // ── Delete (soft) a message you sent ──────────────────────────────────────
  secureOn(io, socket, userId, 'chat:delete', async ({ conversationId, messageId }, ack) => {
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    await deleteMessageRow('messages', messageId, userId);
    io.to(`chat:${conversationId}`).emit('chat:message:deleted', { conversationId, messageId });
    ack({ ok: true });
  });

  secureOn(io, socket, userId, 'chat:typing', async ({ conversationId, kind }) => {
    socket.to(`chat:${conversationId}`).emit('chat:typing', {
      conversationId, userId, username, kind: kind || 'typing',
    });
  });

  // ── Read receipt: "I've seen everything here up to now" ──────────────────
  // Sent when the member has the conversation open and visible (on open and
  // on every incoming message while open). Stored as a per-member watermark
  // (conversation_members.last_read_at) and broadcast so senders' bubbles
  // can flip from delivered (✓) to read (✓✓) live.
  secureOn(io, socket, userId, 'chat:read', async ({ conversationId }, ack) => {
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });
    const lastReadAt = new Date().toISOString();
    await supabaseAdmin
      .from('conversation_members')
      .update({ last_read_at: lastReadAt })
      .eq('conversation_id', conversationId)
      .eq('user_id', userId);
    socket.to(`chat:${conversationId}`).emit('chat:read', { conversationId, userId, lastReadAt });
    ack({ ok: true });
  });

  // ── E2EE toggle: the lock button in a direct chat's header ───────────────
  // Either member may flip encryption on/off for the whole conversation.
  // Enabling requires BOTH sides to have keys — otherwise the partner
  // couldn't read anything sent after the flip. The new state is broadcast
  // to the room (sender included) so every open client flips its lock icon
  // and send path at the same moment; members not in the room pick the flag
  // up from GET /api/chats(/:id/messages) on their next open.
  secureOn(io, socket, userId, 'chat:e2ee', async ({ conversationId, enabled }, ack) => {
    if (!(await isConversationMember(conversationId, userId))) return ack({ error: 'Не участник этого чата' });

    const partnerId = await getDirectPartnerId(conversationId, userId);
    if (!partnerId) return ack({ error: 'Шифрование доступно только в личных чатах' });

    let partnerPublicKey: string | null = null;
    if (enabled) {
      if (!(await getPublicKey(userId))) return ack({ error: 'Нет ключа шифрования — перезайди в приложение' });
      partnerPublicKey = await getPublicKey(partnerId);
      if (!partnerPublicKey) return ack({ error: 'У собеседника ещё нет ключа шифрования — он появится после его следующего входа' });
    }

    await setConversationE2ee(conversationId, enabled);
    io.to(`chat:${conversationId}`).emit('chat:e2ee', { conversationId, enabled, byUserId: userId, byUsername: username });
    // The fresh partner key rides back so the toggling client can encrypt
    // the very next message without waiting for a members refetch.
    ack({ ok: true, enabled, partnerPublicKey });
  });
}

export { registerChatHandlers };

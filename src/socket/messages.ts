import { v4 as uuid } from 'uuid';
import { supabaseAdmin } from '../services/supabase';
import { areUsersBlocked } from '../services/blockHelper';
import loggerBase from '../utils/logger';
import * as analytics from '../services/analytics';
const logger = loggerBase.child({ module: 'messages' });

const MESSAGE_SELECT = `
  id, conversation_id, sender_id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
  preview_title, preview_url, preview_thumbnail, preview_video_id, reply_to_id, forwarded_from,
  is_encrypted, nonce, sender_public_key,
  sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url ),
  reply_to:reply_to_id ( id, text, type, deleted_at, sender_id, sender:users!messages_sender_id_fkey ( username ) ),
  reactions:message_reactions ( emoji, user_id )
`;
// ^ the self-join embed uses the FK COLUMN name (reply_to_id), not a
// `messages!<hint>` form: this PostgREST deployment doesn't resolve the
// constraint-name hint at all (PGRST200 despite the FK existing), and the
// `messages!reply_to_id` column-hint form resolves the REVERSE direction
// (array of replies TO this message). The bare fk-column embed is the only
// form that returns the quoted parent as object|null.
const GLOBAL_MESSAGE_SELECT = `
  id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
  preview_title, preview_url, preview_thumbnail, preview_video_id,
  sender:users!global_messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )
`;

// ── Persist chat message to DB ────────────────────────────────────────────
import type { MessageType } from '../types/supabase';

interface MessageInput {
  senderId: string;
  replyToId?: string | null;
  text?: string | null;
  type?: MessageType;
  mediaUrl?: string | null;
  duration?: number | null;
  // Non-null only for forwarded copies: the original author's display name,
  // used to render a "Forwarded from X" label (see socket/chat.ts chat:forward).
  forwardedFrom?: string | null;
  preview?: { title?: string; url?: string; thumbnail?: string; videoId?: string } | null;
  // ── E2EE (direct chats only, type 'text') ──────────────────────────────
  // When ciphertext is present, `text` is ignored and the row is stored as
  // encrypted: `text` holds the base64 ciphertext, and nonce/senderPublicKey
  // are the metadata the recipient needs to decrypt it client-side. See
  // supabase/migrations/015_e2ee.sql for why these three travel together.
  ciphertext?: string | null;
  nonce?: string | null;
  senderPublicKey?: string | null;
}

async function saveMessage({ conversationId, senderId, text, type, mediaUrl, duration, preview, replyToId, forwardedFrom, ciphertext, nonce, senderPublicKey }: MessageInput & { conversationId: string }) {
  const isEncrypted = Boolean(ciphertext);
  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert({
      id: uuid(),
      conversation_id: conversationId,
      sender_id: senderId,
      // set only when actually replying — keeps plain sends working even if
      // migration 014 hasn't been applied yet (column absent)
      ...(replyToId ? { reply_to_id: replyToId } : {}),
      // only stamped on forwarded copies (migration 019); omitted otherwise so
      // plain sends still work if the column isn't there yet
      ...(forwardedFrom ? { forwarded_from: forwardedFrom } : {}),
      // Encrypted rows reuse `text` to carry the base64 ciphertext; nonce and
      // sender_public_key ride alongside (see migration 015_e2ee.sql).
      text: isEncrypted ? ciphertext : (text || null),
      type: type || 'text',
      media_url: mediaUrl || null,
      duration_seconds: duration || null,
      preview_title: preview?.title || null,
      preview_url: preview?.url || null,
      preview_thumbnail: preview?.thumbnail || null,
      preview_video_id: preview?.videoId || null,
      created_at: new Date().toISOString(),
      is_encrypted: isEncrypted,
      nonce: isEncrypted ? nonce : null,
      sender_public_key: isEncrypted ? senderPublicKey : null,
    })
    .select(MESSAGE_SELECT)
    .single();
  if (error) { logger.error({ err: error, conversationId, senderId }, 'Failed to save message'); throw new Error(error.message || 'Не удалось отправить сообщение'); }
  // Never log/emit the plaintext into analytics — only the type/scope, same
  // as before. For encrypted messages we couldn't read the plaintext anyway.
  analytics.capture(senderId, 'message_sent', { type: type || 'text', scope: 'direct', encrypted: isEncrypted });
  return data;
}

// ── Persist a global (platform-wide) chat message ─────────────────────────
async function saveGlobalMessage({ senderId, text, type, mediaUrl, duration, preview }: MessageInput) {
  const { data, error } = await supabaseAdmin
    .from('global_messages')
    .insert({
      id: uuid(),
      sender_id: senderId,
      text: text || null,
      type: type || 'text',
      media_url: mediaUrl || null,
      duration_seconds: duration || null,
      preview_title: preview?.title || null,
      preview_url: preview?.url || null,
      preview_thumbnail: preview?.thumbnail || null,
      preview_video_id: preview?.videoId || null,
      created_at: new Date().toISOString(),
    })
    .select(GLOBAL_MESSAGE_SELECT)
    .single();
  if (error) { logger.error({ err: error, senderId }, 'Failed to save global message'); throw new Error(error.message || 'Не удалось отправить сообщение'); }
  return data;
}

// ── Edit / delete (soft) for either message table ─────────────────────────
// `edit` is either { text } (plaintext — global chat / group DMs) or
// { ciphertext, nonce, senderPublicKey } (E2EE direct chats). Whichever
// shape it is, we intentionally don't flip a plaintext row to encrypted or
// vice versa here — the caller (chat.ts) only ever passes the shape that
// matches how the *conversation* is set up, and is_encrypted was fixed at
// insert time.
async function editMessageRow(
  table: 'messages' | 'global_messages',
  select: string,
  id: string,
  senderId: string,
  edit: { text: string } | { ciphertext: string; nonce: string; senderPublicKey: string },
) {
  const isEncryptedEdit = 'ciphertext' in edit;
  const update = isEncryptedEdit
    ? { text: edit.ciphertext, nonce: edit.nonce, sender_public_key: edit.senderPublicKey, edited_at: new Date().toISOString() }
    : { text: edit.text, edited_at: new Date().toISOString() };
  // Mixed-mode direct chats (plaintext rows from before the partner had an
  // E2EE key, encrypted ones after): an edit must land on a row whose
  // is_encrypted matches its own shape, otherwise it would either trip the
  // messages_encryption_consistency_check constraint (ciphertext onto a
  // plaintext row) or silently corrupt an encrypted row with plaintext.
  // global_messages has no is_encrypted column, hence the table guard.
  const filters: Record<string, unknown> = { id, sender_id: senderId, type: 'text' };
  if (table === 'messages') filters.is_encrypted = isEncryptedEdit;
  const { data, error } = await supabaseAdmin
    .from(table)
    .update(update as any)
    .match(filters as any)
    .is('deleted_at', null)
    .select(select)
    .maybeSingle();
  if (error) { logger.error({ err: error, table, id, senderId }, 'Failed to edit message'); throw new Error(error.message || 'Не удалось отредактировать сообщение'); }
  if (!data) {
    // Tell an encryption-mode mismatch apart from a deleted/foreign message —
    // they need different reactions from the user, and collapsing them into
    // one "not found" makes reports undebuggable.
    if (table === 'messages') {
      const { data: row } = await supabaseAdmin
        .from('messages')
        .select('is_encrypted')
        .match({ id, sender_id: senderId, type: 'text' })
        .is('deleted_at', null)
        .maybeSingle();
      if (row && Boolean(row.is_encrypted) !== isEncryptedEdit) {
        throw new Error(row.is_encrypted
          ? 'Это сообщение зашифровано — правку нужно отправить зашифрованной'
          : 'Это сообщение отправлено без шифрования — правка тоже должна быть без него');
      }
    }
    throw new Error('Сообщение не найдено — возможно, оно уже удалено или это не ваше сообщение');
  }
  return data;
}

async function deleteMessageRow(table: 'messages' | 'global_messages', id: string, senderId: string) {
  const { data, error } = await supabaseAdmin
    .from(table)
    .update({ deleted_at: new Date().toISOString(), text: null, media_url: null })
    .eq('id', id)
    .eq('sender_id', senderId)
    .is('deleted_at', null)
    .select('id')
    .single();
  if (error) { logger.error({ err: error, table, id, senderId }, 'Failed to delete message'); throw new Error(error.message || 'Не удалось удалить сообщение'); }
  if (!data) throw new Error('Сообщение не найдено — возможно, оно уже удалено или это не ваше сообщение');
  return data;
}

// ── The *other* member of a direct conversation (null for groups) ─────────
async function getDirectPartnerId(conversationId: string, senderId: string): Promise<string | null> {
  const { data: conv } = await supabaseAdmin
    .from('conversations')
    .select('type')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || conv.type !== 'direct') return null;

  const { data: members } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .neq('user_id', senderId);

  return (members && members[0] && members[0].user_id) || null;
}

// ── E2EE opt-in flag for a conversation (migration 018) ───────────────────
// The server-side source of truth for whether messages in this conversation
// must be encrypted. Missing conversation reads as false — same as a plain
// unencrypted chat.
async function getConversationE2ee(conversationId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('conversations')
    .select('e2ee_enabled')
    .eq('id', conversationId)
    .maybeSingle();
  return Boolean(data && data.e2ee_enabled);
}

// ── Pinned message (single per conversation, migration 019) ───────────────
// Set to a messageId to pin, or null to unpin. Returns nothing; the caller
// re-reads the pinned message via getPinnedMessage() to broadcast it.
async function setConversationPin(conversationId: string, messageId: string | null) {
  const { error } = await supabaseAdmin
    .from('conversations')
    .update({ pinned_message_id: messageId })
    .eq('id', conversationId);
  if (error) { logger.error({ err: error, conversationId, messageId }, 'Failed to set pinned message'); throw new Error('Не удалось закрепить сообщение'); }
}

// The currently-pinned message of a conversation, fully hydrated for
// rendering (or null if nothing is pinned / it was since deleted).
async function getPinnedMessage(conversationId: string) {
  const { data: conv } = await supabaseAdmin
    .from('conversations')
    .select('pinned_message_id')
    .eq('id', conversationId)
    .maybeSingle();
  const pinnedId = conv && (conv as any).pinned_message_id;
  if (!pinnedId) return null;
  const { data } = await supabaseAdmin
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('id', pinnedId)
    .is('deleted_at', null)
    .maybeSingle();
  return data || null;
}

// ── Fetch one message by id (used by pin + forward) ───────────────────────
// Returns the raw row (conversation_id included) or null. The caller is
// responsible for verifying the requesting user may actually see it.
async function getMessageById(messageId: string) {
  const { data } = await supabaseAdmin
    .from('messages')
    .select('id, conversation_id, sender_id, text, type, media_url, duration_seconds, is_encrypted, deleted_at, preview_title, preview_url, preview_thumbnail, preview_video_id, sender:users!messages_sender_id_fkey ( username )')
    .eq('id', messageId)
    .maybeSingle();
  return data || null;
}

// ── Message reactions (migration 020) ─────────────────────────────────────
// Toggle one emoji reaction by one user on one message: if the (message,
// user, emoji) row already exists it's removed, otherwise inserted. Returns
// the full, fresh reaction list for the message so the caller can broadcast
// the new aggregate state. The caller is responsible for verifying the user
// may actually see/react in this conversation.
async function toggleReaction(messageId: string, userId: string, emoji: string) {
  const { data: existing } = await supabaseAdmin
    .from('message_reactions')
    .select('message_id')
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', userId)
      .eq('emoji', emoji);
  } else {
    const { error } = await supabaseAdmin
      .from('message_reactions')
      .insert({ message_id: messageId, user_id: userId, emoji });
    // A duplicate (someone double-tapped before the first insert committed)
    // isn't an error worth failing the toggle over.
    if (error && !String(error.code).startsWith('23')) {
      logger.error({ err: error, messageId, userId }, 'Failed to add reaction');
      throw new Error('Не удалось поставить реакцию');
    }
  }
  return getReactionsForMessage(messageId);
}

// The raw reaction rows for a message ({ emoji, user_id }), used to rebuild
// the aggregate counts client-side after a toggle.
async function getReactionsForMessage(messageId: string) {
  const { data } = await supabaseAdmin
    .from('message_reactions')
    .select('emoji, user_id')
    .eq('message_id', messageId);
  return data || [];
}

async function setConversationE2ee(conversationId: string, enabled: boolean) {
  const { error } = await supabaseAdmin
    .from('conversations')
    .update({ e2ee_enabled: enabled })
    .eq('id', conversationId);
  if (error) { logger.error({ err: error, conversationId, enabled }, 'Failed to toggle conversation E2EE'); throw new Error('Не удалось переключить шифрование'); }
}

// ── Is the *other* member of a direct conversation blocked (either way)? ───
// Group conversations aren't checked — blocking only affects 1:1 DMs here.
async function directPartnerBlocked(conversationId: string, senderId: string) {
  const otherId = await getDirectPartnerId(conversationId, senderId);
  if (!otherId) return false;
  return areUsersBlocked(senderId, otherId);
}

// ── E2EE: current public key for a user, straight from `users` (not from
// whatever the client claims) — this is what gets stamped onto encrypted
// messages as sender_public_key, so a client can't misattribute a message
// to a key it doesn't actually own.
async function getPublicKey(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('public_key')
    .eq('id', userId)
    .maybeSingle();
  return data?.public_key ?? null;
}

// ── Is this user actually a member of this conversation? ──────────────────
async function isConversationMember(conversationId: string, userId: string) {
  if (!conversationId || !userId) return false;
  const { data } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

export {
  MESSAGE_SELECT,
  GLOBAL_MESSAGE_SELECT,
  saveMessage,
  saveGlobalMessage,
  editMessageRow,
  deleteMessageRow,
  directPartnerBlocked,
  getDirectPartnerId,
  isConversationMember,
  getPublicKey,
  getConversationE2ee,
  setConversationE2ee,
  setConversationPin,
  getPinnedMessage,
  getMessageById,
  toggleReaction,
  getReactionsForMessage,
};

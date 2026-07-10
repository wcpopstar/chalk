import { v4 as uuid } from 'uuid';
import { supabaseAdmin } from '../services/supabase';
import { areUsersBlocked } from '../services/blockHelper';
import loggerBase from '../utils/logger';
import * as analytics from '../services/analytics';
const logger = loggerBase.child({ module: 'messages' });

const MESSAGE_SELECT = `
  id, conversation_id, sender_id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
  preview_title, preview_url, preview_thumbnail, preview_video_id, reply_to_id,
  is_encrypted, nonce, sender_public_key,
  sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url ),
  reply_to:messages!messages_reply_to_id_fkey ( id, text, type, deleted_at, sender_id, sender:users!messages_sender_id_fkey ( username ) )
`;
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

async function saveMessage({ conversationId, senderId, text, type, mediaUrl, duration, preview, replyToId, ciphertext, nonce, senderPublicKey }: MessageInput & { conversationId: string }) {
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
  const update = 'ciphertext' in edit
    ? { text: edit.ciphertext, nonce: edit.nonce, sender_public_key: edit.senderPublicKey, edited_at: new Date().toISOString() }
    : { text: edit.text, edited_at: new Date().toISOString() };
  const { data, error } = await supabaseAdmin
    .from(table)
    .update(update as any)
    .eq('id', id)
    .eq('sender_id', senderId)
    .eq('type', 'text')
    .is('deleted_at', null)
    .select(select)
    .single();
  if (error) { logger.error({ err: error, table, id, senderId }, 'Failed to edit message'); throw new Error(error.message || 'Не удалось отредактировать сообщение'); }
  if (!data) throw new Error('Сообщение не найдено — возможно, оно уже удалено или это не ваше сообщение');
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

// ── Is the *other* member of a direct conversation blocked (either way)? ───
// Group conversations aren't checked — blocking only affects 1:1 DMs here.
async function directPartnerBlocked(conversationId: string, senderId: string) {
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
  isConversationMember,
  getPublicKey,
};

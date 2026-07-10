import { v4 as uuid } from 'uuid';
import { supabaseAdmin } from '../services/supabase';
import { areUsersBlocked } from '../services/blockHelper';
import loggerBase from '../utils/logger';
import * as analytics from '../services/analytics';
const logger = loggerBase.child({ module: 'messages' });

const MESSAGE_SELECT = `
  id, conversation_id, sender_id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
  preview_title, preview_url, preview_thumbnail, preview_video_id, reply_to_id,
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
}

async function saveMessage({ conversationId, senderId, text, type, mediaUrl, duration, preview, replyToId }: MessageInput & { conversationId: string }) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert({
      id: uuid(),
      conversation_id: conversationId,
      sender_id: senderId,
      // set only when actually replying — keeps plain sends working even if
      // migration 014 hasn't been applied yet (column absent)
      ...(replyToId ? { reply_to_id: replyToId } : {}),
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
    .select(MESSAGE_SELECT)
    .single();
  if (error) { logger.error({ err: error, conversationId, senderId }, 'Failed to save message'); throw new Error(error.message || 'Не удалось отправить сообщение'); }
  analytics.capture(senderId, 'message_sent', { type: type || 'text', scope: 'direct' });
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
async function editMessageRow(table: 'messages' | 'global_messages', select: string, id: string, senderId: string, text: string) {
  const { data, error } = await supabaseAdmin
    .from(table)
    .update({ text, edited_at: new Date().toISOString() })
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
};

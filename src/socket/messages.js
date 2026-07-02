const { v4: uuid } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { areUsersBlocked } = require('../services/blockHelper');

const MESSAGE_SELECT = 'id, conversation_id, sender_id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at, preview_title, preview_url, preview_thumbnail, preview_video_id, sender:users!messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )';
const GLOBAL_MESSAGE_SELECT = `
  id, text, type, media_url, duration_seconds, edited_at, deleted_at, created_at,
  preview_title, preview_url, preview_thumbnail, preview_video_id,
  sender:users!global_messages_sender_id_fkey ( id, username, avatar_emoji, avatar_url )
`;

// ── Persist chat message to DB ────────────────────────────────────────────
async function saveMessage({ conversationId, senderId, text, type, mediaUrl, duration, preview }) {
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
      preview_title: preview?.title || null,
      preview_url: preview?.url || null,
      preview_thumbnail: preview?.thumbnail || null,
      preview_video_id: preview?.videoId || null,
      created_at: new Date().toISOString(),
    })
    .select(MESSAGE_SELECT)
    .single();
  if (error) { console.error('[saveMessage]', error); throw new Error(error.message || 'Не удалось отправить сообщение'); }
  return data;
}

// ── Persist a global (platform-wide) chat message ─────────────────────────
async function saveGlobalMessage({ senderId, text, type, mediaUrl, duration, preview }) {
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

// ── Is this user actually a member of this conversation? ──────────────────
async function isConversationMember(conversationId, userId) {
  if (!conversationId || !userId) return false;
  const { data } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

module.exports = {
  MESSAGE_SELECT,
  GLOBAL_MESSAGE_SELECT,
  saveMessage,
  saveGlobalMessage,
  editMessageRow,
  deleteMessageRow,
  directPartnerBlocked,
  isConversationMember,
};

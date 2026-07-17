// Short summary strings for the chat list + chat header. Localized via the i18n
// adapter; presenceStatusLabel composes the shared formatLastSeen formatter.
import { T } from '../i18n/t.js';
import { formatLastSeen } from '../utils/format.js';

// One-line preview of a conversation's last message for the chat list.
export function lastMessagePreview(m) {
  if (!m) return '';
  if (m.deleted_at) return T('msg_deleted_label');
  // The chats-list endpoint returns only is_encrypted (not the nonce/keys
  // needed to decrypt), and we don't have the per-conversation partner key
  // handy here anyway — show a neutral lock placeholder for encrypted DMs.
  if (m.is_encrypted) return '🔒 Сообщение';
  if (m.type === 'voice') return `🎤 ${T('voice_msg_title')}`;
  if (m.type === 'gif') return '🎞️ GIF';
  if (m.type === 'video_note') return `⭕ ${T('video_note_title', 'Видеосообщение')}`;
  if (m.type === 'image') return `📷 ${T('attach_photo', 'Фото')}`;
  if (m.type === 'video') return `🎥 ${T('attach_video', 'Видео')}`;
  if (m.type === 'file') return `📎 ${m.text || T('attach_file', 'Файл')}`;
  return (m.text || '').slice(0, 34);
}

// "online" / a "last seen …" line for the chat header.
export function presenceStatusLabel(user) {
  if (!user) return '';
  if (user.status === 'online') return T('status_online_lc');
  return formatLastSeen(user.last_seen);
}

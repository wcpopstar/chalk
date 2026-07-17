// Pure HTML-string builders for message bubbles. Each takes a message object
// and returns markup — no DOM access, no app state (currentUser etc.), so they
// extract cleanly. They compose the shared escaping / formatting modules.
//
// Note: some returned markup contains inline on*="fn(...)" handlers referencing
// legacy globals (scrollToMsg, toggleVideoNotePlayback). Those are resolved by
// the browser at click time against window, so they need no import here.
import { T } from '../i18n/t.js';
import { escHtml } from '../utils/dom.js';
import { msgDayKey, formatDayLabel } from '../utils/format.js';

// "↪ Forwarded from X" label above the bubble content, for forwarded copies.
export function forwardedLabelHtml(m) {
  if (!m.forwarded_from) return '';
  return `<div class="msg-forwarded-label">↪ ${T('forwarded_from_label')} <b>${escHtml(m.forwarded_from)}</b></div>`;
}

// One-line preview of the quoted message (by type), for a reply quote.
function replySnippet(q) {
  if (q.deleted_at) return T('msg_deleted_label');
  switch (q.type) {
    case 'voice': return `🎤 ${T('voice_msg_title')}`;
    case 'gif': return '🎞️ GIF';
    case 'video_note': return `⭕ ${T('video_note_title', 'Видеосообщение')}`;
    case 'image': return `📷 ${T('attach_photo', 'Фото')}`;
    case 'video': return `🎥 ${T('attach_video', 'Видео')}`;
    case 'file': return `📎 ${q.text || T('attach_file', 'Файл')}`;
    default: return (q.text || '').slice(0, 60);
  }
}

// The quoted-message preview shown above a reply.
export function replyQuoteHtml(m) {
  if (!m.reply_to_id && !m.reply_to) return '';
  const q = m.reply_to;
  if (!q) return `<div class="msg-reply-quote"><span class="msg-reply-quote-text">${T('msg_deleted_label')}</span></div>`;
  const name = q.sender && q.sender.username ? q.sender.username : T('status_user');
  const snippet = replySnippet(q);
  return `<div class="msg-reply-quote" onclick="scrollToMsg('${escHtml(q.id || '')}')"><span class="msg-reply-quote-name">${escHtml(name)}</span><span class="msg-reply-quote-text">${escHtml(snippet)}</span></div>`;
}

// A "Today" / "Yesterday" / date divider inserted between day groups.
export function dateDividerHtml(iso) {
  return `<div class="msg-date-divider" data-day="${escHtml(msgDayKey(iso))}"><span>${escHtml(formatDayLabel(iso))}</span></div>`;
}

// Rich link card for a YouTube message (thumbnail + title).
export function youtubePreviewHtml(m) {
  const videoId = m.preview_video_id || '';
  const link = m.preview_url || m.text || '#';
  const thumb = m.preview_thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '');
  const title = m.preview_title || 'YouTube video';
  const thumbHtml = thumb ? `<img class="msg-youtube-thumb" src="${escHtml(thumb)}" alt="youtube preview" loading="lazy">` : '';
  return `<div class="msg-youtube-card"><a href="${escHtml(link)}" target="_blank" rel="noopener noreferrer" class="msg-youtube-link">${thumbHtml}<div class="msg-youtube-meta"><div class="msg-youtube-title">${escHtml(title)}</div><div class="msg-youtube-sub">Open on YouTube</div></div></a></div>`;
}

// Circular "video note" bubble (Telegram-style kruzhok).
export function videoNoteHtml(m) {
  const secs = m.duration_seconds;
  const dur = secs ? `${Math.floor(secs / 60)}:${secs % 60 < 10 ? '0' : ''}${secs % 60}` : '';
  const durHtml = dur ? `<div class="msg-video-note-dur">${dur}</div>` : '';
  return `<div class="msg-video-note-wrap"><video class="msg-video-note" src="${escHtml(m.media_url)}" playsinline muted loop preload="metadata" onclick="toggleVideoNotePlayback(this)"></video><div class="msg-video-note-play" onclick="toggleVideoNotePlayback(this.previousElementSibling)">▶</div>${durHtml}</div>`;
}

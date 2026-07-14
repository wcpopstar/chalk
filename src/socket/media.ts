import { v4 as uuid } from 'uuid';
import { supabaseAdmin } from '../services/supabase';

// ── Lightweight magic-byte sniffing ─────────────────────────────────────────
// We don't trust the client-supplied `mime` for what ends up as the
// extension/Content-Type of a file we publish to a public bucket — instead
// we peek at the actual bytes and only accept containers this app knows how
// to play back. Not a full codec validator, just enough to reject anything
// that clearly isn't audio/video (e.g. HTML, an executable, etc).
function detectContainer(buffer: Buffer) {
  if (!buffer || buffer.length < 8) return null;
  // WebM / Matroska — EBML header
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm';
  // Ogg
  if (buffer.slice(0, 4).toString('ascii') === 'OggS') return 'ogg';
  // MP4 / M4A (ISO base media file format) — 'ftyp' box, usually at offset 4
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  return null;
}

// ── Voice notes: upload raw audio bytes to Supabase Storage, return URL ────
const VOICE_BUCKET = 'voice-notes';
const MAX_VOICE_BYTES = 4 * 1024 * 1024; // ~4MB (roughly a couple of minutes of compressed audio)

async function uploadVoiceNote(senderId: string, buffer: Buffer, _mime: string) {
  if (!buffer || !buffer.length) throw new Error('Пустая запись');
  if (buffer.length > MAX_VOICE_BYTES) throw new Error('Голосовое сообщение слишком длинное');

  const container = detectContainer(buffer);
  if (!container) throw new Error('Недопустимый формат аудио');

  const ext = container === 'ogg' ? 'ogg' : (container === 'mp4' ? 'm4a' : 'webm');
  const contentType = container === 'ogg' ? 'audio/ogg' : (container === 'mp4' ? 'audio/mp4' : 'audio/webm');
  const path = `${senderId}/${uuid()}.${ext}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(VOICE_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });
  if (uploadErr) throw uploadErr;

  const { data } = supabaseAdmin.storage.from(VOICE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ── Video notes ("video kruzhki"): upload raw video bytes to Supabase Storage ─
const VIDEO_BUCKET = 'video-notes';
const MAX_VIDEO_BYTES = 8 * 1024 * 1024; // ~8MB — plenty for a ~30s low-bitrate circular clip

async function uploadVideoNote(senderId: string, buffer: Buffer, _mime: string) {
  if (!buffer || !buffer.length) throw new Error('Пустая запись');
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('Видеосообщение слишком длинное');

  const container = detectContainer(buffer);
  if (container !== 'webm' && container !== 'mp4') throw new Error('Недопустимый формат видео');

  const ext = container === 'mp4' ? 'mp4' : 'webm';
  const contentType = container === 'mp4' ? 'video/mp4' : 'video/webm';
  const path = `${senderId}/${uuid()}.${ext}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });
  if (uploadErr) throw uploadErr;

  const { data } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ── Chat attachments (photo / video / arbitrary file) ───────────────────────
const CHAT_MEDIA_BUCKET = 'chat-media';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB — matches socketSchemas.ts

// Sniff common image containers by magic bytes (same trust model as
// detectContainer: don't believe the client-supplied mime for a public URL).
function detectImage(buffer: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

// A conservative extension for a `file` attachment: keep the original one (for a
// friendlier download) but strip it down to a short alphanumeric token so it
// can't inject anything into the storage path.
function safeExt(name?: string | null): string {
  const m = (name || '').match(/\.([A-Za-z0-9]{1,10})$/);
  return m && m[1] ? m[1].toLowerCase() : 'bin';
}

async function uploadChatMedia(senderId: string, buffer: Buffer, _mime: string, name?: string | null) {
  if (!buffer || !buffer.length) throw new Error('Пустой файл');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Файл слишком большой (макс. 25 МБ)');

  let type: 'image' | 'video' | 'file';
  let ext: string;
  let contentType: string;

  const img = detectImage(buffer);
  const container = detectContainer(buffer);
  if (img) {
    type = 'image';
    ext = img === 'jpeg' ? 'jpg' : img;
    contentType = img === 'jpeg' ? 'image/jpeg' : `image/${img}`;
  } else if (container === 'webm' || container === 'mp4') {
    type = 'video';
    ext = container;
    contentType = container === 'mp4' ? 'video/mp4' : 'video/webm';
  } else {
    // Anything else is treated as a generic download. Serve it as an opaque
    // octet-stream so an uploaded .html/.svg/.js can never render inline.
    type = 'file';
    ext = safeExt(name);
    contentType = 'application/octet-stream';
  }

  const path = `${senderId}/${uuid()}.${ext}`;
  const { error: uploadErr } = await supabaseAdmin.storage
    .from(CHAT_MEDIA_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });
  if (uploadErr) throw uploadErr;

  const { data } = supabaseAdmin.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, type };
}

export { uploadVoiceNote, uploadVideoNote, uploadChatMedia };

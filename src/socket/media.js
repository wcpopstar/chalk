const { v4: uuid } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');

// ── Lightweight magic-byte sniffing ─────────────────────────────────────────
// We don't trust the client-supplied `mime` for what ends up as the
// extension/Content-Type of a file we publish to a public bucket — instead
// we peek at the actual bytes and only accept containers this app knows how
// to play back. Not a full codec validator, just enough to reject anything
// that clearly isn't audio/video (e.g. HTML, an executable, etc).
function detectContainer(buffer) {
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

async function uploadVoiceNote(senderId, buffer, _mime) {
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

async function uploadVideoNote(senderId, buffer, _mime) {
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

module.exports = { uploadVoiceNote, uploadVideoNote };

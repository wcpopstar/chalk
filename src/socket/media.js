const { v4: uuid } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');

// ── Voice notes: upload raw audio bytes to Supabase Storage, return URL ────
const VOICE_BUCKET = 'voice-notes';
const MAX_VOICE_BYTES = 4 * 1024 * 1024; // ~4MB (roughly a couple of minutes of compressed audio)

async function uploadVoiceNote(senderId, buffer, mime) {
  if (!buffer || !buffer.length) throw new Error('Пустая запись');
  if (buffer.length > MAX_VOICE_BYTES) throw new Error('Голосовое сообщение слишком длинное');

  const ext = mime && mime.includes('ogg') ? 'ogg' : (mime && mime.includes('mp4') ? 'm4a' : 'webm');
  const path = `${senderId}/${uuid()}.${ext}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(VOICE_BUCKET)
    .upload(path, buffer, { contentType: mime || 'audio/webm', upsert: false });
  if (uploadErr) throw uploadErr;

  const { data } = supabaseAdmin.storage.from(VOICE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ── Video notes ("video kruzhki"): upload raw video bytes to Supabase Storage ─
const VIDEO_BUCKET = 'video-notes';
const MAX_VIDEO_BYTES = 8 * 1024 * 1024; // ~8MB — plenty for a ~30s low-bitrate circular clip

async function uploadVideoNote(senderId, buffer, mime) {
  if (!buffer || !buffer.length) throw new Error('Пустая запись');
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('Видеосообщение слишком длинное');

  const ext = mime && mime.includes('mp4') ? 'mp4' : 'webm';
  const path = `${senderId}/${uuid()}.${ext}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .upload(path, buffer, { contentType: mime || 'video/webm', upsert: false });
  if (uploadErr) throw uploadErr;

  const { data } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { uploadVoiceNote, uploadVideoNote };

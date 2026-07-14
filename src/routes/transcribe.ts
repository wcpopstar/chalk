/**
 * Voice-message transcription — proxies an OpenAI-compatible Whisper
 * /audio/transcriptions endpoint (Groq by default; also OpenAI or a
 * self-hosted whisper.cpp server) so the API key stays server-side.
 *
 * The client sends the public URL of a voice note it wants transcribed; we
 * download it and forward the bytes to the STT provider. To avoid turning this
 * into an SSRF gadget, we ONLY accept URLs that live under our own Supabase
 * `voice-notes` bucket — never an arbitrary attacker-supplied URL.
 */
import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { userLimiter } = require('../middleware/rateLimit');
const logger = require('../utils/logger').child({ module: 'transcribe' });
const { config } = require('../config/env');

// Transcription hits a paid/quota'd external API, so keep it modest per user.
const transcribeLimiter = userLimiter({
  windowMs: 60 * 1000,
  max: 12,
  message: 'Слишком много запросов на расшифровку, подожди немного.',
});

// Voice notes are short; cap the download so a tampered URL can't stream a
// huge file through us into the STT provider.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function allowedVoiceUrlPrefix(): string | null {
  if (!config.supabase.url) return null;
  return `${config.supabase.url}/storage/v1/object/public/voice-notes/`;
}

/**
 * @openapi
 * /api/transcribe:
 *   post:
 *     tags: [Chat]
 *     summary: Transcribe a voice message to text (Whisper)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mediaUrl: { type: string, description: Public URL of a voice note in our storage bucket }
 *     responses:
 *       200: { description: Transcript, content: { application/json: { schema: { type: object, properties: { text: { type: string } } } } } }
 *       400: { description: Missing or invalid mediaUrl }
 *       502: { description: STT provider failed }
 *       503: { description: Transcription not configured (STT_API_KEY missing) }
 */
router.post('/', requireAuth, transcribeLimiter, async (req: Request, res: Response) => {
  if (!config.stt.enabled || !config.stt.apiKey) {
    return res.status(503).json({ error: 'Transcription is not configured' });
  }

  const { mediaUrl } = (req.body || {}) as { mediaUrl?: unknown };
  const prefix = allowedVoiceUrlPrefix();
  if (typeof mediaUrl !== 'string' || !prefix || !mediaUrl.startsWith(prefix)) {
    return res.status(400).json({ error: 'Invalid mediaUrl' });
  }

  // 1) Download the voice note from our own bucket.
  let audioBuf: Buffer;
  let contentType = 'audio/webm';
  try {
    const audioRes = await fetch(mediaUrl);
    if (!audioRes.ok) {
      logger.warn({ status: audioRes.status }, 'voice note download failed');
      return res.status(502).json({ error: 'Could not fetch the voice note' });
    }
    const len = Number(audioRes.headers.get('content-length') || 0);
    if (len && len > MAX_AUDIO_BYTES) {
      return res.status(400).json({ error: 'Voice note is too large to transcribe' });
    }
    contentType = audioRes.headers.get('content-type') || contentType;
    const arrayBuf = await audioRes.arrayBuffer();
    if (arrayBuf.byteLength > MAX_AUDIO_BYTES) {
      return res.status(400).json({ error: 'Voice note is too large to transcribe' });
    }
    audioBuf = Buffer.from(arrayBuf);
  } catch (err) {
    logger.warn({ err }, 'voice note download error');
    return res.status(502).json({ error: 'Could not fetch the voice note' });
  }

  // 2) Forward to the Whisper-compatible endpoint as multipart/form-data.
  const ext = contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audioBuf], { type: contentType }), `voice.${ext}`);
  form.append('model', config.stt.model);
  form.append('response_format', 'json');

  let sttRes;
  try {
    sttRes = await fetch(config.stt.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.stt.apiKey}` },
      body: form,
    });
  } catch (err) {
    logger.warn({ err }, 'STT request failed');
    return res.status(502).json({ error: 'Transcription is temporarily unavailable' });
  }

  if (!sttRes.ok) {
    const detail = await sttRes.text().catch(() => '');
    logger.warn({ status: sttRes.status, detail: detail.slice(0, 300) }, 'STT returned a non-OK response');
    return res.status(502).json({ error: 'Transcription is temporarily unavailable' });
  }

  const data: any = await sttRes.json().catch(() => ({}));
  const text = (data && typeof data.text === 'string') ? data.text.trim() : '';
  return res.json({ text });
});

export = router;

import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { userLimiter } from '../middleware/rateLimit';
import { aiReplySchema, aiPrefsSchema } from '../validation/aiSchemas';
import { supabaseAdmin } from '../services/supabase';
import { isAiEnabled, ensureChalkBot, sendGreeting, voiceReply, getUserAiInstructions } from '../services/aiChalk';
import { sendError } from '../utils/http';

const aiLimiter = userLimiter({ windowMs: 60 * 1000, max: 10, message: 'Слишком часто, подожди немного.' });
// A voice conversation naturally produces a turn every few seconds — allow
// that pace but still cap the per-user Groq budget.
const replyLimiter = userLimiter({ windowMs: 60 * 1000, max: 20, message: 'Слишком часто, подожди немного.' });

/**
 * @openapi
 * /api/ai/status:
 *   get:
 *     tags: [AI]
 *     summary: Is the Chalk AI assistant available on this deployment?
 */
router.get('/status', requireAuth, aiLimiter, (_req: Request, res: Response) => {
  return res.json({ enabled: isAiEnabled() });
});

/**
 * @openapi
 * /api/ai/chat:
 *   post:
 *     tags: [AI]
 *     summary: Get or create the current user's DM with the Chalk AI bot
 *     description: Idempotent, mirrors POST /api/chats/direct but the partner is the built-in assistant bot. On first creation the bot posts a greeting.
 */
// The AI conversation is type 'ai' (like 'saved', see migration 035 header
// comment): it never shows up in the DM list — the client renders it as a
// fixed sidebar entry instead — but reuses the whole message pipeline.
router.post('/chat', requireAuth, aiLimiter, async (req: Request, res: Response) => {
  if (!isAiEnabled()) return sendError(res, 503, 'AI-помощник не настроен на этом сервере');
  const botId = await ensureChalkBot();
  if (!botId) return sendError(res, 503, 'AI-помощник временно недоступен');
  const uid = req.user.id;

  const { data: bot } = await supabaseAdmin
    .from('users')
    .select('id, username, avatar_emoji, avatar_url, is_bot')
    .eq('id', botId)
    .single();

  // Existing 'ai' conversation → reuse.
  const { data: aiConv } = await supabaseAdmin
    .from('conversation_members')
    .select('conversation_id, conversations!inner ( id, type )')
    .eq('user_id', uid)
    .eq('conversations.type', 'ai')
    .limit(1)
    .maybeSingle();
  if (aiConv) {
    return res.json({ conversation: { id: aiConv.conversation_id, type: 'ai' }, bot });
  }

  // Legacy: a plain DM with the bot from before the 'ai' type existed —
  // convert it in place (keeps the history) instead of creating a duplicate.
  const { data: legacy } = await supabaseAdmin.rpc('find_direct_conversation', {
    user_a: uid,
    user_b: botId,
  });
  if (legacy && legacy.length && legacy[0]) {
    const legacyId = legacy[0].id;
    await supabaseAdmin.from('conversations').update({ type: 'ai' }).eq('id', legacyId);
    return res.json({ conversation: { id: legacyId, type: 'ai' }, bot });
  }

  const convId = uuid();
  const { data: conv, error: convErr } = await supabaseAdmin
    .from('conversations')
    .insert({ id: convId, type: 'ai', name: 'Chalk AI', created_at: new Date().toISOString() })
    .select()
    .single();
  if (convErr) return res.status(500).json({ error: convErr.message });

  const { error: memErr } = await supabaseAdmin.from('conversation_members').insert([
    { conversation_id: convId, user_id: uid },
    { conversation_id: convId, user_id: botId },
  ]);
  if (memErr) return res.status(500).json({ error: memErr.message });

  // Fire-and-forget so chat creation isn't held hostage by the greeting.
  void sendGreeting(convId);

  return res.status(201).json({ conversation: conv, bot });
});

/**
 * @openapi
 * /api/ai/prefs:
 *   get:
 *     tags: [AI]
 *     summary: The current user's personal instructions for the Chalk AI bot
 *   put:
 *     tags: [AI]
 *     summary: Update them (empty string resets to default behaviour)
 */
router.get('/prefs', requireAuth, aiLimiter, async (req: Request, res: Response) => {
  const instructions = await getUserAiInstructions(req.user.id);
  return res.json({ instructions: instructions || '' });
});

router.put('/prefs', requireAuth, aiLimiter, validate({ body: aiPrefsSchema }), async (req: Request, res: Response) => {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ ai_instructions: req.body.instructions || null })
    .eq('id', req.user.id);
  if (error) {
    // Most likely cause: migration 035 not applied yet (column missing).
    return res.status(500).json({ error: 'Не удалось сохранить — проверь, что миграция 035 применена (npm run migrate)' });
  }
  return res.json({ ok: true, instructions: req.body.instructions || '' });
});

/**
 * @openapi
 * /api/ai/reply:
 *   post:
 *     tags: [AI]
 *     summary: One voice-call turn with the Chalk AI bot
 *     description: Stateless — the client sends the running call transcript, gets the next spoken reply back. Nothing is persisted.
 */
router.post('/reply', requireAuth, replyLimiter, validate({ body: aiReplySchema }), async (req: Request, res: Response) => {
  if (!isAiEnabled()) return sendError(res, 503, 'AI-помощник не настроен на этом сервере');
  const text = await voiceReply(req.body.messages, req.user.id);
  if (!text) return sendError(res, 502, 'AI-помощник не смог ответить, попробуй ещё раз');
  return res.json({ text });
});

export = router;

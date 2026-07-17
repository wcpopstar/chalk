import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
const router = Router();
import { v4 as uuid } from 'uuid';
import { createHash, randomBytes } from 'node:crypto';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uuidParam } from '../validation/common';
import { userLimiter } from '../middleware/rateLimit';
import { createBotSchema, botJoinChatSchema, botSendMessageSchema } from '../validation/botSchemas';
import { supabaseAdmin } from '../services/supabase';
import { saveMessage, isConversationMember } from '../socket/messages';
import { checkMessage } from '../services/autoModeration';
import { sendError } from '../utils/http';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'bots' });

const MAX_BOTS_PER_USER = 5;

const manageLimiter = userLimiter({ windowMs: 10 * 60 * 1000, max: 30, message: 'Слишком много операций с ботами, подожди немного.' });
const botSendLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Бот шлёт сообщения слишком часто.' });

// ── Token helpers ─────────────────────────────────────────────────────────
// The token is shown to the owner exactly once; only its SHA-256 is stored
// (users.bot_token_hash), so a DB leak doesn't leak usable bot credentials.
function newBotToken() {
  const token = `chalk_bot_${randomBytes(24).toString('hex')}`;
  return { token, hash: hashBotToken(token) };
}
function hashBotToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

// ── requireBotToken ───────────────────────────────────────────────────────
// Auth for the bot-facing API: "Authorization: Bot chalk_bot_…". Resolves the
// bot user by token hash and stamps req.user with its id so the per-user rate
// limiter keys on the bot, not the caller's IP.
async function requireBotToken(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bot ')) {
    return sendError(res, 401, 'Ожидается заголовок Authorization: Bot <token>');
  }
  const token = header.slice(4).trim();
  if (!token.startsWith('chalk_bot_')) return sendError(res, 401, 'Неверный формат токена бота');

  const { data: bot } = await supabaseAdmin
    .from('users')
    .select('id, username, is_bot')
    .eq('bot_token_hash', hashBotToken(token))
    .eq('is_bot', true)
    .maybeSingle();
  if (!bot) return sendError(res, 401, 'Неверный токен бота');

  (req as any).bot = bot;
  req.user = { id: bot.id } as any;
  return next();
}

const BOT_SELECT = 'id, username, avatar_emoji, avatar_url, created_at';

/**
 * @openapi
 * /api/bots:
 *   get:
 *     tags: [Bots]
 *     summary: List the current user's bots
 */
router.get('/', requireAuth, manageLimiter, async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select(BOT_SELECT)
    .eq('bot_owner_id', req.user.id)
    .eq('is_bot', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ bots: data || [] });
});

/**
 * @openapi
 * /api/bots:
 *   post:
 *     tags: [Bots]
 *     summary: Create a bot (the token is returned only once)
 */
router.post('/', requireAuth, manageLimiter, validate({ body: createBotSchema }), async (req: Request, res: Response) => {
  const uid = req.user.id;
  const { username } = req.body;

  const { count } = await supabaseAdmin
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('bot_owner_id', uid)
    .eq('is_bot', true);
  if ((count || 0) >= MAX_BOTS_PER_USER) {
    return sendError(res, 400, `Не больше ${MAX_BOTS_PER_USER} ботов на аккаунт`);
  }

  const { data: taken } = await supabaseAdmin
    .from('users').select('id').ilike('username', username).maybeSingle();
  if (taken) return sendError(res, 409, 'Это имя уже занято');

  const botId = uuid();
  const { token, hash } = newBotToken();
  const { data: bot, error } = await supabaseAdmin
    .from('users')
    .insert({
      id: botId,
      username,
      // Synthetic unique address on a reserved TLD — bots never receive mail
      // and can't log in with a password (the hash below is random hex, which
      // bcrypt.compare() will never match).
      email: `bot+${botId}@bots.chalk.invalid`,
      password_hash: randomBytes(32).toString('hex'),
      is_bot: true,
      bot_owner_id: uid,
      bot_token_hash: hash,
      avatar_emoji: '🤖',
      onboarding_completed: true,
      status: 'online',
      created_at: new Date().toISOString(),
    })
    .select(BOT_SELECT)
    .single();
  if (error) {
    logger.error({ err: error, uid }, 'Failed to create bot');
    return res.status(500).json({ error: 'Не удалось создать бота' });
  }
  return res.status(201).json({ bot, token });
});

/**
 * @openapi
 * /api/bots/{id}/token:
 *   post:
 *     tags: [Bots]
 *     summary: Regenerate the bot's token (old one stops working immediately)
 */
router.post('/:id/token', requireAuth, manageLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  const { token, hash } = newBotToken();
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ bot_token_hash: hash })
    .eq('id', req.params.id as string)
    .eq('bot_owner_id', req.user.id)
    .eq('is_bot', true)
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return sendError(res, 404, 'Бот не найден');
  return res.json({ token });
});

/**
 * @openapi
 * /api/bots/{id}:
 *   delete:
 *     tags: [Bots]
 *     summary: Delete a bot (its messages stay, membership rows cascade)
 */
router.delete('/:id', requireAuth, manageLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .delete()
    .eq('id', req.params.id as string)
    .eq('bot_owner_id', req.user.id)
    .eq('is_bot', true)
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return sendError(res, 404, 'Бот не найден');
  return res.json({ ok: true });
});

/**
 * @openapi
 * /api/bots/{id}/chats:
 *   post:
 *     tags: [Bots]
 *     summary: Add the bot to one of the owner's conversations
 */
router.post('/:id/chats', requireAuth, manageLimiter, validate({ params: uuidParam(), body: botJoinChatSchema }), async (req: Request, res: Response) => {
  const uid = req.user.id;
  const botId = req.params.id as string;
  const convId = req.body.conversation_id;

  const { data: bot } = await supabaseAdmin
    .from('users').select('id, username')
    .eq('id', botId).eq('bot_owner_id', uid).eq('is_bot', true).maybeSingle();
  if (!bot) return sendError(res, 404, 'Бот не найден');

  // The owner must themselves be in the chat they're adding the bot to.
  if (!(await isConversationMember(convId, uid))) {
    return sendError(res, 403, 'Ты не участник этого чата');
  }

  const { error } = await supabaseAdmin
    .from('conversation_members')
    .upsert({ conversation_id: convId, user_id: botId }, { onConflict: 'conversation_id,user_id' });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ ok: true });
});

/**
 * @openapi
 * /api/bots/{id}/chats/{chatId}:
 *   delete:
 *     tags: [Bots]
 *     summary: Remove the bot from a conversation
 */
router.delete('/:id/chats/:chatId', requireAuth, manageLimiter, validate({ params: uuidParam('id').merge(uuidParam('chatId')) }), async (req: Request, res: Response) => {
  const { data: bot } = await supabaseAdmin
    .from('users').select('id')
    .eq('id', req.params.id as string).eq('bot_owner_id', req.user.id).eq('is_bot', true).maybeSingle();
  if (!bot) return sendError(res, 404, 'Бот не найден');

  const { error } = await supabaseAdmin
    .from('conversation_members')
    .delete()
    .eq('conversation_id', req.params.chatId as string)
    .eq('user_id', req.params.id as string);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bot-facing API (Authorization: Bot <token>)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /api/bots/self:
 *   get:
 *     tags: [Bots]
 *     summary: Who am I + which chats am I in (bot token auth)
 */
router.get('/self', requireBotToken, botSendLimiter, async (req: Request, res: Response) => {
  const bot = (req as any).bot;
  const { data: memberships } = await supabaseAdmin
    .from('conversation_members')
    .select('conversation_id, conversation:conversations ( id, type, name )')
    .eq('user_id', bot.id);
  return res.json({
    bot: { id: bot.id, username: bot.username },
    chats: (memberships || []).map((m: any) => m.conversation).filter(Boolean),
  });
});

/**
 * @openapi
 * /api/bots/messages:
 *   post:
 *     tags: [Bots]
 *     summary: Send a message as the bot (bot token auth)
 */
router.post('/messages', requireBotToken, botSendLimiter, validate({ body: botSendMessageSchema }), async (req: Request, res: Response) => {
  const bot = (req as any).bot;
  const { conversation_id: convId, text } = req.body;

  if (!(await isConversationMember(convId, bot.id))) {
    return sendError(res, 403, 'Бот не добавлен в этот чат');
  }
  // Same plaintext auto-moderation as human messages.
  const verdict = await checkMessage(bot.id, text);
  if (!verdict.ok) return sendError(res, 400, verdict.error || 'Сообщение отклонено');

  try {
    const msg = await saveMessage({ conversationId: convId, senderId: bot.id, text, type: 'text' });
    // Deliver over the same socket room the web client listens on.
    const { getIO } = require('../socket/registry');
    getIO()?.to(`chat:${convId}`).emit('chat:message', msg as any);
    return res.status(201).json({ message: msg });
  } catch (e: any) {
    return res.status(500).json({ error: e.message || 'Не удалось отправить сообщение' });
  }
});

export = router;

import { z } from 'zod';

// ── Bots ──────────────────────────────────────────────────────────────────
// Bot usernames follow the same charset as human usernames (see
// userSchemas.usernameField) — they render everywhere a username does, so the
// same XSS-safe charset applies.
const botNameField = z
  .string()
  .trim()
  .min(3, 'Имя бота — от 3 до 24 символов')
  .max(24, 'Имя бота — от 3 до 24 символов')
  .regex(/^[a-zA-Z0-9 _-]+$/, 'Только буквы, цифры, пробел, _ и -');

// POST /api/bots
const createBotSchema = z.object({
  username: botNameField,
});

// POST /api/bots/:id/chats — attach the bot to one of the owner's chats
const botJoinChatSchema = z.object({
  conversation_id: z.string().uuid(),
});

// POST /api/bots/messages — the bot-token API. Text limits mirror the
// socket chat:message schema (messages.text has a 2000-char DB check).
const botSendMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  text: z.string().trim().min(1, 'Пустое сообщение').max(2000, 'Слишком длинное сообщение'),
});

export { createBotSchema, botJoinChatSchema, botSendMessageSchema };

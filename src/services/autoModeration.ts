/**
 * Auto-moderation for plaintext chat surfaces (global chat, non-E2EE DMs and
 * group chats, server channels). E2EE messages are ciphertext to the server
 * and deliberately can't be inspected.
 *
 * Three checks, in order:
 *   1. mute   — a user who recently collected 3 strikes is temporarily muted;
 *   2. text   — profanity (RU/EN stem lists over normalized text) and link
 *               spam (too many URLs in one message);
 *   3. flood  — the same message repeated 3× in a short window.
 *
 * Each violation = one strike (Redis, 10-min window). The 3rd strike auto-
 * mutes the sender on every moderated surface for 15 minutes. Redis errors
 * fail OPEN (messages flow unmoderated), matching the rate limiter's
 * philosophy: an infra hiccup must not take chat down.
 *
 * Kill switch: the moderation.auto.enabled feature flag.
 */
import { redis } from '../socket/redisClient';
import { isEnabled } from './featureFlags';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'autoModeration' });

const STRIKE_WINDOW_SEC = 10 * 60;
const STRIKES_TO_MUTE = 3;
const MUTE_SEC = 15 * 60;
const FLOOD_WINDOW_SEC = 30;
const FLOOD_REPEATS = 3;
const MAX_LINKS = 3;

// ── Normalization ────────────────────────────────────────────────────────────
// Two lookalike maps because the same character dodges different alphabets:
// in RU leet «3» stands for «з» («пи3дец»), in EN leet '3' stands for 'e'
// ('sh3t'). Each profanity list is tested against its own normalized family.
const TO_CYRILLIC: Record<string, string> = {
  '0': 'о', '3': 'з', '4': 'ч', '6': 'б', '@': 'а',
  a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', b: 'в', m: 'м', h: 'н', t: 'т', u: 'и',
};
const TO_LATIN: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's',
};

function lower(text: string) {
  return text.toLowerCase().replace(/ё/g, 'е');
}

// A cyrillic-leaning copy (leet digits + latin twins → cyrillic) for the RU list.
function cyrillicForm(text: string) {
  return lower(text).replace(/[0346@aeopcxykbmhtu]/g, (ch) => TO_CYRILLIC[ch] ?? ch);
}

// A latin-leaning copy (leet digits/symbols → latin letters) for the EN list.
function latinForm(text: string) {
  return lower(text).replace(/[0134578@$]/g, (ch) => TO_LATIN[ch] ?? ch);
}

// Collapse letter repeats ("бляяяя" → "бля") and strip separators punched
// between letters ("б.л.я" → "бля"). Applied as EXTRA forms — stems are
// tested against every form, so collapsing can't hide a match it would break.
function collapsed(text: string) {
  return text.replace(/(.)\1{1,}/g, '$1');
}
function stripped(text: string) {
  return text.replace(/[\s.\-_*+~'"`|/\\]+/g, '');
}

// ── Profanity stems ──────────────────────────────────────────────────────────
// RU roots must not fire inside innocent words ("себя", "употребил"), so each
// requires a non-letter boundary (or string start) before the stem.
const RU_PROFANITY = new RegExp(
  '(^|[^а-яa-z])(' + [
    'ху[йиеяё]', 'пизд', 'бля[дтб]?', '[ое]?[ёе]б[аиуыоеё]', 'заеб', 'уеб', 'долбо[её]б',
    'мудак', 'мудил', 'пидор', 'пидар', 'гандон', 'гондон', 'шлюх', 'залуп', 'хуес', 'еблан',
  ].join('|') + ')',
  'i'
);
const EN_PROFANITY = /(^|[^a-z])(fuck\w*|shit\w*|bitch\w*|cunt\w*|asshole\w*|fagg?ot\w*|nigg(er|a)\w*|whore\w*|slut\w*|dickhead\w*)/i;

function containsProfanity(text: string): boolean {
  const cyr = cyrillicForm(text);   // pure-cyrillic text passes through unchanged
  const lat = latinForm(text);      // pure-ascii text passes through unchanged
  const ruForms = [cyr, collapsed(cyr), stripped(cyr)];
  const enForms = [lat, collapsed(lat), stripped(lat)];
  return ruForms.some((f) => RU_PROFANITY.test(f)) || enForms.some((f) => EN_PROFANITY.test(f));
}

function isLinkSpam(text: string): boolean {
  const links = text.match(/https?:\/\/\S+|www\.\S+/gi) || [];
  return links.length > MAX_LINKS;
}

// ── Redis-backed strikes / mute / flood ─────────────────────────────────────
const muteKey = (userId: string) => `am:mute:${userId}`;
const strikesKey = (userId: string) => `am:strikes:${userId}`;
const floodKey = (userId: string) => `am:flood:${userId}`;

// djb2 — cheap, non-cryptographic; only used to compare "same text as last time".
function textHash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h);
}

export interface ModerationVerdict {
  ok: boolean;
  reason?: 'muted' | 'profanity' | 'link_spam' | 'flood';
  error?: string;
  mutedForSec?: number;
}

async function addStrikeAndMaybeMute(userId: string): Promise<boolean> {
  const strikes = await redis.incr(strikesKey(userId));
  if (strikes === 1) await redis.expire(strikesKey(userId), STRIKE_WINDOW_SEC);
  if (strikes >= STRIKES_TO_MUTE) {
    await redis.set(muteKey(userId), '1', 'EX', MUTE_SEC);
    await redis.del(strikesKey(userId));
    logger.info({ userId }, 'Auto-moderation: user auto-muted');
    return true;
  }
  return false;
}

const MUTED_ERROR = 'Автомодерация: слишком много нарушений — отправка сообщений временно ограничена (15 минут).';

async function violation(userId: string, reason: 'profanity' | 'link_spam' | 'flood', error: string): Promise<ModerationVerdict> {
  try {
    const muted = await addStrikeAndMaybeMute(userId);
    if (muted) return { ok: false, reason, error: `${error} ${MUTED_ERROR}` };
  } catch (e) {
    logger.warn({ err: e }, 'Auto-moderation strike bookkeeping failed (ignored)');
  }
  return { ok: false, reason, error };
}

/**
 * Main entry point — call before persisting any plaintext user message.
 * Resolves to { ok: true } when the message may be sent.
 */
async function checkMessage(userId: string, text: string): Promise<ModerationVerdict> {
  if (!(await isEnabled('moderation.auto.enabled', { userId }))) return { ok: true };

  try {
    const ttl = await redis.ttl(muteKey(userId));
    if (ttl > 0) return { ok: false, reason: 'muted', error: MUTED_ERROR, mutedForSec: ttl };
  } catch (e) {
    logger.warn({ err: e }, 'Auto-moderation mute check failed — failing open');
    return { ok: true };
  }

  if (containsProfanity(text)) {
    return violation(userId, 'profanity', 'Автомодерация: сообщение содержит недопустимую лексику.');
  }
  if (isLinkSpam(text)) {
    return violation(userId, 'link_spam', 'Автомодерация: слишком много ссылок в сообщении.');
  }

  // Flood: the exact same text sent repeatedly in a short window.
  try {
    const h = textHash(lower(text).trim());
    const key = floodKey(userId);
    const prev = await redis.get(key);
    const [prevHash, prevCountRaw] = (prev || '').split(':');
    const count = prevHash === h ? Number(prevCountRaw || 1) + 1 : 1;
    await redis.set(key, `${h}:${count}`, 'EX', FLOOD_WINDOW_SEC);
    if (count >= FLOOD_REPEATS) {
      return violation(userId, 'flood', 'Автомодерация: не отправляй одно и то же сообщение подряд.');
    }
  } catch (e) {
    logger.warn({ err: e }, 'Auto-moderation flood check failed (ignored)');
  }

  return { ok: true };
}

export { checkMessage, containsProfanity, isLinkSpam };

import crypto from 'crypto';
import loggerBase from '../utils/logger';
import * as emailCodesRepository from '../repositories/emailCodesRepository';
import { enqueueEmailCode } from '../queues';
import { sendCodeEmail } from './mailer';

const logger = loggerBase.child({ module: 'email-codes' });

type Purpose = 'verify_email' | 'login';

// A 6-digit numeric code, zero-padded ("047312"). randomInt is a CSPRNG.
function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Issues a fresh code for (user, purpose): supersedes any outstanding codes,
 * stores the hash, and delivers the code by email. Delivery goes through the
 * email queue (same as password resets) so a slow SMTP server can't hold the
 * request open — but if enqueuing fails (e.g. Redis is down in local dev), we
 * fall back to sending inline so the code still reaches the user / dev console.
 *
 * Never returns the code — callers must not be able to leak it.
 */
async function issueAndSendCode(user: { id: string; email: string }, purpose: Purpose): Promise<void> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + emailCodesRepository.CODE_TTL_MS).toISOString();

  await emailCodesRepository.invalidateOutstanding(user.id, purpose);
  const { error } = await emailCodesRepository.create({ userId: user.id, purpose, codeHash: hashCode(code), expiresAt });
  if (error) {
    logger.error({ err: error }, 'Failed to persist email code');
    throw new Error('could not create email code');
  }

  try {
    await enqueueEmailCode(user.email, code, purpose);
  } catch (e: any) {
    logger.warn({ err: e }, 'Could not enqueue code email — sending inline as fallback');
    await sendCodeEmail(user.email, code, purpose);
  }
}

/**
 * Checks a submitted code against the newest outstanding one for
 * (user, purpose). Consumes the code on success; counts a failed attempt and
 * caps brute-forcing otherwise. Returns a small result object rather than
 * touching res, so callers control the response shape. Shared by the auth
 * code endpoints (routes/auth/emailCodes.ts) and the 2FA settings flow
 * (routes/auth/security.ts).
 */
async function checkCode(userId: string, purpose: Purpose, code: string): Promise<{ ok: boolean; error?: string }> {
  const { data: row } = await emailCodesRepository.findLatestValid(userId, purpose);
  const invalid = { ok: false, error: 'Код недействителен или устарел' };

  if (!row) return invalid;
  if (new Date(row.expires_at) < new Date()) return invalid;
  if (row.attempts >= emailCodesRepository.MAX_ATTEMPTS) {
    return { ok: false, error: 'Слишком много попыток. Запроси новый код.' };
  }
  if (row.code_hash !== hashCode(code)) {
    await emailCodesRepository.incrementAttempts(row.id, row.attempts);
    return invalid;
  }
  await emailCodesRepository.markUsed(row.id);
  return { ok: true };
}

export { issueAndSendCode, hashCode, generateCode, checkCode };

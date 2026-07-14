const crypto = require('crypto');
const logger = require('../utils/logger').child({ module: 'email-codes' });
const emailCodesRepository = require('../repositories/emailCodesRepository');
const { enqueueEmailCode } = require('../queues');
const { sendCodeEmail } = require('./mailer');

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

export { issueAndSendCode, hashCode, generateCode };

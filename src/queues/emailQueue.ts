const { Queue } = require('bullmq');
const logger = require('../utils/logger').child({ module: 'email-queue' });
const { queueConnection } = require('./connection');
const { EMAIL } = require('./queueNames');

// Job names within the 'email' queue — the worker switches on these.
const JOBS = {
  PASSWORD_RESET: 'password-reset',
  EMAIL_CODE: 'email-code',
};

let _emailQueue: any = null;

// Lazily creates the Queue on first use, rather than at module load. Route
// modules (routes/auth/passwordReset.js) require this file just to get
// enqueuePasswordResetEmail — requiring it must stay side-effect-free as
// far as Redis is concerned, same reasoning as the lazyConnect option on
// queueConnection (see connection.js), so that requiring the auth router in
// tests still doesn't need a real Redis.
function getEmailQueue() {
  if (_emailQueue) return _emailQueue;
  _emailQueue = new Queue(EMAIL, {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }, // 2s, 4s, 8s
      // Don't let a chatty queue grow forever — keep a little history for
      // debugging without leaking memory in Redis.
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });
  _emailQueue.on('error', (err: any) => {
    logger.error({ err }, 'Email queue error');
  });
  return _emailQueue;
}

/**
 * Enqueues a password-reset email instead of sending it inline in the
 * request. Previously `POST /api/auth/forgot-password` awaited
 * `sendPasswordResetEmail` directly — an SMTP hiccup meant the request
 * either hung or timed out for the person waiting on it, even though we
 * don't want to reveal send failures to the client either way.
 *
 * Adding a job can itself fail (e.g. Redis unreachable) — callers should
 * still catch and log, same as they would have caught a mailer failure
 * before, since a generic response is returned to the client regardless.
 */
async function enqueuePasswordResetEmail(to: string, resetUrl: string) {
  await getEmailQueue().add(JOBS.PASSWORD_RESET, { to, resetUrl });
}

// Enqueues a verification/login code email. `purpose` is 'verify_email' or
// 'login' — the worker forwards it to sendCodeEmail, which picks the copy.
async function enqueueEmailCode(to: string, code: string, purpose: string) {
  await getEmailQueue().add(JOBS.EMAIL_CODE, { to, code, purpose });
}

// Closes the queue only if it was actually instantiated (i.e. something
// called enqueuePasswordResetEmail at least once) — deliberately does NOT
// call getEmailQueue(), which would create one just to immediately close it.
async function closeEmailQueue() {
  if (_emailQueue) await _emailQueue.close();
}

export { getEmailQueue, closeEmailQueue, JOBS, enqueuePasswordResetEmail, enqueueEmailCode };

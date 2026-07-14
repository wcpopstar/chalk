const logger = require('../utils/logger').child({ module: 'queues' });
const { queueConnection } = require('./connection');
const { getEmailQueue, closeEmailQueue, enqueuePasswordResetEmail, enqueueEmailCode } = require('./emailQueue');

// Every queue's close-if-open helper should be listed here so shutdown
// closes all of them, not just the one someone remembered to wire in. Each
// one is a no-op if that queue was never actually instantiated (queues are
// lazy — see emailQueue.js) — a process that never enqueued anything
// shouldn't spin one up just to close it.
const closers = [closeEmailQueue];

async function closeQueues() {
  await Promise.allSettled(closers.map((close: () => Promise<unknown>) => close()));
  await queueConnection.quit().catch((err: any) => {
    logger.warn({ err }, 'Queue Redis connection did not close cleanly');
  });
}

export { getEmailQueue, enqueuePasswordResetEmail, enqueueEmailCode, closeQueues };

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const logger = require('../utils/logger').child({ module: 'queues' });
const { queueConnection } = require('./connection');
const { getEmailQueue, closeEmailQueue, enqueuePasswordResetEmail } = require('./emailQueue');
// Every queue's close-if-open helper should be listed here so shutdown
// closes all of them, not just the one someone remembered to wire in. Each
// one is a no-op if that queue was never actually instantiated (queues are
// lazy — see emailQueue.js) — a process that never enqueued anything
// shouldn't spin one up just to close it.
const closers = [closeEmailQueue];
async function closeQueues() {
    await Promise.allSettled(closers.map((close) => close()));
    await queueConnection.quit().catch((err) => {
        logger.warn({ err }, 'Queue Redis connection did not close cleanly');
    });
}
module.exports = { getEmailQueue, enqueuePasswordResetEmail, closeQueues };
//# sourceMappingURL=index.js.map
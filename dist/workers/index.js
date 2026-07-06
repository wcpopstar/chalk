"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const logger = require('../utils/logger').child({ module: 'workers' });
const { createEmailWorker } = require('./emailWorker');
let workers = [];
// Starts every worker. Add new workers (push, file processing, ...) here —
// this is the single place both src/index.js (in-process mode) and
// src/worker.js (standalone worker process) call into.
function startWorkers() {
    if (workers.length)
        return workers; // idempotent — don't double-start
    workers = [createEmailWorker()];
    logger.info({ count: workers.length }, 'Workers started');
    return workers;
}
async function closeWorkers() {
    await Promise.allSettled(workers.map((w) => w.close()));
    workers = [];
}
module.exports = { startWorkers, closeWorkers };
//# sourceMappingURL=index.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require('dotenv').config();
// Standalone entrypoint for running queue workers as their own
// process/service, separate from the HTTP+Socket.io server (src/index.ts).
//
// Why a separate entrypoint at all, instead of only running workers
// in-process inside index.ts?
//   - It lets you scale web traffic and job processing independently
//     (e.g. 3 web dynos + 1 worker dyno on Railway/Render/Fly, instead of
//     every web instance also competing for the same jobs).
//   - A slow/stuck job (e.g. SMTP timing out) can't hold up anything
//     related to serving HTTP requests, because it's a different process.
//
// For small/single-instance deployments this is optional — src/index.ts
// also starts these same workers in-process by default (see
// RUN_WORKERS_IN_PROCESS in .env.example). Run `npm run worker` as its own
// process once you outgrow that, and set RUN_WORKERS_IN_PROCESS=false so
// jobs aren't processed twice.
const logger = require('./utils/logger');
const { validateEnv } = require('./config/env');
const { startWorkers, closeWorkers } = require('./workers');
const { closeQueues } = require('./queues');
const { redis, waitForRedisReady } = require('./socket/redisClient');
validateEnv();
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection in worker process');
});
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception in worker process');
});
// Note: RUN_WORKERS_IN_PROCESS (config.workers.runInProcess) only governs
// whether src/index.ts ALSO starts workers in-process — this standalone
// entrypoint always starts them, that's the entire point of running it. If
// both this process AND a web instance left at its default were run
// together, jobs would be double-processed — see .env.example.
waitForRedisReady()
    .then(() => {
    startWorkers();
    logger.info('🔧 Chalk worker process running');
})
    .catch((err) => {
    logger.fatal({ err }, 'Redis never became ready, exiting worker process');
    process.exit(1);
});
const SHUTDOWN_TIMEOUT_MS = 15_000;
let isShuttingDown = false;
async function shutdown(signal) {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    logger.info({ signal }, '🛑 Worker process received shutdown signal, draining…');
    const forceExitTimer = setTimeout(() => {
        logger.fatal({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Worker graceful shutdown timed out — forcing exit');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();
    try {
        // Worker.close() waits for any job currently being processed to finish
        // before resolving, instead of dropping it mid-flight.
        await closeWorkers();
        logger.info('Workers closed');
        await closeQueues();
        logger.info('Queue connections closed');
        await redis.quit().catch((err) => logger.warn({ err }, 'Redis (main) did not close cleanly'));
        logger.info('✅ Worker process shutdown complete');
        clearTimeout(forceExitTimer);
        process.exit(0);
    }
    catch (err) {
        logger.error({ err }, 'Error during worker process shutdown');
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
//# sourceMappingURL=worker.js.map
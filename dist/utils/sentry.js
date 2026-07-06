"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Sentry init module.
 *
 * NOTE on load order: this file is required from src/index.ts as early as
 * possible, BEFORE config/env.ts's validateEnv() has run. That's
 * deliberate — Sentry needs to be initialized before anything else gets a
 * chance to throw, so its own instrumentation can catch it. This means
 * `config` here is read at require-time same as everywhere else, it's just
 * that this particular require happens to be the first one — validateEnv()
 * hasn't thrown yet at this point, but config.jwt.secret etc. being null
 * doesn't matter for what THIS file reads (only sentry.* and server.*).
 *
 * See .env.example for SENTRY_DSN / SENTRY_TRACES_SAMPLE_RATE.
 */
const Sentry = require('@sentry/node');
const logger = require('./logger');
const { config } = require('../config/env');
if (config.sentry.dsn) {
    Sentry.init({
        dsn: config.sentry.dsn,
        environment: config.server.nodeEnv,
        release: config.sentry.release,
        tracesSampleRate: config.sentry.tracesSampleRate,
    });
    logger.info('Sentry error reporting initialized');
}
else {
    logger.warn('SENTRY_DSN not set — Sentry error reporting is disabled (errors will still be logged locally)');
}
module.exports = Sentry;
//# sourceMappingURL=sentry.js.map
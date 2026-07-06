"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * HTTP request logging middleware, built on pino-http.
 *
 * What this gives us:
 *  - One structured log line per request/response (method, path, status,
 *    response time, request id) — no more manually console.logging routes.
 *  - A correlation/request id (`x-request-id`) that:
 *      1. Is reused if the client/proxy already sent one (so a request can
 *         be traced end-to-end across services behind a load balancer).
 *      2. Is generated fresh otherwise.
 *      3. Is echoed back in the response header.
 *      4. Is attached to `req.log` (and therefore to every log line that
 *         handler emits), and to `req.id` for use in response bodies.
 *  - Automatic redaction, inherited from the base logger config.
 *
 * Usage (in src/index.js):
 *   const { requestLogger } = require('./middleware/requestLogger');
 *   app.use(requestLogger);
 *   // ...routes...
 *   app.get('/api/x', (req, res) => {
 *     req.log.info({ userId: req.user.id }, 'Fetched something');
 *   });
 */
const { randomUUID } = require('crypto');
const pinoHttp = require('pino-http');
const logger = require('../utils/logger');
const REQUEST_ID_HEADER = 'x-request-id';
const requestLogger = pinoHttp({
    logger,
    // Reuse an inbound request id (e.g. set by a proxy/load balancer or the
    // frontend) so logs correlate across hops; otherwise mint a new uuid.
    genReqId(req, res) {
        const existingId = req.headers[REQUEST_ID_HEADER];
        const id = existingId || randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
    },
    // Custom log level per response status, so 4xx/5xx are actually visible
    // as warn/error instead of getting lost among info-level 200s.
    customLogLevel(req, res, err) {
        if (err || res.statusCode >= 500)
            return 'error';
        if (res.statusCode >= 400)
            return 'warn';
        return 'info';
    },
    customSuccessMessage(req, _res) {
        return `${req.method} ${req.url} completed`;
    },
    customErrorMessage(req, _res, err) {
        return `${req.method} ${req.url} failed: ${err.message}`;
    },
    // Trim the noisy default req/res serializers down to what's actually
    // useful day-to-day; headers/body are covered by redact rules already,
    // but we don't want to log full headers on every single line by default.
    serializers: {
        req(req) {
            return {
                id: req.id,
                method: req.method,
                url: req.url,
                remoteAddress: req.remoteAddress,
            };
        },
        res(res) {
            return {
                statusCode: res.statusCode,
            };
        },
    },
    // Skip noisy health checks / metrics scrapes so they don't drown out real traffic.
    autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/metrics',
    },
});
module.exports = { requestLogger, REQUEST_ID_HEADER };
//# sourceMappingURL=requestLogger.js.map
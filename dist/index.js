"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require('dotenv').config();
// Sentry must be required before anything else gets a chance to throw, so
// its init (including automatic uncaught-exception hooking) is in place
// for the rest of the module graph below.
const Sentry = require('./utils/sentry');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const { requestLogger } = require('./middleware/requestLogger');
const { requireAuth } = require('./middleware/auth');
const { config, validateEnv } = require('./config/env');
const { redis, pubClient, subClient, waitForRedisReady } = require('./socket/redisClient');
const { supabase, supabaseAdmin } = require('./services/supabase');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const matchRoutes = require('./routes/match');
const friendRoutes = require('./routes/friends');
const callRoutes = require('./routes/calls');
const chatRoutes = require('./routes/chats');
const agoraRoutes = require('./routes/agora');
const gameRoutes = require('./routes/games');
const featureFlagRoutes = require('./routes/featureFlags');
const { initSocket } = require('./socket');
const { startWorkers, closeWorkers } = require('./workers');
const { closeQueues } = require('./queues');
const metrics = require('./utils/metrics');
const { metricsMiddleware } = require('./middleware/metrics');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
validateEnv();
// Defense in depth: an uncaught error here previously meant the whole
// process died with a raw stack trace and no context (e.g. an unhandled
// Redis command rejection during a Redis outage). Log it clearly instead of
// silently vanishing — this does NOT paper over real bugs, every actual
// Redis-touching code path in this app already has its own try/catch (see
// match.js's startMatchLoop); this only catches things that slip through.
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    Sentry.captureException(reason);
    metrics.appErrorsTotal.inc({ source: 'unhandled_rejection' });
});
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    Sentry.captureException(err);
    metrics.appErrorsTotal.inc({ source: 'uncaught_exception' });
});
const { port, nodeEnv, clientOrigin } = config.server;
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: clientOrigin, methods: ['GET', 'POST'], credentials: true },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 10 * 1024 * 1024,
});
// Redis adapter: broadcasts (io.to(...).emit, io.emit, room joins via
// socketsJoin) are published over Redis pub/sub so every server instance
// behind the load balancer sees events for sockets connected to *other*
// instances. Without this, `initSocket`/calls.js/match.js only work
// correctly when there's exactly one server process.
io.adapter(createAdapter(pubClient, subClient));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    // /health and /metrics are hit by infrastructure (load balancer probes,
    // Prometheus scraper), not end users — they shouldn't share a budget
    // meant to catch API abuse, and a short scrape interval could otherwise
    // trip this limit on its own.
    skip: (req) => req.path === '/health' || req.path === '/metrics',
}));
// Prometheus metrics: request duration + counters. Must be registered
// before the routes below so it wraps every request, same as requestLogger.
app.use(metricsMiddleware);
// Structured request logging + correlation id (req.id / x-request-id).
// Must come after body parsing so req.body is available to any custom
// serializer, and before routes so every handler is covered.
app.use(requestLogger);
// ── Graceful-shutdown state ─────────────────────────────────────────────────
// Flipped to true the moment SIGTERM/SIGINT is received. Checked by /health
// so a load balancer / orchestrator stops routing new traffic to this
// instance as soon as it starts draining, instead of only finding out once
// connections start getting refused.
let isShuttingDown = false;
// Wraps a promise so a hung dependency (Redis/Supabase) can't make /health
// itself hang forever — a stuck healthcheck is as bad as a down one.
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}
async function checkRedisHealth() {
    try {
        if (redis.status !== 'ready') {
            return { status: 'error', error: `not ready (connection status: ${redis.status})` };
        }
        await withTimeout(redis.ping(), 2000, 'Redis ping');
        return { status: 'ok' };
    }
    catch (err) {
        return { status: 'error', error: err.message };
    }
}
async function checkSupabaseHealth() {
    try {
        // HEAD + count-only request: cheapest possible round trip that still
        // proves the DB is reachable and the service key is valid — no rows
        // are actually returned.
        const { error } = await withTimeout(supabaseAdmin.from('users').select('id', { head: true, count: 'exact' }), 2000, 'Supabase query');
        if (error)
            return { status: 'error', error: error.message };
        return { status: 'ok' };
    }
    catch (err) {
        return { status: 'error', error: err.message };
    }
}
app.get('/health', async (_req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({
            status: 'degraded',
            ts: Date.now(),
            reason: 'shutting_down',
            services: { redis: { status: 'unknown' }, supabase: { status: 'unknown' } },
        });
    }
    const [redisHealth, supabaseHealth] = await Promise.all([checkRedisHealth(), checkSupabaseHealth()]);
    const services = { redis: redisHealth, supabase: supabaseHealth };
    const allOk = Object.values(services).every((s) => s.status === 'ok');
    res.status(allOk ? 200 : 503).json({
        status: allOk ? 'ok' : 'degraded',
        ts: Date.now(),
        services,
    });
});
// Prometheus scrape endpoint. Optionally gated behind METRICS_TOKEN — this
// server is typically deployed with a public URL (Railway et al.), and
// while nothing here is a secret on the level of an API key, request
// latencies/error rates/route names are still internal operational detail
// that doesn't need to be world-readable. If METRICS_TOKEN isn't set, the
// endpoint stays open (with a startup warning) so this doesn't break
// existing setups/dashboards that haven't been given a token yet.
app.get('/metrics', async (req, res) => {
    const token = config.metrics.token;
    if (token) {
        const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (provided !== token) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    try {
        res.set('Content-Type', metrics.register.contentType);
        res.end(await metrics.register.metrics());
    }
    catch (err) {
        logger.error({ err }, 'Failed to collect Prometheus metrics');
        res.status(500).end('Failed to collect metrics');
    }
});
// (METRICS_TOKEN-not-set-in-production is already warned about by
// validateEnv() above — one central place for startup config warnings
// instead of scattering them across whichever module happens to consume
// the var.)
// ── API documentation (Swagger UI) ──────────────────────────────────────────
// Off by default in production (see config/env.ts's `docs.enabled` default
// and its validateEnv() warning); when it IS enabled in production, also
// require a valid access token — this is a private app's internal API
// surface, not a public API product, so "logged in" is a reasonable bar
// for "allowed to browse the docs". Wide open in development for
// zero-friction discoverability.
if (config.docs.enabled) {
    const docsGate = config.server.isProduction ? [requireAuth] : [];
    app.use('/api/docs', ...docsGate, swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
        customSiteTitle: 'Chalk API Docs',
    }));
    // Raw spec, for importing into Postman/Insomnia or codegen tools.
    app.get('/api/docs.json', ...docsGate, (_req, res) => res.json(swaggerSpec));
    logger.info(`API docs available at /api/docs${config.server.isProduction ? ' (requires a valid access token)' : ''}`);
}
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/match', matchRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/agora', agoraRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/flags', featureFlagRoutes);
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/'))
        return next();
    res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
    // req.log is the pino-http child logger — already tagged with this
    // request's correlation id, method, and url.
    (req.log || logger).error({ err }, 'Unhandled request error');
    Sentry.captureException(err);
    metrics.appErrorsTotal.inc({ source: 'http' });
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});
let serverInstance;
let stopMatchLoop = () => { };
waitForRedisReady()
    .then(() => {
    // Only now is it safe to start accepting connections and running the
    // matchmaking loop — everything in initSocket() (presence, rooms,
    // matchmaking) reads/writes Redis, and starting it earlier meant
    // hammering a not-yet-ready (or down) connection from the moment the
    // process booted.
    ({ stopMatchLoop } = initSocket(io));
    serverInstance = server.listen(port, () => {
        logger.info({ port, env: nodeEnv }, '🎮 Chalk backend running');
    });
    // Queue workers (email, and later push/file-processing) run in this
    // same process by default — fine for a single web instance. Once
    // you're running multiple web instances, set RUN_WORKERS_IN_PROCESS=false
    // and run `npm run worker` as its own service instead, so jobs aren't
    // picked up redundantly by every web instance. See src/worker.ts.
    if (config.workers.runInProcess) {
        startWorkers();
    }
})
    .catch((err) => {
    logger.fatal({ err }, 'Redis never became ready, exiting');
    process.exit(1);
});
// ── Graceful shutdown ────────────────────────────────────────────────────────
// Order matters here:
//   1. Flip isShuttingDown so /health starts returning 503 immediately —
//      this is what tells Railway/a load balancer to stop sending new
//      traffic to this instance while the rest of the drain happens.
//   2. Stop the matchmaking tick so no new match cycle starts mid-shutdown.
//   3. Close Socket.io: stops accepting new socket handshakes and notifies
//      every currently-connected client the connection is going away.
//   4. Close the HTTP server: stops accepting new HTTP connections and
//      waits for in-flight requests already being handled to finish before
//      its callback fires — this is the "wait for current operations to
//      complete" step.
//   5. Close the Redis connections (main + Socket.io adapter pub/sub) —
//      ioredis .quit() flushes any pending commands before disconnecting,
//      rather than dropping them.
//   6. Close Supabase Realtime channels/sockets, if any are open.
// A hard timeout guarantees the process exits even if some step hangs
// (e.g. a client holding a connection open forever), so the platform never
// has to fall back to SIGKILL after its own grace period expires.
const SHUTDOWN_TIMEOUT_MS = 15_000;
async function shutdown(signal) {
    if (isShuttingDown)
        return; // ignore a second SIGTERM/SIGINT mid-drain
    isShuttingDown = true;
    logger.info({ signal }, '🛑 Received shutdown signal, draining gracefully…');
    const forceExitTimer = setTimeout(() => {
        logger.fatal({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out — forcing exit');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();
    try {
        stopMatchLoop();
        logger.info('Matchmaking loop stopped');
        await new Promise((resolve) => io.close(() => resolve()));
        logger.info('Socket.io connections closed');
        if (serverInstance) {
            await new Promise((resolve) => serverInstance.close(() => resolve()));
            logger.info('HTTP server closed — no longer accepting new connections');
        }
        // Worker.close() waits for any job currently being processed (e.g. a
        // password-reset email mid-send) to finish before resolving, rather
        // than dropping it mid-flight.
        await closeWorkers();
        await closeQueues();
        logger.info('Queue workers and connections closed');
        const redisResults = await Promise.allSettled([redis.quit(), pubClient.quit(), subClient.quit()]);
        redisResults.forEach((result, i) => {
            if (result.status === 'rejected') {
                logger.warn({ err: result.reason, connection: ['main', 'adapter-pub', 'adapter-sub'][i] }, 'Redis connection did not close cleanly');
            }
        });
        logger.info('Redis connections closed');
        const supabaseResults = await Promise.allSettled([
            supabase.removeAllChannels(),
            supabaseAdmin.removeAllChannels(),
        ]);
        supabaseResults.forEach((result, i) => {
            if (result.status === 'rejected') {
                logger.warn({ err: result.reason, client: ['supabase', 'supabaseAdmin'][i] }, 'Supabase client did not close cleanly');
            }
        });
        logger.info('Supabase clients closed');
        logger.info('✅ Graceful shutdown complete');
        clearTimeout(forceExitTimer);
        process.exit(0);
    }
    catch (err) {
        logger.error({ err }, 'Error during graceful shutdown');
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
module.exports = { app, io, server };
//# sourceMappingURL=index.js.map
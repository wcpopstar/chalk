require('dotenv').config();

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
const { getServerConfig, validateEnv } = require('./config/env');
const { pubClient, subClient, waitForRedisReady } = require('./socket/redisClient');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const matchRoutes = require('./routes/match');
const friendRoutes = require('./routes/friends');
const callRoutes = require('./routes/calls');
const chatRoutes = require('./routes/chats');
const agoraRoutes = require('./routes/agora');
const gameRoutes = require('./routes/games');
const { initSocket } = require('./socket');

validateEnv();

// Defense in depth: an uncaught error here previously meant the whole
// process died with a raw stack trace and no context (e.g. an unhandled
// Redis command rejection during a Redis outage). Log it clearly instead of
// silently vanishing — this does NOT paper over real bugs, every actual
// Redis-touching code path in this app already has its own try/catch (see
// match.js's startMatchLoop); this only catches things that slip through.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
});

const { port, nodeEnv, clientOrigin } = getServerConfig();
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
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// Structured request logging + correlation id (req.id / x-request-id).
// Must come after body parsing so req.body is available to any custom
// serializer, and before routes so every handler is covered.
app.use(requestLogger);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/match', matchRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/agora', agoraRoutes);
app.use('/api/games', gameRoutes);

app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  // req.log is the pino-http child logger — already tagged with this
  // request's correlation id, method, and url.
  (req.log || logger).error({ err }, 'Unhandled request error');
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

let serverInstance;
waitForRedisReady()
  .then(() => {
    // Only now is it safe to start accepting connections and running the
    // matchmaking loop — everything in initSocket() (presence, rooms,
    // matchmaking) reads/writes Redis, and starting it earlier meant
    // hammering a not-yet-ready (or down) connection from the moment the
    // process booted.
    initSocket(io);
    serverInstance = server.listen(port, () => {
      logger.info({ port, env: nodeEnv }, '🎮 Chalk backend running');
    });
  })
  .catch((err) => {
    logger.fatal({ err }, 'Redis never became ready, exiting');
    process.exit(1);
  });

const shutdown = (signal) => {
  logger.info({ signal }, '🛑 Shutting down');
  if (serverInstance) {
    serverInstance.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, io, server };

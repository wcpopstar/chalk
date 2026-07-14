export {};
'use strict';

require('./testEnv');

// Same async-error patch production loads first thing in src/index.ts —
// required here (before express/routers are loaded) so HTTP-level tests
// exercise the same "async throw reaches the error middleware" behavior
// as the real app. See src/utils/asyncErrors.ts.
require('../../src/utils/asyncErrors');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { requestLogger } = require('../../src/middleware/requestLogger');

/**
 * Builds a small Express app for HTTP-level tests (supertest), mirroring
 * the relevant slice of src/index.js's middleware stack.
 *
 * Deliberately NOT `require('../../src/index')`: that module has real
 * side effects at import time — it opens live ioredis connections
 * (src/socket/redisClient.js), wires up the Socket.IO Redis adapter, and
 * calls `process.exit(1)` if Redis never becomes ready. None of that is
 * safe or meaningful in a unit/integration test process, and several
 * routes (e.g. friends, agora) transitively pull in that Redis client too
 * — which is why this harness only mounts the specific routers a test
 * asks for (e.g. the auth router) instead of the full route set.
 *
 * @param {object} [routes] - map of { mountPath: router } to attach,
 *   e.g. { '/api/auth': authRouter }
 */
function buildTestApp(routes = {}) {
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(requestLogger);

  app.get('/health', (_req: any, res: any) => res.json({ status: 'ok', ts: Date.now() }));

  Object.entries(routes).forEach(([mountPath, router]) => {
    app.use(mountPath, router);
  });

  app.use((_req: any, res: any) => res.status(404).json({ error: 'Not found' }));

  app.use((err: any, req: any, res: any, _next: any) => {
    (req.log || console).error(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { buildTestApp };

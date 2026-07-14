export {};
'use strict';

require('../helpers/testEnv');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

// Must be loaded BEFORE the routers below are created — same ordering
// contract as src/index.ts. (buildTestApp also loads it, but this test
// builds its own bare app to pin down the patch itself.)
require('../../src/utils/asyncErrors');

// Mirrors the centralized error middleware in src/index.ts (minus
// logging/Sentry/metrics): the assertion target for every test below.
function withErrorHandler(app: any) {
  app.use((err: any, _req: any, res: any, next: any) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });
  return app;
}

describe('asyncErrors express patch', () => {
  it('routes a rejection from an async handler to the error middleware (no hang)', async () => {
    const app = express();
    app.get('/boom', async () => {
      throw new Error('async kaboom');
    });
    withErrorHandler(app);

    const res = await request(app).get('/boom');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'async kaboom');
  });

  it('respects err.status set on the thrown error', async () => {
    const app = express();
    app.get('/teapot', async () => {
      const err: any = new Error('short and stout');
      err.status = 418;
      throw err;
    });
    withErrorHandler(app);

    const res = await request(app).get('/teapot');
    assert.equal(res.status, 418);
    assert.equal(res.body.error, 'short and stout');
  });

  it('catches rejections from async middleware registered via app.use', async () => {
    const app = express();
    app.use(async () => {
      throw new Error('middleware kaboom');
    });
    withErrorHandler(app);

    const res = await request(app).get('/anything');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'middleware kaboom');
  });

  it('leaves successful async handlers untouched', async () => {
    const app = express();
    app.get('/ok', async (_req: any, res: any) => {
      res.json({ ok: true });
    });
    withErrorHandler(app);

    const res = await request(app).get('/ok');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('leaves sync handlers and sync throws untouched', async () => {
    const app = express();
    app.get('/sync-ok', (_req: any, res: any) => res.json({ sync: true }));
    app.get('/sync-boom', () => {
      throw new Error('sync kaboom');
    });
    withErrorHandler(app);

    const ok = await request(app).get('/sync-ok');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { sync: true });

    const boom = await request(app).get('/sync-boom');
    assert.equal(boom.status, 500);
    assert.equal(boom.body.error, 'sync kaboom');
  });

  it('preserves arity so async error middleware still registers as error middleware', async () => {
    const app = express();
    app.get('/boom', async () => {
      throw new Error('first');
    });
    // 4-arg async error middleware: must still be recognized by Express
    // (fn.length === 4) after wrapping, and its own rejection must fall
    // through to the next error handler.
    app.use(async (_err: any, _req: any, _res: any, _next: any) => {
      throw new Error('error middleware kaboom');
    });
    withErrorHandler(app);

    const res = await request(app).get('/boom');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'error middleware kaboom');
  });
});

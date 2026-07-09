export {};
'use strict';

// Integration test: requires the REAL src/index.ts — live Redis needed
// (localhost in dev, the redis service container in CI). Supabase stays a
// placeholder (testEnv), so /health legitimately reports it as degraded;
// what this file asserts is the actual wiring of the composed app: boot,
// middleware order, mounted routes, static/SPA fallback, metrics gating,
// and the full Socket.IO handshake (reject + accept + disconnect cleanup).
//
// Runs in its own process (one process per test file), so the require-cache
// stubs used by the unit tests never leak in here — everything below is the
// genuine article except Supabase.

process.env.PORT = String(30000 + Math.floor(Math.random() * 20000));
process.env.METRICS_TOKEN = 'test-metrics-token';

require('../helpers/testEnv');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');

const { signAccessToken } = require('../../src/utils/jwt');

const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const userId = '11111111-1111-4111-8111-111111111111';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('../../src/index');

function waitForServer(timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = require('http').get(`${BASE}/metrics`, () => { req.destroy(); resolve(); });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`server did not start listening on ${PORT} within ${timeoutMs}ms — is Redis running?`));
        } else {
          setTimeout(probe, 250);
        }
      });
    };
    probe();
  });
}

describe('src/index.ts (composed app boot)', () => {
  before(async () => {
    await waitForServer();
  });

  it('reports Redis healthy on /health (Supabase is a placeholder here, so overall 503)', async () => {
    const res = await request(BASE).get('/health');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.services.redis.status, 'ok');
    assert.equal(res.body.services.supabase.status, 'error');
  });

  it('sends the Content-Security-Policy header', async () => {
    const res = await request(BASE).get('/health');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  });

  it('serves the SPA at / and falls back to it for client-side routes', async () => {
    const root = await request(BASE).get('/');
    assert.equal(root.status, 200);
    assert.match(root.headers['content-type'], /html/);

    const fallback = await request(BASE).get('/some/client/route');
    assert.equal(fallback.status, 200);
    assert.match(fallback.headers['content-type'], /html/);
  });

  it('answers 404 JSON for unknown API paths instead of the SPA', async () => {
    const res = await request(BASE).get('/api/definitely-not-a-route');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });

  it('mounts the API routers (auth answers, protected routes demand a token)', async () => {
    const login = await request(BASE).post('/api/auth/login').send({});
    assert.equal(login.status, 400); // validation, not 404 — the router is live

    for (const path of ['/api/friends', '/api/chats', '/api/flags']) {
      const res = await request(BASE).get(path);
      assert.equal(res.status, 401, `${path} should demand auth`);
    }
  });

  it('gates /metrics behind METRICS_TOKEN', async () => {
    const noToken = await request(BASE).get('/metrics');
    assert.equal(noToken.status, 401);

    const withToken = await request(BASE).get('/metrics').set('Authorization', 'Bearer test-metrics-token');
    assert.equal(withToken.status, 200);
    assert.match(withToken.text, /http_requests_total/);
  });

  it('exposes Swagger docs outside production', async () => {
    const res = await request(BASE).get('/api/docs.json');
    assert.equal(res.status, 200);
    assert.match(res.body.openapi, /^3\.0/);
  });

  describe('Socket.IO wiring', () => {
    function connect(auth: any): Promise<{ socket: any; error?: Error }> {
      return new Promise((resolve) => {
        const socket = ioClient(BASE, { auth, transports: ['websocket'], reconnection: false, timeout: 5000 });
        socket.on('connect', () => resolve({ socket }));
        socket.on('connect_error', (error: Error) => resolve({ socket, error }));
      });
    }

    it('rejects a handshake without a token', async () => {
      const { socket, error } = await connect({});
      socket.close();
      assert.ok(error, 'expected connect_error');
      assert.match(error!.message, /Authentication required/);
    });

    it('rejects a handshake with a garbage token', async () => {
      const { socket, error } = await connect({ token: 'garbage' });
      socket.close();
      assert.match(error!.message, /Invalid token/);
    });

    it('accepts a valid token and survives a clean disconnect', async () => {
      const { token } = signAccessToken({ id: userId, username: 'boot-test' });
      const { socket, error } = await connect({ token });

      assert.equal(error, undefined, `expected clean connect, got: ${error?.message}`);
      assert.equal(socket.connected, true);

      // online:count is broadcast on every connect — proves the connection
      // handler ran its presence bookkeeping against real Redis.
      const count = await new Promise((resolve) => {
        socket.on('online:count', (n: any) => resolve(n));
        setTimeout(() => resolve(null), 3000);
      });
      assert.notEqual(count, null, 'expected an online:count broadcast after connecting');

      socket.close();
      // Give the server's disconnect handler a beat to run its cleanup path.
      await new Promise((r) => setTimeout(r, 300));
    });
  });

  after(() => {
    // --test-force-exit reaps the listening server, match-loop interval and
    // Redis connections; nothing to tear down by hand without invoking the
    // full process.exit()-based graceful shutdown.
  });
});

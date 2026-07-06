export {};
'use strict';

require('../helpers/testEnv');

// IMPORTANT: this suite deliberately lives in its own file. Node's test
// runner runs each test *file* in its own process by default, but all
// `describe`/`it` blocks *within* one file share the same process — and
// therefore the same rate-limiter state, since express-rate-limit's
// default in-memory store lives for the lifetime of the middleware
// instance. Keeping rate-limit-exhaustion tests isolated to this file
// means they can't accidentally trip limits for test/routes/auth.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { buildTestApp } = require('../helpers/buildTestApp');

const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});
stubModule(require.resolve('../../src/services/mailer'), {
  sendPasswordResetEmail: async () => {},
});

const authRouter = require('../../src/routes/auth');
const app = buildTestApp({ '/api/auth': authRouter });

describe('Auth rate limiting', () => {
  it('blocks login attempts for one email after 5 tries within the window (429)', async () => {
    const email = 'ratelimited-by-email@example.com';
    const statuses = [];

    // The 6th request should be the first to get rejected — every prior
    // attempt fails validation-wise (no matching user) but still counts
    // against the per-email limiter, since that middleware runs first.
    for (let i = 0; i < 6; i += 1) {
      supaMock.reset();
      supaMock.enqueue({ data: null, error: null });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'whatever-wrong-123' });
      statuses.push(res.status);
    }

    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(statuses[5], 429);
  });

  it('does not block a different email while the first one is rate-limited', async () => {
    supaMock.reset();
    supaMock.enqueue({ data: null, error: null });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a-completely-different-email@example.com', password: 'whatever-123' });

    // Still a normal "no such user" response, not 429 — proves the limiter
    // key is per-email rather than global/per-IP.
    assert.equal(res.status, 401);
  });

  it('returns a 429 with a JSON error body, not an HTML default page', async () => {
    const email = 'json-body-check@example.com';

    for (let i = 0; i < 5; i += 1) {
      supaMock.reset();
      supaMock.enqueue({ data: null, error: null });
      await request(app).post('/api/auth/login').send({ email, password: 'x' });
    }

    supaMock.reset();
    const res = await request(app).post('/api/auth/login').send({ email, password: 'x' });

    assert.equal(res.status, 429);
    assert.match(res.headers['content-type'] || '', /json/);
  });
});

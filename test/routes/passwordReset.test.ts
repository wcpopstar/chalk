export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach, before } = require('node:test');
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

// The route enqueues the email through src/queues — stub it so no BullMQ
// queue (and therefore no Redis connection) is ever created here.
let enqueued: any[] = [];
let enqueueError: any = null;
stubModule(require.resolve('../../src/queues'), {
  enqueuePasswordResetEmail: async (to: any, resetUrl: any) => {
    if (enqueueError) throw enqueueError;
    enqueued.push({ to, resetUrl });
  },
  closeQueues: async () => {},
});

const userId = '11111111-1111-4111-8111-111111111111';

describe('Password reset routes (/api/auth)', () => {
  let app: any;

  before(() => {
    app = buildTestApp({ '/api/auth': require('../../src/routes/auth/passwordReset') });
  });

  beforeEach(() => {
    supaMock.reset();
    enqueued = [];
    enqueueError = null;
  });

  describe('POST /api/auth/forgot-password', () => {
    it('rejects a missing/invalid email with 400', async () => {
      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' });
      assert.equal(res.status, 400);
    });

    it('answers generically for an unknown email (no account enumeration)', async () => {
      supaMock.enqueue({ data: null, error: null }); // findByEmailForPasswordReset -> no user

      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(enqueued.length, 0);
    });

    it('creates a reset row and enqueues the email for a known account', async () => {
      supaMock.enqueue({ data: { id: userId, email: 'user@example.com' }, error: null }); // user found
      supaMock.enqueue({ data: null, error: null }); // passwordResets.create ok

      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'user@example.com' });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(enqueued.length, 1);
      assert.equal(enqueued[0].to, 'user@example.com');
      assert.match(enqueued[0].resetUrl, /\/\?reset=[0-9a-f]{64}$/);
    });

    it('returns 500 when the reset row cannot be created', async () => {
      supaMock.enqueue({ data: { id: userId, email: 'user@example.com' }, error: null });
      supaMock.enqueue({ data: null, error: { message: 'insert failed' } }); // create fails

      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'user@example.com' });

      assert.equal(res.status, 500);
      assert.equal(enqueued.length, 0);
    });

    it('still answers generically when enqueueing the email fails (no leak to the client)', async () => {
      supaMock.enqueue({ data: { id: userId, email: 'user@example.com' }, error: null });
      supaMock.enqueue({ data: null, error: null });
      enqueueError = new Error('redis down');

      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'user@example.com' });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });
  });

  describe('POST /api/auth/reset-password', () => {
    const validBody = { token: 'a'.repeat(64), password: 'NewPassw0rd!' };

    it('rejects an unknown/expired/used token with 400', async () => {
      supaMock.enqueue({ data: null, error: null }); // findByTokenHash -> nothing

      const res = await request(app).post('/api/auth/reset-password').send(validBody);
      assert.equal(res.status, 400);
    });

    it('rejects an already-used token', async () => {
      supaMock.enqueue({
        data: { id: 'r1', user_id: userId, used_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
        error: null,
      });

      const res = await request(app).post('/api/auth/reset-password').send(validBody);
      assert.equal(res.status, 400);
    });

    it('rejects an expired token', async () => {
      supaMock.enqueue({
        data: { id: 'r1', user_id: userId, used_at: null, expires_at: new Date(Date.now() - 1000).toISOString() },
        error: null,
      });

      const res = await request(app).post('/api/auth/reset-password').send(validBody);
      assert.equal(res.status, 400);
    });

    it('updates the password, marks the token used, and revokes all sessions', async () => {
      supaMock.enqueue({
        data: { id: 'r1', user_id: userId, used_at: null, expires_at: new Date(Date.now() + 60_000).toISOString() },
        error: null,
      });
      supaMock.enqueue({ data: null, error: null }); // updatePasswordHash ok
      supaMock.enqueue({ data: null, error: null }); // markUsed
      supaMock.enqueue({ data: null, error: null }); // revokeAllForUser (refresh_tokens update)

      const res = await request(app).post('/api/auth/reset-password').send(validBody);

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('returns 500 when the password update fails', async () => {
      supaMock.enqueue({
        data: { id: 'r1', user_id: userId, used_at: null, expires_at: new Date(Date.now() + 60_000).toISOString() },
        error: null,
      });
      supaMock.enqueue({ data: null, error: { message: 'update failed' } });

      const res = await request(app).post('/api/auth/reset-password').send(validBody);
      assert.equal(res.status, 500);
    });
  });
});

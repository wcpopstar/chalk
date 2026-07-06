export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { buildTestApp } = require('../helpers/buildTestApp');
const { signAccessToken } = require('../../src/utils/jwt');

// src/routes/calls.js only requires services/supabase — no Redis, no other
// services — so this is the simplest route file to stub.
const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});

const callsRouter = require('../../src/routes/calls');

describe('Calls routes (/api/calls)', () => {
  let app;
  let token;
  const userId = '11111111-1111-1111-1111-111111111111';

  before(() => {
    app = buildTestApp({ '/api/calls': callsRouter });
    ({ token } = signAccessToken({ id: userId, username: 'caller' }));
  });

  beforeEach(() => {
    supaMock.reset();
  });

  describe('POST /api/calls/start', () => {
    it('rejects requests with no access token', async () => {
      const res = await request(app).post('/api/calls/start').send({});
      assert.equal(res.status, 401);
    });

    it('logs a call with a generated id when roomId is omitted', async () => {
      supaMock.enqueue({
        data: { id: 'generated-id', initiated_by: userId, mode: 'solo', status: 'active' },
        error: null,
      });

      const res = await request(app)
        .post('/api/calls/start')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      assert.equal(res.status, 201);
      assert.equal(res.body.call.status, 'active');
    });

    it('uses the provided roomId, participants and mode', async () => {
      supaMock.enqueue({
        data: {
          id: 'room-42',
          initiated_by: userId,
          participants: [userId, 'user-2'],
          mode: 'group',
          status: 'active',
        },
        error: null,
      });

      const res = await request(app)
        .post('/api/calls/start')
        .set('Authorization', `Bearer ${token}`)
        .send({ roomId: 'room-42', participants: [userId, 'user-2'], mode: 'group' });

      assert.equal(res.status, 201);
      assert.equal(res.body.call.id, 'room-42');
      assert.equal(res.body.call.mode, 'group');
    });

    it('returns 500 when the insert fails', async () => {
      supaMock.enqueue({ data: null, error: { message: 'db is down' } });

      const res = await request(app)
        .post('/api/calls/start')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'db is down');
    });
  });

  describe('PATCH /api/calls/:id/end', () => {
    it('rejects requests with no access token', async () => {
      const res = await request(app).patch('/api/calls/room-1/end').send({});
      assert.equal(res.status, 401);
    });

    it('marks the call ended with the given duration', async () => {
      supaMock.enqueue({ error: null });

      const res = await request(app)
        .patch('/api/calls/room-1/end')
        .set('Authorization', `Bearer ${token}`)
        .send({ duration_seconds: 137 });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    });

    it('defaults duration_seconds to null when omitted', async () => {
      // The mock doesn't assert on the update payload directly, but this
      // exercises the `duration_seconds || null` branch without throwing.
      supaMock.enqueue({ error: null });

      const res = await request(app)
        .patch('/api/calls/room-1/end')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      assert.equal(res.status, 200);
    });

    it('returns 500 when the update fails', async () => {
      supaMock.enqueue({ error: { message: 'call not found' } });

      const res = await request(app)
        .patch('/api/calls/room-1/end')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'call not found');
    });
  });
});

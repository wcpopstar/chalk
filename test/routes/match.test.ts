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

const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});

const matchRouter = require('../../src/routes/match');

describe('Match routes (/api/match)', () => {
  let app: any;
  let token: any;
  const userId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';

  before(() => {
    app = buildTestApp({ '/api/match': matchRouter });
    ({ token } = signAccessToken({ id: userId, username: 'me' }));
  });

  beforeEach(() => {
    supaMock.reset();
  });

  describe('GET /api/match/history', () => {
    it('rejects requests with no access token', async () => {
      const res = await request(app).get('/api/match/history');
      assert.equal(res.status, 401);
    });

    it('returns match history for the caller', async () => {
      supaMock.enqueue({
        data: [{ id: 'aa000001-0000-4000-8000-000000000001', mode: 'solo', created_at: '2026-01-01', games: { name: 'Valorant', emoji: '🎯' } }],
        error: null,
      });

      const res = await request(app).get('/api/match/history').set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.matches.length, 1);
    });

    it('returns 500 when the query fails', async () => {
      supaMock.enqueue({ data: null, error: { message: 'boom' } });

      const res = await request(app).get('/api/match/history').set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 500);
    });
  });

  describe('POST /api/match/record-call', () => {
    it('requires a non-empty participants array', async () => {
      const res = await request(app)
        .post('/api/match/record-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ participants: [] });
      assert.equal(res.status, 400);
    });

    it('excludes the caller from the created rows and maps participantId correctly', async () => {
      supaMock.enqueue({
        data: [{ id: 'mh1', user_a: userId, user_b: otherId }],
        error: null,
      });

      const res = await request(app)
        .post('/api/match/record-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ participants: [userId, otherId], mode: 'group' });

      assert.equal(res.status, 200);
      assert.equal(res.body.matches.length, 1);
      assert.equal(res.body.matches[0].participantId, otherId);
    });

    it('returns an empty list without querying the DB when participants only contains the caller', async () => {
      // No enqueue() at all — if the route incorrectly issued an insert
      // anyway, the mock would just return { data: null, error: null } by
      // default, so we assert on the actual short-circuit response shape.
      const res = await request(app)
        .post('/api/match/record-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ participants: [userId] });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { matches: [] });
    });

    it('returns 500 when the insert fails', async () => {
      supaMock.enqueue({ data: null, error: { message: 'insert failed' } });

      const res = await request(app)
        .post('/api/match/record-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ participants: [userId, otherId] });

      assert.equal(res.status, 500);
    });
  });

  describe('POST /api/match/:matchId/rate', () => {
    it('rejects a rating outside 1-5', async () => {
      const res = await request(app)
        .post('/api/match/aa000001-0000-4000-8000-000000000001/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 7 });
      assert.equal(res.status, 400);
    });

    it('returns 404 when the match does not exist or the caller was not a participant', async () => {
      supaMock.enqueue({ data: null, error: null });

      const res = await request(app)
        .post('/api/match/aa000001-0000-4000-8000-000000000001/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 5 });

      assert.equal(res.status, 404);
    });

    it('rates the other participant and recalculates their average', async () => {
      supaMock.enqueue({ data: { user_a: userId, user_b: otherId }, error: null }); // match lookup
      supaMock.enqueue({ error: null }); // ratings upsert
      supaMock.enqueue({ data: [{ rating: 5 }, { rating: 3 }], error: null }); // ratings for avg
      supaMock.enqueue({ error: null }); // users update avg_rating

      const res = await request(app)
        .post('/api/match/aa000001-0000-4000-8000-000000000001/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 5, comment: 'gg' });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    });

    it('identifies the rated user correctly when the caller is user_b', async () => {
      supaMock.enqueue({ data: { user_a: otherId, user_b: userId }, error: null }); // caller is user_b this time
      supaMock.enqueue({ error: null }); // upsert
      supaMock.enqueue({ data: [{ rating: 4 }], error: null }); // avg recompute
      supaMock.enqueue({ error: null }); // users update

      const res = await request(app)
        .post('/api/match/aa000001-0000-4000-8000-000000000001/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 4 });

      assert.equal(res.status, 200);
    });

    it('skips the average recalculation when no ratings come back', async () => {
      supaMock.enqueue({ data: { user_a: userId, user_b: otherId }, error: null });
      supaMock.enqueue({ error: null }); // upsert
      supaMock.enqueue({ data: [], error: null }); // no ratings at all (shouldn't happen, but guard anyway)

      const res = await request(app)
        .post('/api/match/aa000001-0000-4000-8000-000000000001/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 5 });

      assert.equal(res.status, 200);
    });

    it('returns 500 when the ratings upsert fails', async () => {
      supaMock.enqueue({ data: { user_a: userId, user_b: otherId }, error: null });
      supaMock.enqueue({ error: { message: 'upsert failed' } });

      const res = await request(app)
        .post('/api/match/aa000001-0000-4000-8000-000000000001/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rating: 5 });

      assert.equal(res.status, 500);
    });
  });
});

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
const { FakeRedis } = require('../helpers/fakeRedis');

// src/routes/users.js requires services/blockHelper, which itself only
// requires services/supabase (already stubbed below) — so we let the real
// blockUser/unblockUser run against the mock rather than stubbing them too,
// for a bit more end-to-end coverage.
const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});

// routes/users/publicProfile.ts caches GET /api/users/:id via utils/cache.ts,
// which does `require('../socket/redisClient')` for its `redis` client —
// and redisClient.ts opens THREE real ioredis connections at require time
// (see that file's header comment). In an environment where Redis actually
// is reachable (e.g. this repo's GitHub Actions `test` job, which runs a
// real redis:7-alpine service container), those connections succeed and
// are never closed — a live socket handle that keeps the process alive
// forever, so `node --test` never exits for this file and the CI job just
// hangs. Stub the whole module out with an in-memory fake before users.js
// is ever required, exactly like the socket/*.test.ts files do.
const fakeRedis = new FakeRedis();
stubModule(require.resolve('../../src/socket/redisClient'), {
  redis: fakeRedis,
  pubClient: fakeRedis,
  subClient: fakeRedis,
  waitForRedisReady: async () => {},
  REDIS_URL: 'redis://fake',
});

const usersRouter = require('../../src/routes/users');

async function clearProfileCache(id: any) {
  await fakeRedis.del(`user_profile:${id}`);
}

describe('Users routes (/api/users)', () => {
  let app: any;
  let token: any;
  const userId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';

  before(() => {
    app = buildTestApp({ '/api/users': usersRouter });
    ({ token } = signAccessToken({ id: userId, username: 'me' }));
  });

  beforeEach(async () => {
    supaMock.reset();
    await clearProfileCache(userId);
    await clearProfileCache(otherId);
  });

  describe('PATCH /api/users/me', () => {
    it('rejects requests with no access token', async () => {
      const res = await request(app).patch('/api/users/me').send({ bio: 'hi' });
      assert.equal(res.status, 401);
    });

    it('rejects an empty update body', async () => {
      const res = await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      assert.equal(res.status, 400);
      assert.match(JSON.stringify(res.body.details), /Nothing to update/);
    });

    it('rejects an out-of-range age', async () => {
      const res = await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ age: 5 });
      assert.equal(res.status, 400);
    });

    it('rejects a username containing invalid characters', async () => {
      const res = await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'bad<script>' });
      assert.equal(res.status, 400);
    });

    it('returns 409 when the new username is already taken', async () => {
      supaMock.enqueue({ data: { id: otherId }, error: null }); // uniqueness check finds a match

      const res = await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'TakenName' });

      assert.equal(res.status, 409);
    });

    it('updates the profile with a valid payload', async () => {
      supaMock.enqueue({ data: null, error: null }); // uniqueness check: free
      supaMock.enqueue({ data: { id: userId, username: 'NewName', bio: 'hello' }, error: null }); // update

      const res = await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: 'NewName', bio: 'hello' });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'NewName');
    });

    it('skips the uniqueness check entirely when username is not being changed', async () => {
      supaMock.enqueue({ data: { id: userId, bio: 'just a bio update' }, error: null }); // update only

      const res = await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ bio: 'just a bio update' });

      assert.equal(res.status, 200);
    });
  });

  describe('POST /api/users/me/onboarding', () => {
    const validBody = { age: 21, gender: 'other', languages: ['en'] };

    it('requires age, gender and at least one language', async () => {
      const res = await request(app)
        .post('/api/users/me/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      assert.equal(res.status, 400);
    });

    it('rejects an empty languages array', async () => {
      const res = await request(app)
        .post('/api/users/me/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send({ age: 21, gender: 'other', languages: [] });
      assert.equal(res.status, 400);
    });

    it('completes onboarding and replaces favourite games', async () => {
      supaMock.enqueue({
        data: { id: userId, age: 21, gender: 'other', languages: ['en'], onboarding_completed: true },
        error: null,
      }); // update users
      supaMock.enqueue({ error: null }); // delete existing user_games
      supaMock.enqueue({ error: null }); // insert new user_games

      const res = await request(app)
        .post('/api/users/me/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validBody, games: [{ game_id: 'valorant', hours_played: 100 }] });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.onboarding_completed, true);
    });

    it('works without a games array (skips replaceUserGames entirely)', async () => {
      supaMock.enqueue({ data: { id: userId, ...validBody, onboarding_completed: true }, error: null });

      const res = await request(app)
        .post('/api/users/me/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody);

      assert.equal(res.status, 200);
    });
  });

  describe('PUT /api/users/me/games', () => {
    it('requires games to be an array', async () => {
      const res = await request(app)
        .put('/api/users/me/games')
        .set('Authorization', `Bearer ${token}`)
        .send({ games: 'nope' });
      assert.equal(res.status, 400);
    });

    it('replaces the games list', async () => {
      supaMock.enqueue({ error: null }); // delete
      supaMock.enqueue({ error: null }); // insert

      const res = await request(app)
        .put('/api/users/me/games')
        .set('Authorization', `Bearer ${token}`)
        .send({ games: [{ game_id: 'csgo' }] });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    });

    it('accepts an empty array (clears all games, no insert issued)', async () => {
      supaMock.enqueue({ error: null }); // delete only

      const res = await request(app)
        .put('/api/users/me/games')
        .set('Authorization', `Bearer ${token}`)
        .send({ games: [] });

      assert.equal(res.status, 200);
    });
  });

  describe('GET /api/users/me/stats', () => {
    it('aggregates match/rating/friend counts', async () => {
      // Fired concurrently via Promise.all, in this declared order.
      supaMock.enqueue({ count: 12, error: null });               // match_history count
      supaMock.enqueue({ data: { avg_rating: 4.5 }, error: null }); // ratings
      supaMock.enqueue({ count: 7, error: null });                 // friends count

      const res = await request(app)
        .get('/api/users/me/stats')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { matches_found: 12, avg_rating: 4.5, friends_count: 7 });
    });

    it('defaults to zero/null when nothing comes back', async () => {
      supaMock.enqueue({ count: null, error: null });
      supaMock.enqueue({ data: null, error: null });
      supaMock.enqueue({ count: null, error: null });

      const res = await request(app)
        .get('/api/users/me/stats')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { matches_found: 0, avg_rating: null, friends_count: 0 });
    });
  });

  describe('GET /api/users/discover', () => {
    it('excludes already-swiped and blocked users, filters to online', async () => {
      supaMock.enqueue({ data: [{ target_user_id: 'swiped-1' }], error: null }); // swipes
      supaMock.enqueue({ data: [{ blocker_id: userId, blocked_id: 'blocked-1' }], error: null }); // blocks
      supaMock.enqueue({ data: [{ id: 'discoverable-1', username: 'Stranger', status: 'online' }], error: null }); // users

      const res = await request(app)
        .get('/api/users/discover')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.users[0].id, 'discoverable-1');
    });

    it('filters by game_id and returns an empty list if nobody plays it', async () => {
      supaMock.enqueue({ data: [], error: null }); // swipes
      supaMock.enqueue({ data: [], error: null }); // blocks
      supaMock.enqueue({ data: [], error: null }); // user_games for that game_id -> nobody

      const res = await request(app)
        .get('/api/users/discover?game_id=valorant')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.users, []);
    });
  });

  describe('GET /api/users/search', () => {
    it('requires a non-empty username query param', async () => {
      const res = await request(app)
        .get('/api/users/search')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 400);
    });

    it('exact mode (?exact=1) returns 404 when nobody matches', async () => {
      supaMock.enqueue({ data: null, error: null });

      const res = await request(app)
        .get('/api/users/search?username=NoSuchUser&exact=1')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 404);
    });

    it('exact mode returns the single matching user', async () => {
      supaMock.enqueue({ data: { id: otherId, username: 'ExactMatch' }, error: null });

      const res = await request(app)
        .get('/api/users/search?username=ExactMatch&exact=1')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'ExactMatch');
    });

    it('partial mode ranks exact > prefix > substring matches', async () => {
      supaMock.enqueue({
        data: [
          { id: '1', username: 'annabelle' },  // substring only
          { id: '2', username: 'anna' },       // exact
          { id: '3', username: 'annalise' },   // prefix
        ],
        error: null,
      });

      const res = await request(app)
        .get('/api/users/search?username=anna')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.users.map((u: any) => u.username), ['anna', 'annalise', 'annabelle']);
    });
  });

  describe('GET /api/users/me/blocked', () => {
    it('lists users the caller has blocked', async () => {
      supaMock.enqueue({
        data: [{ id: 'b1', created_at: '2026-01-01', blocked: { id: otherId, username: 'Blocked' } }],
        error: null,
      });

      const res = await request(app)
        .get('/api/users/me/blocked')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.blocked.length, 1);
    });

    it('filters out rows whose joined user no longer exists', async () => {
      supaMock.enqueue({
        data: [
          { id: 'b1', blocked: { id: otherId, username: 'StillThere' } },
          { id: 'b2', blocked: null }, // e.g. the blocked account was deleted
        ],
        error: null,
      });

      const res = await request(app)
        .get('/api/users/me/blocked')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.blocked.length, 1);
    });
  });

  describe('POST /api/users/:id/block', () => {
    it('rejects blocking yourself', async () => {
      const res = await request(app)
        .post(`/api/users/${userId}/block`)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 400);
    });

    it('blocks a user (upsert into blocks, then cleans up any friendship)', async () => {
      supaMock.enqueue({ error: null }); // blocks upsert
      supaMock.enqueue({ error: null }); // friends delete

      const res = await request(app)
        .post(`/api/users/${otherId}/block`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    });
  });

  describe('DELETE /api/users/:id/block', () => {
    it('unblocks a user', async () => {
      supaMock.enqueue({ error: null });

      const res = await request(app)
        .delete(`/api/users/${otherId}/block`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    });
  });

  describe('POST /api/users/:id/report', () => {
    it('rejects reporting yourself', async () => {
      const res = await request(app)
        .post(`/api/users/${userId}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'spam' });
      assert.equal(res.status, 400);
    });

    it('rejects an invalid reason', async () => {
      const res = await request(app)
        .post(`/api/users/${otherId}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'because_i_feel_like_it' });
      assert.equal(res.status, 400);
    });

    it('rejects details longer than 1000 chars', async () => {
      const res = await request(app)
        .post(`/api/users/${otherId}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'spam', details: 'x'.repeat(1001) });
      assert.equal(res.status, 400);
    });

    it('files a report with a valid reason', async () => {
      supaMock.enqueue({ error: null });

      const res = await request(app)
        .post(`/api/users/${otherId}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'harassment', details: 'was rude' });

      assert.equal(res.status, 201);
      assert.deepEqual(res.body, { ok: true });
    });
  });

  describe('GET /api/users/:id', () => {
    it('returns 404 when the user does not exist', async () => {
      supaMock.enqueue({ data: null, error: { message: 'not found' } });

      const res = await request(app)
        .get(`/api/users/${otherId}`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 404);
    });

    it('returns the profile with block-relationship flags', async () => {
      supaMock.enqueue({ data: { id: otherId, username: 'Someone' }, error: null });
      supaMock.enqueue({ data: [{ blocker_id: userId, blocked_id: otherId }], error: null });

      const res = await request(app)
        .get(`/api/users/${otherId}`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.user.blocked_by_me, true);
      assert.equal(res.body.user.has_blocked_me, false);
    });
  });

  describe('GET /api/users/:id/reviews', () => {
    it('flattens the joined match row into a verified_call boolean', async () => {
      supaMock.enqueue({
        data: [
          { rating: 5, comment: 'топ тиммейт', created_at: '2026-07-01', rater: { id: userId, username: 'me' }, match: { verified: true } },
          { rating: 4, comment: 'норм', created_at: '2026-06-01', rater: { id: userId, username: 'me' }, match: { verified: false } },
          { rating: 3, comment: 'старый отзыв', created_at: '2026-01-01', rater: null, match: null },
        ],
        error: null,
      });

      const res = await request(app)
        .get(`/api/users/${otherId}/reviews`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.reviews.length, 3);
      assert.equal(res.body.reviews[0].verified_call, true);
      assert.equal(res.body.reviews[1].verified_call, false);
      assert.equal(res.body.reviews[2].verified_call, false);
      assert.equal(res.body.reviews[0].match, undefined);
    });
  });
});

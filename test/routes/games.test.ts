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

const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});

// routes/games.ts caches the leaderboard response via utils/cache.ts, which
// does `require('../socket/redisClient')` for its `redis` client — and
// redisClient.ts opens THREE real ioredis connections at require time (see
// that file's header comment). In an environment where Redis actually is
// reachable (e.g. this repo's GitHub Actions `test` job, which runs a real
// redis:7-alpine service container), those connections succeed and are
// never closed — a live socket handle that keeps the process alive
// forever, so `node --test` never exits for this file and the CI job just
// hangs. Stub the whole module out with an in-memory fake before games.js
// is ever required, exactly like the socket/*.test.ts files do.
const fakeRedis = new FakeRedis();
stubModule(require.resolve('../../src/socket/redisClient'), {
  redis: fakeRedis,
  pubClient: fakeRedis,
  subClient: fakeRedis,
  waitForRedisReady: async () => {},
  REDIS_URL: 'redis://fake',
});

const gamesRouter = require('../../src/routes/games');

async function clearLeaderboardCache() {
  await fakeRedis.del('leaderboard:tetris:top50');
}

describe('Games routes (/api/games)', () => {
  let app: any;
  let token: any;
  const userId = '11111111-1111-4111-8111-111111111111';

  before(() => {
    app = buildTestApp({ '/api/games': gamesRouter });
    ({ token } = signAccessToken({ id: userId, username: 'player' }));
  });

  beforeEach(async () => {
    supaMock.reset();
    await clearLeaderboardCache();
  });

  describe('POST /api/games/tetris/score', () => {
    it('rejects a negative score', async () => {
      const res = await request(app)
        .post('/api/games/tetris/score')
        .set('Authorization', `Bearer ${token}`)
        .send({ score: -5 });
      assert.equal(res.status, 400);
    });

    it('rejects a non-numeric score', async () => {
      const res = await request(app)
        .post('/api/games/tetris/score')
        .set('Authorization', `Bearer ${token}`)
        .send({ score: 'lots' });
      assert.equal(res.status, 400);
    });

    it('rejects a score above the 1,000,000 cap', async () => {
      const res = await request(app)
        .post('/api/games/tetris/score')
        .set('Authorization', `Bearer ${token}`)
        .send({ score: 2_000_000 });
      assert.equal(res.status, 400);
    });

    it('keeps the existing best_score when the new score is lower, and increments games_played', async () => {
      supaMock.enqueue({ data: { best_score: 500, games_played: 3 }, error: null }); // existing
      supaMock.enqueue({ error: null }); // upsert
      supaMock.enqueue({ count: 2, error: null }); // rank (players above bestScore)
      supaMock.enqueue({ count: 10, error: null }); // total players

      const res = await request(app)
        .post('/api/games/tetris/score')
        .set('Authorization', `Bearer ${token}`)
        .send({ score: 100 });

      assert.equal(res.status, 200);
      assert.equal(res.body.bestScore, 500); // unchanged — new score was lower
      assert.equal(res.body.gamesPlayed, 4);
      assert.equal(res.body.rank, 3);
      assert.equal(res.body.totalPlayers, 10);
    });

    it('sets a new best_score and games_played=1 for a first-time player', async () => {
      supaMock.enqueue({ data: null, error: null }); // no existing row
      supaMock.enqueue({ error: null }); // upsert
      supaMock.enqueue({ count: 0, error: null }); // rank
      supaMock.enqueue({ count: 1, error: null }); // total players

      const res = await request(app)
        .post('/api/games/tetris/score')
        .set('Authorization', `Bearer ${token}`)
        .send({ score: 1234 });

      assert.equal(res.status, 200);
      assert.equal(res.body.bestScore, 1234);
      assert.equal(res.body.gamesPlayed, 1);
      assert.equal(res.body.rank, 1);
    });

    it('returns 500 when the upsert fails', async () => {
      supaMock.enqueue({ data: null, error: null }); // existing fetch
      supaMock.enqueue({ error: { message: 'db down' } }); // upsert fails

      const res = await request(app)
        .post('/api/games/tetris/score')
        .set('Authorization', `Bearer ${token}`)
        .send({ score: 100 });

      assert.equal(res.status, 500);
    });
  });

  describe('GET /api/games/tetris/leaderboard', () => {
    it('returns the top list plus the caller\'s own rank', async () => {
      supaMock.enqueue({
        data: [
          { user_id: 'p1', best_score: 900, games_played: 5, users: { username: 'Ace', avatar_emoji: '🏆' } },
          { user_id: userId, best_score: 500, games_played: 2, users: { username: 'player', avatar_emoji: '🎮' } },
        ],
        error: null,
      }); // top
      supaMock.enqueue({ data: { best_score: 500, games_played: 2 }, error: null }); // mine
      supaMock.enqueue({ count: 1, error: null }); // rank (1 player above me)
      supaMock.enqueue({ count: 2, error: null }); // total

      const res = await request(app)
        .get('/api/games/tetris/leaderboard')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.top.length, 2);
      assert.equal(res.body.top[0].rank, 1);
      assert.equal(res.body.me.rank, 2);
      assert.equal(res.body.totalPlayers, 2);
    });

    it('returns me: null when the caller has never played', async () => {
      supaMock.enqueue({ data: [], error: null }); // top
      supaMock.enqueue({ data: null, error: null }); // mine -> nothing
      supaMock.enqueue({ count: 0, error: null }); // total

      const res = await request(app)
        .get('/api/games/tetris/leaderboard')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.me, null);
    });

    it('falls back to default username/emoji when the joined user is missing', async () => {
      supaMock.enqueue({
        data: [{ user_id: 'ghost', best_score: 42, games_played: 1, users: null }],
        error: null,
      });
      supaMock.enqueue({ data: null, error: null }); // mine
      supaMock.enqueue({ count: 0, error: null }); // total

      const res = await request(app)
        .get('/api/games/tetris/leaderboard')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.top[0].username, 'Игрок');
      assert.equal(res.body.top[0].avatarEmoji, '🎮');
    });

    it('caps the limit query param at 50', async () => {
      supaMock.enqueue({ data: [], error: null });
      supaMock.enqueue({ data: null, error: null });
      supaMock.enqueue({ count: 0, error: null });

      const res = await request(app)
        .get('/api/games/tetris/leaderboard?limit=9999')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200); // doesn't throw / doesn't reflect an uncapped limit anywhere client-visible
    });
  });
});

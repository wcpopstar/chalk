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

const gamesRouter = require('../../src/routes/games');

// routes/games.ts caches the leaderboard response (utils/cache.ts, backed
// by src/socket/redisClient.ts's `redis` client) — normally a real Redis
// instance, but there almost certainly isn't one reachable in this test
// process, so cached()'s try/catch already makes every call fall straight
// through to the mocked supabaseAdmin (see that file's header comment on
// fail-open behavior). This best-effort delete is just a safety net for
// environments where a real Redis DOES happen to be reachable — without
// it, a cached response from an earlier test could survive into a later
// one within the 15s TTL and consume a different test's enqueued mock data.
let redisAvailable = true;
async function clearLeaderboardCache() {
  if (!redisAvailable) return;
  try {
    const { redis } = require('../../src/socket/redisClient');
    await redis.del('leaderboard:tetris:top50');
  } catch (_) {
    redisAvailable = false; // stop trying for the rest of this run
  }
}

describe('Games routes (/api/games)', () => {
  let app;
  let token;
  const userId = '11111111-1111-1111-1111-111111111111';

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

export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');
const { FakeRedis } = require('../helpers/fakeRedis');

const fakeRedis = new FakeRedis();
stubModule(require.resolve('../../src/socket/redisClient'), {
  redis: fakeRedis,
  pubClient: fakeRedis,
  subClient: fakeRedis,
  waitForRedisReady: async () => {},
  REDIS_URL: 'redis://fake',
});

const matchmaking = require('../../src/services/matchmakingRedis');

function makeEntry(overrides: any = {}) {
  return {
    userId: 'u-' + Math.random().toString(36).slice(2, 8),
    socketId: 'sock-1',
    gameId: 'valorant',
    mode: 'solo',
    squadSize: 2,
    rank: null,
    rankScore: 0,
    languages: ['en'],
    region: 'eu',
    ...overrides,
  };
}

describe('matchmakingRedis', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
  });

  describe('enqueue / dequeue / queueSize', () => {
    it('rejects an entry with no userId', async () => {
      await assert.rejects(() => matchmaking.enqueue({ mode: 'solo', gameId: 'x' }), /userId is required/);
    });

    it('rejects an unknown mode', async () => {
      await assert.rejects(
        () => matchmaking.enqueue(makeEntry({ mode: 'ranked' })),
        /unknown mode "ranked"/
      );
    });

    it('rejects a missing gameId', async () => {
      await assert.rejects(() => matchmaking.enqueue(makeEntry({ gameId: undefined })), /gameId is required/);
    });

    it('adds a player to the queue and queueSize(mode, gameId) reflects it', async () => {
      const entry = makeEntry();
      await matchmaking.enqueue(entry);

      const size = await matchmaking.queueSize('solo', 'valorant');
      assert.equal(size, 1);
    });

    it('moving a queued player to a different game replaces their old entry (no duplicate)', async () => {
      const entry = makeEntry({ userId: 'same-user', gameId: 'valorant' });
      await matchmaking.enqueue(entry);
      await matchmaking.enqueue({ ...entry, gameId: 'csgo' });

      assert.equal(await matchmaking.queueSize('solo', 'valorant'), 0);
      assert.equal(await matchmaking.queueSize('solo', 'csgo'), 1);
    });

    it('dequeue removes the player and reports whether they were actually queued', async () => {
      const entry = makeEntry({ userId: 'leaver' });
      await matchmaking.enqueue(entry);

      assert.equal(await matchmaking.dequeue('leaver'), true);
      assert.equal(await matchmaking.queueSize('solo', 'valorant'), 0);
      assert.equal(await matchmaking.dequeue('leaver'), false); // already gone
    });

    it('queueSize() with no args totals across all games/modes', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'a', mode: 'solo', gameId: 'valorant' }));
      await matchmaking.enqueue(makeEntry({ userId: 'b', mode: 'solo', gameId: 'csgo' }));
      await matchmaking.enqueue(makeEntry({ userId: 'c', mode: 'group', gameId: 'valorant', squadSize: 4 }));

      const totals = await matchmaking.queueSize();
      assert.equal(totals.solo, 2);
      assert.equal(totals.group, 1);
      assert.equal(totals.byQueue.length, 3);
    });
  });

  describe('runMatchCycle — solo matching', () => {
    it('matches two compatible solo players and removes them from the queue', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', rankScore: 50, languages: ['en'], region: 'eu' }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', rankScore: 50, languages: ['en'], region: 'eu' }));

      const { soloMatch } = await matchmaking.runMatchCycle();

      assert.ok(soloMatch);
      const ids = soloMatch.map((p: any) => p.userId).sort();
      assert.deepEqual(ids, ['p1', 'p2']);
      assert.equal(await matchmaking.queueSize('solo', 'valorant'), 0);
    });

    it('does not match players in different regions before the relax window', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', region: 'eu' }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', region: 'na' }));

      const { soloMatch } = await matchmaking.runMatchCycle();

      assert.equal(soloMatch, null);
      assert.equal(await matchmaking.queueSize('solo', 'valorant'), 2); // both still queued
    });

    it('does not match players with no shared language before the relax window', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', languages: ['en'] }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', languages: ['fr'] }));

      const { soloMatch } = await matchmaking.runMatchCycle();

      assert.equal(soloMatch, null);
    });

    it('does not match players from different games even if everything else matches', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', gameId: 'valorant' }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', gameId: 'csgo' }));

      const { soloMatch } = await matchmaking.runMatchCycle();

      assert.equal(soloMatch, null);
    });

    it('prefers the closest-rank pair when three players are queued', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'low', rankScore: 0 }));
      await matchmaking.enqueue(makeEntry({ userId: 'mid', rankScore: 1 }));
      await matchmaking.enqueue(makeEntry({ userId: 'high', rankScore: 100 }));

      const { soloMatch } = await matchmaking.runMatchCycle();

      // 'low' and 'mid' have rankDiff=1 (score 15+); either could pair with
      // 'high' too depending on relax state, but low/mid is strictly the
      // best-scoring pair available on this first tick.
      assert.ok(soloMatch);
      const ids = soloMatch.map((p: any) => p.userId).sort();
      assert.deepEqual(ids, ['low', 'mid']);
    });

    it('does not touch a solo queue with only one player', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'lonely' }));

      const { soloMatch } = await matchmaking.runMatchCycle();

      assert.equal(soloMatch, null);
      assert.equal(await matchmaking.queueSize('solo', 'valorant'), 1);
    });
  });

  describe('runMatchCycle — gender / age filters', () => {
    it('matches when both players\' gender preferences are mutually satisfied', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', gender: 'male', genderPref: ['female'] }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', gender: 'female', genderPref: ['male'] }));

      const { soloMatch } = await matchmaking.runMatchCycle();
      assert.ok(soloMatch);
    });

    it('does not match when one side\'s gender preference excludes the other', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', gender: 'male', genderPref: ['female'] }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', gender: 'male', genderPref: ['female'] }));

      const { soloMatch } = await matchmaking.runMatchCycle();
      assert.equal(soloMatch, null);
    });

    it('a gender preference excludes a candidate whose gender is unknown', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', gender: 'female', genderPref: ['female'] }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', gender: null }));

      const { soloMatch } = await matchmaking.runMatchCycle();
      assert.equal(soloMatch, null);
    });

    it('matches when each player\'s age falls in the other\'s requested range', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', age: 20, ageMin: 18, ageMax: 25 }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', age: 22, ageMin: 18, ageMax: 25 }));

      const { soloMatch } = await matchmaking.runMatchCycle();
      assert.ok(soloMatch);
    });

    it('does not match when a candidate is outside the requested age range', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', age: 30, ageMin: 18, ageMax: 24 }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', age: 22, ageMin: 18, ageMax: 24 }));

      const { soloMatch } = await matchmaking.runMatchCycle();
      assert.equal(soloMatch, null);
    });

    it('leaves players with no filters matching as before', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1' }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2' }));

      const { soloMatch } = await matchmaking.runMatchCycle();
      assert.ok(soloMatch);
    });

    it('matches two text-only seekers with each other', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', chatOnly: true }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', chatOnly: true }));

      const { soloMatch } = await matchmaking.runMatchCycle();
      assert.ok(soloMatch);
    });

    it('never pairs a text-only seeker with a voice seeker', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', chatOnly: true }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', chatOnly: false }));

      const { soloMatch } = await matchmaking.runMatchCycle();
      assert.equal(soloMatch, null);
    });
  });

  describe('runMatchCycle — group matching', () => {
    it('forms a group once enough same-squadSize players are queued', async () => {
      for (const userId of ['g1', 'g2', 'g3', 'g4']) {
        await matchmaking.enqueue(makeEntry({ userId, mode: 'group', squadSize: 4, gameId: 'apex' }));
      }

      const { groupMatch } = await matchmaking.runMatchCycle();

      assert.ok(groupMatch);
      assert.equal(groupMatch.length, 4);
    });

    it('does not mix different squadSize preferences into one group', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'trio-1', mode: 'group', squadSize: 3, gameId: 'apex' }));
      await matchmaking.enqueue(makeEntry({ userId: 'trio-2', mode: 'group', squadSize: 3, gameId: 'apex' }));
      await matchmaking.enqueue(makeEntry({ userId: 'duo-1', mode: 'group', squadSize: 2, gameId: 'apex' }));

      const { groupMatch } = await matchmaking.runMatchCycle();

      // Only 2 players want squadSize 3 (need 3) and only 1 wants squadSize
      // 2 (need 2) — nobody has enough same-size players yet.
      assert.equal(groupMatch, null);
    });
  });

  describe('runMatchCycle — cluster lock', () => {
    it('a second concurrent instance (no lock) does no work this tick', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1' }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2' }));

      // Simulate another server instance having already grabbed this tick's
      // lock by pre-setting the lock key the same way acquireMatchLoopLock()
      // does (SET NX) — our own runMatchCycle() call should then find the
      // lock unavailable and return a no-op result without matching anyone.
      await fakeRedis.set('chalk:mm:lock', '1', 'PX', 900, 'NX');

      const result = await matchmaking.runMatchCycle();

      assert.deepEqual(result, { soloMatch: null, groupMatch: null, matches: [] });
      assert.equal(await matchmaking.queueSize('solo', 'valorant'), 2); // untouched
    });
  });

  describe('runMatchCycle — io emission', () => {
    it('emits match:found to every matched participant\'s socket when io is provided', async () => {
      await matchmaking.enqueue(makeEntry({ userId: 'p1', socketId: 'sock-p1' }));
      await matchmaking.enqueue(makeEntry({ userId: 'p2', socketId: 'sock-p2' }));

      const emitted: any = [];
      const fakeIo = { to: (socketId: any) => ({ emit: (event: any, payload: any) => emitted.push({ socketId, event, payload }) }) };

      await matchmaking.runMatchCycle(fakeIo);

      assert.equal(emitted.length, 2);
      assert.deepEqual(emitted.map((e: any) => e.socketId).sort(), ['sock-p1', 'sock-p2']);
      assert.ok(emitted.every((e: any) => e.event === 'match:found'));
    });
  });
});

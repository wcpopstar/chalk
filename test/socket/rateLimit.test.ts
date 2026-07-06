export {};
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

const {
  isFlooding, isFloodingUser, isFloodingGlobal, clearRateLimitsFor,
  checkConnectionBudget, checkNamedLimit,
} = require('../../src/socket/rateLimit');

// NOTE: this rate limiter is Redis-backed and every check here is async —
// see src/socket/rateLimiter.ts's header comment for why (horizontal
// scaling: limits must be shared across server instances, not held in an
// in-process Map). clearRateLimitsFor() is consequently a no-op now (Redis
// TTLs expire keys on their own); it's still exported/called from
// socket/index.ts on disconnect purely for interface stability, and the
// test below for it reflects that new reality instead of the old
// in-memory-Map behavior.
describe('socket/rateLimit.ts', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
  });

  describe('isFlooding (per-socket, per-event)', () => {
    it('allows requests under the limit and blocks once max is exceeded', async () => {
      const socket = { id: 'sock-' + Math.random() };
      const key = 'chat:message';

      for (let i = 0; i < 3; i++) {
        assert.equal(await isFlooding(socket, key, 10_000, 3), false, `request ${i + 1} should be allowed`);
      }
      // The 4th call in the same window is the first one over the limit.
      assert.equal(await isFlooding(socket, key, 10_000, 3), true);
    });

    it('tracks different event keys on the same socket independently', async () => {
      const socket = { id: 'sock-' + Math.random() };

      assert.equal(await isFlooding(socket, 'event:a', 10_000, 1), false);
      assert.equal(await isFlooding(socket, 'event:a', 10_000, 1), true); // event:a now over
      assert.equal(await isFlooding(socket, 'event:b', 10_000, 1), false); // event:b unaffected
    });

    it('resets once the window elapses', async (t: any) => {
      t.mock.timers.enable({ apis: ['Date'] });
      const socket = { id: 'sock-window' };

      assert.equal(await isFlooding(socket, 'k', 1000, 1), false);
      assert.equal(await isFlooding(socket, 'k', 1000, 1), true);

      t.mock.timers.tick(1001);
      assert.equal(await isFlooding(socket, 'k', 1000, 1), false); // window reset
    });
  });

  describe('isFloodingUser (survives "reconnects" — keyed by userId, not socket.id)', () => {
    it('keeps counting across what would be a new socket connection', async () => {
      const userId = 'user-' + Math.random();

      assert.equal(await isFloodingUser(userId, 'match:join', 10_000, 2), false);
      assert.equal(await isFloodingUser(userId, 'match:join', 10_000, 2), false);
      // 3rd call (as if from a freshly-reconnected socket) is still over the
      // SAME limit, because the bucket is keyed by userId only.
      assert.equal(await isFloodingUser(userId, 'match:join', 10_000, 2), true);
    });
  });

  describe('isFloodingGlobal (cross-event budget per user)', () => {
    it("is independent of any single event's own limit", async () => {
      const userId = 'user-' + Math.random();

      // Well under any individual event's limit, but this exercises the
      // shared __global__ bucket directly (120/10s — see rateLimit.ts's
      // GLOBAL_EVENT_BUDGET).
      for (let i = 0; i < 120; i++) {
        assert.equal(await isFloodingGlobal(userId), false, `global call ${i + 1} should be allowed`);
      }
      assert.equal(await isFloodingGlobal(userId), true); // 121st call this window
    });

    it('does not let event-hopping dodge the global budget', async () => {
      // Simulates round-robining between two different event *names* — the
      // per-event limiter would let this through all day since each event
      // individually stays under ITS OWN limit, but the caller is still
      // making 121 socket calls into this same 10s window overall.
      const userId = 'hopper-' + Math.random();
      let blocked = false;
      for (let i = 0; i < 130; i++) {
        const key = i % 2 === 0 ? 'chat:message' : 'chat:gif';
        if ((await isFlooding({ id: 'sock-hopper' }, key, 10_000, 1000)) || (await isFloodingGlobal(userId))) {
          blocked = true;
          break;
        }
      }
      assert.equal(blocked, true);
    });
  });

  describe('clearRateLimitsFor', () => {
    it('is a no-op — Redis-backed buckets expire on their own via TTL', () => {
      // Kept exported/callable (socket/index.ts still calls it on
      // disconnect) purely for interface stability across the Redis
      // migration; it does nothing now, and doing nothing here must not
      // throw.
      assert.doesNotThrow(() => clearRateLimitsFor({ id: 'sock-noop' }));
    });
  });

  describe('checkConnectionBudget (hard, per-connection)', () => {
    it('allows events under the connection budget and blocks once exceeded', async () => {
      const socket = { id: 'conn-' + Math.random() };
      const max = require('../../src/socket/rateLimit').CONNECTION_BUDGET.max;

      for (let i = 0; i < max; i++) {
        const res = await checkConnectionBudget(socket);
        assert.equal(res.allowed, true, `event ${i + 1} should be allowed`);
      }
      const res = await checkConnectionBudget(socket);
      assert.equal(res.allowed, false);
    });

    it('warns once approaching 80% of the budget, not on every event past it', async () => {
      const socket = { id: 'conn-warn-' + Math.random() };
      const max = require('../../src/socket/rateLimit').CONNECTION_BUDGET.max;
      const warnThreshold = Math.ceil(max * 0.8);

      let warnings = 0;
      for (let i = 0; i < max; i++) {
        const res = await checkConnectionBudget(socket);
        if (res.warn) warnings++;
      }
      assert.equal(warnings, 1, 'warning should fire exactly once, not once per event past the threshold');
      assert.ok(warnThreshold <= max);
    });
  });

  describe('checkNamedLimit (hard, per-user-per-event-family)', () => {
    it('returns null for events with no named hard limit', async () => {
      const res = await checkNamedLimit('user-' + Math.random(), 'chat:gif');
      assert.equal(res, null);
    });

    it('enforces the match:join limit and blocks once exceeded', async () => {
      const userId = 'user-' + Math.random();
      const max = require('../../src/socket/rateLimit').NAMED_LIMITS['match:join'].max;

      for (let i = 0; i < max; i++) {
        const res = await checkNamedLimit(userId, 'match:join');
        assert.equal(res.allowed, true);
        assert.equal(res.limitKey, 'match:join');
      }
      const res = await checkNamedLimit(userId, 'match:join');
      assert.equal(res.allowed, false);
    });

    it('groups every call:* event under the single shared "signal" bucket', async () => {
      const userId = 'user-' + Math.random();
      const max = require('../../src/socket/rateLimit').NAMED_LIMITS.signal.max;

      // Alternate between two different call:* event names — they must
      // share ONE budget, not get one each, since the spec treats all of
      // call:* as this app's signal:* equivalent (see rateLimit.ts).
      let blockedAt = -1;
      for (let i = 0; i < max + 1; i++) {
        const eventName = i % 2 === 0 ? 'call:invite' : 'call:accept';
        const res = await checkNamedLimit(userId, eventName);
        assert.equal(res.limitKey, 'signal');
        if (!res.allowed) { blockedAt = i; break; }
      }
      assert.equal(blockedAt, max, 'should block exactly on the (max+1)th combined call:* event');
    });

    it('recognizes a literal signal:* event name too, under the same bucket', async () => {
      const userId = 'user-' + Math.random();
      // Uses up the whole signal budget via call:* first...
      const max = require('../../src/socket/rateLimit').NAMED_LIMITS.signal.max;
      for (let i = 0; i < max; i++) await checkNamedLimit(userId, 'call:reject');
      // ...then confirms a differently-named signal:* event is blocked by
      // that SAME already-exhausted bucket, not given a fresh one.
      const res = await checkNamedLimit(userId, 'signal:offer');
      assert.equal(res.limitKey, 'signal');
      assert.equal(res.allowed, false);
    });
  });
});

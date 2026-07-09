export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');

// worker.ts is an entrypoint: requiring it starts workers and registers
// SIGTERM/SIGINT handlers that end in process.exit(). Stub every side
// effect so the whole lifecycle — boot, idempotent-shutdown guard, drain
// order — can run inside the test process without killing it.
const calls: string[] = [];
stubModule(require.resolve('../../src/workers'), {
  startWorkers: () => { calls.push('startWorkers'); return []; },
  closeWorkers: async () => { calls.push('closeWorkers'); },
});
stubModule(require.resolve('../../src/queues'), {
  closeQueues: async () => { calls.push('closeQueues'); },
  enqueuePasswordResetEmail: async () => {},
});
stubModule(require.resolve('../../src/socket/redisClient'), {
  redis: { quit: async () => { calls.push('redis.quit'); } },
  waitForRedisReady: async () => { calls.push('waitForRedisReady'); },
  REDIS_URL: 'redis://fake',
});

describe('src/worker.ts (standalone worker entrypoint)', () => {
  const realExit = process.exit;
  let exitCode: any = null;
  let sigtermHandler: any;

  before(async () => {
    (process as any).exit = (code: any) => { exitCode = code; };

    const listenersBefore = process.listeners('SIGTERM').length;
    require('../../src/worker');
    // Grab exactly the handler worker.ts just registered — calling it
    // directly avoids re-emitting SIGTERM at the test runner itself.
    sigtermHandler = process.listeners('SIGTERM')[listenersBefore];

    await new Promise((r) => setImmediate(r)); // let waitForRedisReady().then() run
  });

  after(() => {
    (process as any).exit = realExit;
  });

  it('boots: waits for Redis, then starts the workers', () => {
    assert.deepEqual(calls.slice(0, 2), ['waitForRedisReady', 'startWorkers']);
  });

  it('drains on SIGTERM in order (workers -> queues -> redis) and exits 0', async () => {
    await sigtermHandler();
    // shutdown() is async fire-and-forget from the signal handler's point
    // of view — give its await chain a beat to finish.
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(calls.slice(2), ['closeWorkers', 'closeQueues', 'redis.quit']);
    assert.equal(exitCode, 0);
  });

  it('ignores a second signal mid-drain (idempotent shutdown)', async () => {
    const callCount = calls.length;
    await sigtermHandler();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, callCount); // no double drain
  });
});

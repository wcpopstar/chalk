export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');

// The service reuses the BullMQ Redis connection — swap it for an
// in-memory hash so no test ever touches a real Redis.
const hash: Record<string, string> = {};
let hgetallError: any = null;
const fakeQueueRedis = {
  hgetall: async (_key: any) => {
    if (hgetallError) throw hgetallError;
    return { ...hash };
  },
  hset: async (_key: any, field: any, value: any) => { hash[field] = value; },
  hdel: async (_key: any, field: any) => { delete hash[field]; },
};
stubModule(require.resolve('../../src/queues/connection'), { queueConnection: fakeQueueRedis });

const flags = require('../../src/services/featureFlags');

// The service memoizes Redis reads for 15s; every test starts from a cold
// cache by setting an override (setOverride resets the cache as a side
// effect) or via this helper that abuses the same mechanism.
async function bustCache() {
  await flags.setOverride('discovery.enabled', null);
}

describe('feature flags service', () => {
  beforeEach(async () => {
    for (const k of Object.keys(hash)) delete hash[k];
    hgetallError = null;
    delete process.env.FEATURE_DISCOVERY_ENABLED;
    await bustCache();
  });

  it('falls back to the registry default when nothing overrides a flag', async () => {
    assert.equal(await flags.isEnabled('discovery.enabled'), true);
  });

  it('returns false (and does not throw) for an unregistered key', async () => {
    assert.equal(await flags.isEnabled('nope.not.a.flag'), false);
  });

  it('env var overrides the default', async () => {
    process.env.FEATURE_DISCOVERY_ENABLED = 'false';
    assert.equal(await flags.isEnabled('discovery.enabled'), false);

    process.env.FEATURE_DISCOVERY_ENABLED = '1';
    assert.equal(await flags.isEnabled('discovery.enabled'), true);
  });

  it('a Redis enabled-override beats the env var and the default', async () => {
    process.env.FEATURE_DISCOVERY_ENABLED = 'true';
    await flags.setOverride('discovery.enabled', { enabled: false });
    assert.equal(await flags.isEnabled('discovery.enabled'), false);
  });

  it('setOverride(null) clears the override, falling back to env/default', async () => {
    await flags.setOverride('discovery.enabled', { enabled: false });
    assert.equal(await flags.isEnabled('discovery.enabled'), false);

    await flags.setOverride('discovery.enabled', null);
    assert.equal(await flags.isEnabled('discovery.enabled'), true);
  });

  it('setOverride rejects an unregistered key', async () => {
    await assert.rejects(() => flags.setOverride('nope.not.a.flag', { enabled: true }), /Unknown feature flag/);
  });

  it('rolloutPercent buckets a user deterministically', async () => {
    await flags.setOverride('discovery.enabled', { enabled: true, rolloutPercent: 50 });

    const first = await flags.isEnabled('discovery.enabled', { userId: 'user-a' });
    for (let i = 0; i < 5; i++) {
      assert.equal(await flags.isEnabled('discovery.enabled', { userId: 'user-a' }), first);
    }

    // 0% -> nobody; 100% -> everybody (bucket is 0-99, strictly < percent).
    await flags.setOverride('discovery.enabled', { enabled: true, rolloutPercent: 0 });
    assert.equal(await flags.isEnabled('discovery.enabled', { userId: 'user-a' }), false);

    await flags.setOverride('discovery.enabled', { enabled: true, rolloutPercent: 100 });
    assert.equal(await flags.isEnabled('discovery.enabled', { userId: 'user-a' }), true);
  });

  it('rolloutPercent without user context falls back to the plain enabled bit', async () => {
    await flags.setOverride('discovery.enabled', { enabled: false, rolloutPercent: 100 });
    assert.equal(await flags.isEnabled('discovery.enabled'), false);
  });

  it('ignores a corrupted JSON field instead of failing every flag', async () => {
    hash['discovery.enabled'] = 'not json {{{';
    await flags.setOverride('games.tetris.enabled', null); // bust cache without touching the corrupt field
    hash['discovery.enabled'] = 'not json {{{';
    assert.equal(await flags.isEnabled('discovery.enabled'), true); // default survives
  });

  it('falls back to env/defaults when Redis is unavailable', async () => {
    hgetallError = new Error('redis down');
    // Cache is already cold from beforeEach's bustCache; the next read fails.
    assert.equal(await flags.isEnabled('discovery.enabled'), true);
    hgetallError = null;
  });

  it('listFlags returns every registered flag with resolved state', async () => {
    await flags.setOverride('games.tetris.enabled', { enabled: false });

    const list = await flags.listFlags({ userId: 'user-a' });
    assert.equal(list.length, Object.keys(flags.REGISTRY).length);

    const tetris = list.find((f: any) => f.key === 'games.tetris.enabled');
    assert.equal(tetris.enabled, false);
    assert.deepEqual(tetris.override, { enabled: false });
    assert.ok(tetris.description);
  });
});

export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const tokenBlacklist = require('../../src/services/tokenBlacklist');

// Under NODE_ENV=test the module deliberately creates no Redis client —
// the Redis-tier tests below inject a fake one directly and restore null
// afterwards, exercising the real two-tier read/write logic without a
// network socket.
function makeFakeRedis() {
  const kv = new Map<string, string>();
  const fake: any = {
    status: 'ready',
    kv,
    setCalls: [] as any[],
    connectCalls: 0,
    failNext: null as any,
    async set(key: string, value: string, px: string, ttl: number) {
      if (fake.failNext) { const e = fake.failNext; fake.failNext = null; throw e; }
      fake.setCalls.push({ key, value, px, ttl });
      kv.set(key, value);
      return 'OK';
    },
    async exists(key: string) {
      if (fake.failNext) { const e = fake.failNext; fake.failNext = null; throw e; }
      return kv.has(key) ? 1 : 0;
    },
    connect() { fake.connectCalls += 1; fake.status = 'ready'; return Promise.resolve(); },
    on() { return fake; },
  };
  return fake;
}

describe('tokenBlacklist', () => {
  beforeEach(() => {
    tokenBlacklist.store.clear();
  });

  afterEach(() => {
    tokenBlacklist._redis = null; // back to the test-env default
  });

  describe('in-memory tier', () => {
    it('isRevoked is false for an unknown jti and for a missing jti', async () => {
      assert.equal(await tokenBlacklist.isRevoked('never-revoked'), false);
      assert.equal(await tokenBlacklist.isRevoked(undefined), false);
    });

    it('revoke() makes isRevoked true until the entry is swept after expiry', async () => {
      tokenBlacklist.revoke('jti-1', Date.now() + 60_000); // still valid
      tokenBlacklist.revoke('jti-2', Date.now() - 1);      // already past JWT expiry

      assert.equal(await tokenBlacklist.isRevoked('jti-1'), true);
      assert.equal(await tokenBlacklist.isRevoked('jti-2'), true); // not swept yet

      tokenBlacklist._sweep();
      assert.equal(await tokenBlacklist.isRevoked('jti-1'), true);
      assert.equal(await tokenBlacklist.isRevoked('jti-2'), false); // swept
    });

    it('revoke() ignores a missing jti and defaults a bogus expiry to ~15min', async () => {
      tokenBlacklist.revoke(undefined, 123);
      assert.equal(tokenBlacklist.store.size, 0);

      tokenBlacklist.revoke('jti-nan', NaN);
      const ttl = tokenBlacklist.store.get('jti-nan');
      assert.ok(ttl > Date.now() && ttl <= Date.now() + 15 * 60 * 1000);
    });
  });

  describe('Redis tier', () => {
    it('revoke() writes the jti to Redis with a PX ttl', async () => {
      const fake = makeFakeRedis();
      tokenBlacklist._redis = fake;

      tokenBlacklist.revoke('jti-r1', Date.now() + 30_000);
      await new Promise((r) => setImmediate(r)); // let the fire-and-forget settle

      assert.equal(fake.setCalls.length, 1);
      assert.equal(fake.setCalls[0].key, 'chalk:revoked-jti:jti-r1');
      assert.equal(fake.setCalls[0].px, 'PX');
      assert.ok(fake.setCalls[0].ttl > 0 && fake.setCalls[0].ttl <= 30_000);
    });

    it('isRevoked falls through to Redis on a local miss (cross-instance case)', async () => {
      const fake = makeFakeRedis();
      fake.kv.set('chalk:revoked-jti:revoked-elsewhere', '1');
      tokenBlacklist._redis = fake;

      assert.equal(await tokenBlacklist.isRevoked('revoked-elsewhere'), true);
      assert.equal(await tokenBlacklist.isRevoked('not-revoked-anywhere'), false);
    });

    it('local map wins without asking Redis', async () => {
      const fake = makeFakeRedis();
      fake.exists = async () => { throw new Error('should not be called'); };
      tokenBlacklist._redis = fake;

      tokenBlacklist.revoke('jti-local', Date.now() + 30_000);
      assert.equal(await tokenBlacklist.isRevoked('jti-local'), true);
    });

    it('fails OPEN when Redis errors on read', async () => {
      const fake = makeFakeRedis();
      fake.failNext = new Error('redis down');
      tokenBlacklist._redis = fake;

      assert.equal(await tokenBlacklist.isRevoked('whatever'), false);
    });

    it('fails open (local map still enforced) when Redis errors on write', async () => {
      const fake = makeFakeRedis();
      fake.failNext = new Error('redis down');
      tokenBlacklist._redis = fake;

      tokenBlacklist.revoke('jti-w', Date.now() + 30_000);
      await new Promise((r) => setImmediate(r));
      assert.equal(await tokenBlacklist.isRevoked('jti-w'), true); // via local map
    });

    it('fails open while the lazy connection is still being established', async () => {
      const fake = makeFakeRedis();
      fake.status = 'wait';
      fake.connect = () => { fake.connectCalls += 1; return Promise.resolve(); }; // stays 'wait' this tick
      tokenBlacklist._redis = fake;

      assert.equal(await tokenBlacklist.isRevoked('anything'), false);
      assert.equal(fake.connectCalls, 1); // isRevoked kicked off the lazy connect
    });
  });
});

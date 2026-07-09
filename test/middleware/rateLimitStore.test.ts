export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { RedisFixedWindowStore, createRateLimitStore } = require('../../src/middleware/rateLimit');

// Mimics exactly the slice of ioredis the store uses: MULTI(incr, pttl),
// pexpire, decr, del — over a plain in-memory map with millisecond TTLs.
function makeFakeRedis() {
  const counters = new Map<string, { hits: number; expiresAt: number | null }>();
  const fake: any = {
    status: 'ready',
    counters,
    failNext: null as any,
    multi() {
      const ops: any[] = [];
      const chain: any = {
        incr(key: string) { ops.push(['incr', key]); return chain; },
        pttl(key: string) { ops.push(['pttl', key]); return chain; },
        async exec() {
          if (fake.failNext) { const e = fake.failNext; fake.failNext = null; throw e; }
          return ops.map(([op, key]) => {
            const entry = counters.get(key) || { hits: 0, expiresAt: null };
            if (op === 'incr') {
              entry.hits += 1;
              counters.set(key, entry);
              return [null, entry.hits];
            }
            // pttl: -2 missing / -1 no TTL / remaining ms otherwise
            if (!counters.has(key)) return [null, -2];
            if (entry.expiresAt === null) return [null, -1];
            return [null, Math.max(entry.expiresAt - Date.now(), 0)];
          });
        },
      };
      return chain;
    },
    async pexpire(key: string, ms: number) {
      const entry = counters.get(key);
      if (entry) entry.expiresAt = Date.now() + ms;
    },
    async decr(key: string) {
      const entry = counters.get(key);
      if (entry) entry.hits -= 1;
    },
    async del(key: string) { counters.delete(key); },
    connect() { return Promise.resolve(); },
    on() { return fake; },
  };
  return fake;
}

describe('RedisFixedWindowStore (HTTP rate limiter backend)', () => {
  let fake: any;
  let store: any;

  beforeEach(() => {
    fake = makeFakeRedis();
    store = new RedisFixedWindowStore(fake);
    store.init({ windowMs: 60_000 });
  });

  it('counts hits per key and arms the window TTL exactly once', async () => {
    const first = await store.increment('u:1');
    assert.equal(first.totalHits, 1);
    assert.ok(first.resetTime instanceof Date);

    const second = await store.increment('u:1');
    assert.equal(second.totalHits, 2);

    const entry = fake.counters.get(`${store.prefix}u:1`);
    assert.ok(entry.expiresAt, 'TTL must be set on the counter key');
  });

  it('isolates keys between different stores (per-limiter namespaces)', async () => {
    const other = new RedisFixedWindowStore(fake);
    other.init({ windowMs: 60_000 });

    await store.increment('u:1');
    const otherResult = await other.increment('u:1');

    assert.equal(otherResult.totalHits, 1); // not 2 — separate prefix
    assert.notEqual(store.prefix, other.prefix);
  });

  it('re-arms a TTL-less key so it can never block forever', async () => {
    await store.increment('u:1');
    const key = `${store.prefix}u:1`;
    fake.counters.get(key).expiresAt = null; // simulate a lost TTL

    await store.increment('u:1');
    assert.ok(fake.counters.get(key).expiresAt, 'TTL must be re-armed');
  });

  it('fails OPEN when Redis errors (totalHits: 1, request allowed)', async () => {
    fake.failNext = new Error('redis down');
    const result = await store.increment('u:1');
    assert.equal(result.totalHits, 1);
  });

  it('fails OPEN while the connection is not ready', async () => {
    fake.status = 'connecting';
    const result = await store.increment('u:1');
    assert.equal(result.totalHits, 1);
  });

  it('fails OPEN with no client at all (test env default)', async () => {
    const clientless = new RedisFixedWindowStore(null);
    clientless.init({ windowMs: 60_000 });
    const result = await clientless.increment('u:1');
    assert.equal(result.totalHits, 1);
  });

  it('decrement and resetKey adjust the counter and never throw', async () => {
    await store.increment('u:1');
    await store.increment('u:1');

    await store.decrement('u:1');
    assert.equal(fake.counters.get(`${store.prefix}u:1`).hits, 1);

    await store.resetKey('u:1');
    assert.ok(!fake.counters.has(`${store.prefix}u:1`));

    fake.failNext = new Error('redis down');
    await store.decrement('u:1'); // must not throw
  });

  it('createRateLimitStore returns undefined under NODE_ENV=test (memory fallback)', () => {
    assert.equal(createRateLimitStore(), undefined);
  });
});

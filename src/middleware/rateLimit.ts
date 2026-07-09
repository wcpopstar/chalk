import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import loggerBase from '../utils/logger';
import { config } from '../config/env';
const logger = loggerBase.child({ module: 'http-rate-limit' });

/**
 * HTTP rate limiting, Redis-backed.
 *
 * express-rate-limit's default MemoryStore counts per process — behind a
 * load balancer every instance would hand out its own full budget, so N
 * instances silently multiply every limit by N. The store below keeps the
 * counters in Redis (plain fixed-window INCR + PEXPIRE — the socket layer's
 * sliding-window Lua limiter in socket/rateLimiter.ts stays as is; HTTP
 * budgets here are coarse enough that fixed windows are fine).
 *
 * Fails OPEN on any Redis problem (same philosophy as socket/rateLimiter.ts
 * and services/tokenBlacklist.ts): a Redis blip must degrade to "no rate
 * limiting for a moment", never to "every API request 500s".
 *
 * In tests (NODE_ENV=test) the Redis store is disabled entirely and
 * express-rate-limit falls back to its in-memory store, so requiring any
 * router never opens a network socket — same rule as tokenBlacklist.
 */

let redisClient: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  if (config.server.nodeEnv === 'test') {
    redisClient = null;
    return redisClient;
  }
  redisClient = new Redis(config.redis.url, {
    lazyConnect: true,           // require()-ing a router must not open a socket
    enableOfflineQueue: false,   // don't queue commands while down — fail open instead
    maxRetriesPerRequest: 1,     // a rate-limit check must never stall a request
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });
  redisClient.on('error', (err: any) => logRedisError(err));
  return redisClient;
}

// One log line per 30s outage, not one per throttled request.
let redisErrorLoggedRecently = false;
function logRedisError(err: any) {
  if (redisErrorLoggedRecently) return;
  redisErrorLoggedRecently = true;
  logger.error({ err }, 'HTTP rate limiter Redis unavailable — failing open (no HTTP rate limiting) until it recovers');
  setTimeout(() => { redisErrorLoggedRecently = false; }, 30_000).unref?.();
}

// Each limiter (auth, per-route userLimiter, the global one in index.ts)
// gets its own store instance and therefore its own key namespace. The
// counter is deterministic across instances because every instance
// require()s the same modules in the same order.
let storeCounter = 0;

class RedisFixedWindowStore {
  prefix: string;
  windowMs = 60_000;
  _redis: Redis | null;

  // `client` is injectable for tests; production callers pass nothing and
  // share the lazy module-level connection.
  constructor(client?: Redis | null) {
    this.prefix = `chalk:httprl:${storeCounter++}:`;
    this._redis = client === undefined ? getRedis() : client;
  }

  init(options: { windowMs: number }) {
    this.windowMs = options.windowMs;
  }

  _failOpen() {
    return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
  }

  async increment(key: string) {
    const r = this._redis;
    if (!r) return this._failOpen();

    try {
      if (r.status === 'wait') r.connect().catch((err: any) => logRedisError(err));
      if (r.status !== 'ready') return this._failOpen();

      const k = this.prefix + key;
      const results = await r.multi().incr(k).pttl(k).exec();
      if (!results) return this._failOpen();
      const [[incrErr, totalHits], [pttlErr, pttl]] = results as any;
      if (incrErr || pttlErr) throw incrErr || pttlErr;

      // Fresh key (or a key that lost its TTL, e.g. a crash between INCR
      // and PEXPIRE) — (re)arm the window so it can never block forever.
      if (pttl < 0) await r.pexpire(k, this.windowMs);

      return {
        totalHits: Number(totalHits),
        resetTime: new Date(Date.now() + (pttl > 0 ? Number(pttl) : this.windowMs)),
      };
    } catch (err: any) {
      logRedisError(err);
      return this._failOpen();
    }
  }

  async decrement(key: string) {
    const r = this._redis;
    if (!r || r.status !== 'ready') return;
    try {
      await r.decr(this.prefix + key);
    } catch (err: any) {
      logRedisError(err);
    }
  }

  async resetKey(key: string) {
    const r = this._redis;
    if (!r || r.status !== 'ready') return;
    try {
      await r.del(this.prefix + key);
    } catch (err: any) {
      logRedisError(err);
    }
  }
}

// undefined in tests -> express-rate-limit uses its in-memory default.
function createRateLimitStore() {
  return config.server.nodeEnv === 'test' ? undefined : new RedisFixedWindowStore();
}

/**
 * Rate limiter keyed by authenticated user id when available, falling back
 * to IP for anonymous requests. This is what we want for buttons a logged-in
 * person could mash (add friend, block, report, create group, ...): it
 * throttles per-account instead of per-IP, so it can't be dodged by people
 * sharing a NAT/office IP, and it can't be used to lock other users out.
 *
 * requireAuth() must run BEFORE this middleware on the route so req.user is set.
 */
function userLimiter({ windowMs, max, message }: any) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitStore(),
    keyGenerator: (req: any) => (req.user && req.user.id) ? `u:${req.user.id}` : req.ip,
    message: { error: message || 'Слишком много запросов, попробуй немного позже.' },
  });
}

export { userLimiter, createRateLimitStore, RedisFixedWindowStore };

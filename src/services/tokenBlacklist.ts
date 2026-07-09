// ── Access-token blacklist ───────────────────────────────────────────────────
// Access tokens are short-lived JWTs (15 min) identified by a `jti` claim.
// "Revoking" one just means remembering its jti until the token would have
// expired anyway — after that, JWT expiry makes the blacklist entry moot,
// so we can safely forget it.
//
// Storage is two-tier:
//   - An in-process Map — always written, always checked first. Keeps a
//     single-instance deployment fully correct with zero Redis round-trips,
//     and keeps revocations made by THIS instance enforced even if Redis
//     is down.
//   - Redis (SET PX / EXISTS) — makes revocation visible across every
//     instance behind the load balancer. Checked only when the local map
//     misses. Fails OPEN on Redis errors (same philosophy as the rest of
//     this app's Redis handling — see socket/rateLimiter.ts): a Redis blip
//     degrades to "cross-instance revocations temporarily invisible",
//     which is exactly the pre-Redis behavior, not a mass logout.
//
// In tests (NODE_ENV=test) the Redis tier is disabled entirely so that
// require()'ing this module (via middleware/auth.ts, which almost every
// route test pulls in) never opens a network socket.
import Redis from 'ioredis';
import loggerBase from '../utils/logger';
import { config } from '../config/env';
const logger = loggerBase.child({ module: 'token-blacklist' });

const REDIS_KEY_PREFIX = 'chalk:revoked-jti:';

class TokenBlacklist {
  store: Map<string, number>;
  _sweepTimer: NodeJS.Timeout;
  _redis: Redis | null;
  _redisErrorLoggedRecently: boolean;

  constructor() {
    this.store = new Map(); // jti -> epoch ms after which the entry is dead weight
    this._sweepTimer = setInterval(() => this._sweep(), 5 * 60 * 1000);
    this._sweepTimer.unref?.();
    this._redisErrorLoggedRecently = false;

    if (config.server.nodeEnv === 'test') {
      this._redis = null;
    } else {
      this._redis = new Redis(config.redis.url, {
        // lazyConnect so merely require()'ing this module never opens a
        // socket — the connection starts on the first revoke/isRevoked.
        lazyConnect: true,
        // Fail fast: an auth check shouldn't hang behind ioredis retries.
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => Math.min(times * 200, 2000),
      });
      this._redis.on('error', (err: any) => this._logRedisError(err));
    }
  }

  // Only log Redis trouble once every 30s — an outage shouldn't turn every
  // authenticated request into its own error line.
  _logRedisError(err: any) {
    if (this._redisErrorLoggedRecently) return;
    this._redisErrorLoggedRecently = true;
    logger.error({ err }, 'Token blacklist Redis unavailable — cross-instance revocations are invisible until it recovers (local revocations still enforced)');
    setTimeout(() => { this._redisErrorLoggedRecently = false; }, 30_000).unref?.();
  }

  _connectIfNeeded() {
    // 'wait' is ioredis's "lazyConnect, never connected" state.
    if (this._redis && this._redis.status === 'wait') {
      this._redis.connect().catch((err: any) => this._logRedisError(err));
    }
  }

  // expiresAtMs: when the underlying JWT itself expires — no point keeping
  // the blacklist entry around any longer than that.
  revoke(jti: any, expiresAtMs: any) {
    if (!jti) return;
    const ttl = Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 15 * 60 * 1000;
    this.store.set(jti, ttl);

    if (this._redis) {
      this._connectIfNeeded();
      const px = Math.max(ttl - Date.now(), 1000);
      // Fire-and-forget: the local map above already covers this instance;
      // ioredis's offline queue buffers the write if the lazy connection is
      // still being established.
      this._redis
        .set(REDIS_KEY_PREFIX + jti, '1', 'PX', px)
        .catch((err: any) => this._logRedisError(err));
    }
  }

  async isRevoked(jti: any) {
    if (!jti) return false;
    if (this.store.has(jti)) return true;
    if (!this._redis) return false;

    this._connectIfNeeded();
    if (this._redis.status !== 'ready') return false; // fail open while (re)connecting

    try {
      return (await this._redis.exists(REDIS_KEY_PREFIX + jti)) === 1;
    } catch (err: any) {
      this._logRedisError(err);
      return false; // fail open
    }
  }

  _sweep() {
    const now = Date.now();
    for (const [jti, exp] of this.store) {
      if (exp <= now) this.store.delete(jti);
    }
  }
}

const tokenBlacklist = new TokenBlacklist();

export = tokenBlacklist;

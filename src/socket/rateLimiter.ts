import { redis } from './redisClient';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'socket-rate-limiter' });

/**
 * Core Redis-backed sliding-window rate limiter used by every socket flood
 * guard in this app (see rateLimit.ts). Backed by Redis instead of an
 * in-process Map so limits are enforced consistently across every server
 * instance behind the load balancer — a user/connection can't dodge a limit
 * by landing on a different instance.
 *
 * Algorithm: sliding-window LOG (a Redis sorted set per key, score =
 * timestamp). On each check we drop entries older than the window, count
 * what's left, and — if under the limit — add the current event and
 * refresh the key's TTL. This is more precise than a fixed-window counter
 * (no burst-at-the-boundary problem, e.g. two "windows" worth of traffic in
 * the last/first second of adjacent fixed windows), at the cost of an
 * O(log N) ZADD/ZREMRANGEBYSCORE per check instead of a single INCR — a
 * fine trade at these volumes (tens of events per key per window).
 */

const NS = 'chalk:rl';

// KEYS[1] = zset key (the sliding window log)
// KEYS[2] = warn flag key — lets us emit the "approaching the limit"
//           warning at most ONCE per window instead of on every single
//           event once past the threshold (which would otherwise spam the
//           client identically to the flood we're warning about).
// ARGV[1] = now (ms, epoch)
// ARGV[2] = window (ms)
// ARGV[3] = limit
// ARGV[4] = warn threshold (event count at which we start warning)
// ARGV[5] = member id — unique per call so two events landing in the same
//           millisecond don't collide/overwrite each other in the zset
//
// Returns [count, allowed(0/1), warn(0/1)]. `count` reflects the count
// AFTER this event when allowed=1, or the count that caused the rejection
// (== limit) when allowed=0 — the rejected event itself is never added to
// the log, so a client that backs off doesn't keep "using up" its budget.
const SLIDING_WINDOW_SCRIPT = `
local zkey = KEYS[1]
local warnkey = KEYS[2]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local warnThreshold = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', zkey, '-inf', now - window)
local count = redis.call('ZCARD', zkey)

if count >= limit then
  return {count, 0, 0}
end

redis.call('ZADD', zkey, now, member)
redis.call('PEXPIRE', zkey, window)
count = count + 1

local warn = 0
if count >= warnThreshold then
  local wasSet = redis.call('SET', warnkey, '1', 'NX', 'PX', window)
  if wasSet then
    warn = 1
  end
end

return {count, 1, warn}
`;

redis.defineCommand('slidingWindowCheck', {
  numberOfKeys: 2,
  lua: SLIDING_WINDOW_SCRIPT,
});

// defineCommand() registers the method at runtime only — ioredis's types
// don't know about it, so declare it here (same signature the Lua script
// returns: [count, allowed(0/1), warn(0/1)]).
declare module 'ioredis' {
  interface RedisCommander<Context> {
    slidingWindowCheck(
      zsetKey: string,
      warnKey: string,
      now: number,
      windowMs: number,
      limit: number,
      warnThreshold: number,
      member: string,
    ): Promise<[number, number, number]>;
  }
}

// Only log a Redis-unavailable warning once every 30s (not on every single
// socket event) so an outage doesn't itself flood the logs.
let failureLoggedRecently = false;

/**
 * Is `key` over `limit` events per `windowMs`? Also reports whether we've
 * crossed `warnRatio` of the limit (default 80%).
 *
 * Fails OPEN on Redis errors: `allowed: true`. A Redis blip degrading to
 * "temporarily no rate limiting" is far preferable to it degrading to "mass
 * -disconnect every connected socket" — same philosophy as the rest of this
 * app's Redis error handling (see index.ts health checks / graceful
 * shutdown, state.ts).
 */
async function checkSlidingWindow(key: string, windowMs: number, limit: number, warnRatio: number = 0.8) {
  const now = Date.now();
  const warnThreshold = Math.max(1, Math.ceil(limit * warnRatio));
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const [count, allowed, warn] = await redis.slidingWindowCheck(
      `${NS}:${key}`,
      `${NS}:${key}:warn`,
      now,
      windowMs,
      limit,
      warnThreshold,
      member
    );
    return {
      allowed: allowed === 1,
      warn: warn === 1,
      count,
      limit,
      windowMs,
      remaining: Math.max(0, limit - count),
    };
  } catch (err) {
    if (!failureLoggedRecently) {
      logger.error({ err }, 'Redis rate limiter unavailable — failing open (no rate limiting) until it recovers');
      failureLoggedRecently = true;
      setTimeout(() => { failureLoggedRecently = false; }, 30_000).unref?.();
    }
    return { allowed: true, warn: false, count: 0, limit, windowMs, remaining: limit };
  }
}

export { checkSlidingWindow };

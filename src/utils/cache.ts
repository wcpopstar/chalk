/**
 * Redis-backed response cache for read-heavy, staleness-tolerant endpoints.
 *
 * This is deliberately NOT a generic "cache everything" middleware.
 * Caching the wrong response is worse than caching nothing — every call
 * site in this codebase using `cached()` has a comment explaining why a
 * few seconds of staleness is fine for that specific response. As of this
 * writing that's exactly two endpoints:
 *
 *   - GET /api/games/tetris/leaderboard (routes/games.ts) — expensive
 *     (4 queries incl. two full-table counts), read by everyone, doesn't
 *     need to be to-the-second accurate.
 *   - GET /api/users/:id (routes/users/publicProfile.ts) — but ONLY the
 *     viewer-independent part of the response (profile fields + games).
 *     The blocked_by_me/has_blocked_me fields depend on WHO is asking, not
 *     just whose profile it is, so they're computed fresh on every request
 *     and merged in after — see that route for why a naive whole-response
 *     cache would have been a privacy bug (viewer A's blocked status
 *     leaking into viewer B's cached response for the same profile).
 *
 * Deliberately NOT cached, and why:
 *   - GET /api/users/discover — personalized per user (excludes people
 *     they've already swiped on), caching would show stale/already-seen
 *     profiles.
 *   - GET /api/users/search — query string has too much cardinality for a
 *     reasonable hit rate, and results should reflect the current DB
 *     state as someone is actively typing a name to add.
 *   - GET /api/friends — includes live presence/status per friend. This
 *     is exactly the data the Socket.io presence system (see
 *     socket/presence.ts) exists to keep real-time; caching it here would
 *     directly fight that.
 *
 * Failure behavior: any Redis error (down, timeout, whatever) makes
 * `cached()` fall straight through to calling `fn()` — a cache outage
 * degrades this to "slightly slower", never to a user-facing error. Cache
 * read/write failures are logged (warn) but not sent to Sentry/
 * app_errors_total — a cache miss is not an application error.
 */

import { redis } from '../socket/redisClient';
import loggerBase from './logger';
const logger = loggerBase.child({ module: 'cache' });
import * as metrics from './metrics';

function keyPrefixOf(key: string): string {
  return key.split(':')[0] ?? key;
}

/**
 * Returns the cached value for `key` if present; otherwise calls `fn()`,
 * caches its result for `ttlSeconds`, and returns it. If `fn()` throws,
 * the error propagates to the caller as normal — caching never swallows a
 * real error from the underlying data fetch, only errors talking to the
 * cache itself.
 */
async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  const keyPrefix = keyPrefixOf(key);

  try {
    const hit = await redis.get(key);
    if (hit !== null) {
      metrics.cacheHitsTotal.inc({ key_prefix: keyPrefix });
      return JSON.parse(hit);
    }
  } catch (err) {
    // Redis read failed (down/timeout/etc) — treat exactly like a miss and
    // fall through to fn(). Logged, not Sentry'd: see file header.
    logger.warn({ err, key }, 'Cache read failed, falling back to source');
  }

  metrics.cacheMissesTotal.inc({ key_prefix: keyPrefix });

  // NOT wrapped in try/catch — a failure here is a real failure of the
  // actual data source (e.g. Supabase down), and must propagate to the
  // caller exactly as if caching didn't exist.
  const value = await fn();

  // Fire-and-forget write: the request already has its (correct, fresh)
  // answer, a failed cache WRITE shouldn't turn into a failed request.
  redis.set(key, JSON.stringify(value), 'EX', ttlSeconds).catch((err: any) => {
    logger.warn({ err, key }, 'Cache write failed');
  });

  return value;
}

/** Deletes a single cache key — call after any write that would make a
 * cached response stale. Best-effort: if Redis is down, the write itself
 * still succeeded and the old cache entry will simply expire on its own
 * TTL, so a failed invalidation is logged, not thrown. */
async function invalidate(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, 'Cache invalidation failed (will self-expire via TTL)');
  }
}

export { cached, invalidate };

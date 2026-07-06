"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto = require('crypto');
const logger = require('../utils/logger').child({ module: 'feature-flags' });
const { queueConnection: redis } = require('../queues/connection');
/**
 * Feature flags — three layers, checked in this order:
 *   1. Live override in Redis (hash `feature_flags`, field = key) — lets you
 *      flip a flag without a redeploy. Optional: if Redis is unreachable,
 *      this layer is just skipped (logged once, not on every check).
 *   2. Env var `FEATURE_<KEY_IN_SCREAMING_SNAKE>` — static per-deployment
 *      override, e.g. FEATURE_DISCOVERY_ENABLED=false.
 *   3. The `default` in the registry below.
 *
 * Reuses the same lazy BullMQ Redis connection as src/queues/ rather than
 * opening a 4th connection to the same Redis instance — see
 * src/queues/connection.ts for why it's lazy (require-time safety for the
 * auth/users routers' test isolation).
 *
 * Deliberately NOT a general-purpose flag SDK — just enough to (a) kill-switch
 * a feature in production without a deploy and (b) gradually roll one out to
 * a percentage of users. Add a real vendor (LaunchDarkly, etc.) if this ever
 * needs targeting rules more complex than "on/off" + "X% of users".
 */
const REGISTRY = {
    'discovery.enabled': { default: true, description: 'Свайп-подбор игроков (вкладка Discover)' },
    'games.tetris.enabled': { default: true, description: 'Мини-игра Tetris и её лидерборд' },
    'chat.videoNotes.enabled': { default: true, description: 'Кружки — видео-сообщения в чате' },
    'chat.global.enabled': { default: true, description: 'Общий чат платформы (Global Chat)' },
};
const REDIS_HASH_KEY = 'feature_flags';
const CACHE_TTL_MS = 15_000; // how stale a runtime toggle is allowed to be across instances
let cache = null; // { data: { [key]: { enabled, rolloutPercent } }, fetchedAt: number }
let loggedRedisWarning = false;
function envOverride(key) {
    const envKey = 'FEATURE_' + key.toUpperCase().replace(/[.\-]/g, '_');
    const raw = process.env[envKey];
    if (raw === undefined)
        return undefined;
    return raw === 'true' || raw === '1';
}
async function fetchOverridesFromRedis() {
    try {
        const raw = await redis.hgetall(REDIS_HASH_KEY);
        const parsed = {};
        for (const [key, value] of Object.entries(raw || {})) {
            try {
                parsed[key] = JSON.parse(value);
            }
            catch (_) {
                /* ignore a corrupted single field rather than failing every flag */
            }
        }
        loggedRedisWarning = false;
        return parsed;
    }
    catch (err) {
        if (!loggedRedisWarning) {
            logger.warn({ err }, 'Feature flags: Redis unavailable, falling back to env/defaults only');
            loggedRedisWarning = true;
        }
        return {};
    }
}
async function getRuntimeOverrides() {
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS)
        return cache.data;
    const data = await fetchOverridesFromRedis();
    cache = { data, fetchedAt: Date.now() };
    return data;
}
// Deterministic per-user rollout bucket, stable across requests (same user
// always lands in the same bucket for a given flag) without storing
// anything per-user.
function bucketFor(userId, key) {
    const hash = crypto.createHash('sha1').update(`${key}:${userId}`).digest();
    return hash.readUInt32BE(0) % 100;
}
/**
 * Resolves whether `key` is enabled, optionally for a specific user
 * (needed only if the flag has a rolloutPercent override in Redis).
 */
async function isEnabled(key, { userId } = {}) {
    if (!(key in REGISTRY)) {
        logger.warn({ key }, 'isEnabled() called with an unregistered flag key');
        return false;
    }
    const overrides = await getRuntimeOverrides();
    const override = overrides[key];
    if (override && typeof override.rolloutPercent === 'number') {
        if (!userId)
            return !!override.enabled; // no user context — fall back to the plain on/off
        return bucketFor(userId, key) < override.rolloutPercent;
    }
    if (override && typeof override.enabled === 'boolean')
        return override.enabled;
    const fromEnv = envOverride(key);
    if (fromEnv !== undefined)
        return fromEnv;
    return REGISTRY[key].default;
}
/** Sets (or clears, with `null`) a live Redis override for a flag. */
async function setOverride(key, override) {
    if (!(key in REGISTRY))
        throw new Error(`Unknown feature flag: ${key}`);
    if (override === null) {
        await redis.hdel(REDIS_HASH_KEY, key);
    }
    else {
        await redis.hset(REDIS_HASH_KEY, key, JSON.stringify(override));
    }
    cache = null; // force a fresh read on the next isEnabled() call
}
/** All registered flags with their currently-resolved state — for an admin UI or a client bootstrap call. */
async function listFlags({ userId } = {}) {
    const overrides = await getRuntimeOverrides();
    const entries = await Promise.all(Object.keys(REGISTRY).map(async (key) => ({
        key,
        description: REGISTRY[key].description,
        default: REGISTRY[key].default,
        override: overrides[key] || null,
        enabled: await isEnabled(key, { userId }),
    })));
    return entries;
}
module.exports = { isEnabled, setOverride, listFlags, REGISTRY };
//# sourceMappingURL=featureFlags.js.map
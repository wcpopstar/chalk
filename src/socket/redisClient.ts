import Redis from 'ioredis';
import loggerBase from '../utils/logger';
import { config } from '../config/env';
const logger = loggerBase.child({ module: 'redis' });

/**
 * Redis connections used by the realtime layer.
 *
 * We keep THREE separate connections on purpose:
 *  - `redis`     : general purpose client for state.js / matchmaking.js
 *                  (hashes, TTL keys, Lua scripts, pipelines).
 *  - `pubClient` / `subClient` : dedicated pair for the Socket.io Redis
 *                  adapter (@socket.io/redis-adapter). A client that's been
 *                  put into subscriber mode by ioredis can no longer run
 *                  normal commands, so it must never be shared with `redis`.
 *
 * All three point at the same Redis instance/cluster via REDIS_URL, they're
 * just logically separate connections.
 */

const REDIS_URL = config.redis.url;

function createClient(label: string) {
  const client = new Redis(REDIS_URL, {
    // Fail fast instead of buffering commands forever if Redis is down —
    // we'd rather a socket event error out than hang the event loop.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times: number) {
      // capped exponential-ish backoff, 200ms → 2s
      return Math.min(times * 200, 2000);
    },
  });

  client.on('error', (err: any) => {
    logger.error({ err, connection: label }, 'Redis connection error');
  });
  client.on('connect', () => logger.info({ connection: label }, 'Redis connecting…'));
  client.on('ready', () => logger.info({ connection: label }, 'Redis ready'));
  client.on('reconnecting', (delay: number) => logger.warn({ connection: label, delay }, 'Redis reconnecting'));

  return client;
}

const redis = createClient('main');
const pubClient = createClient('adapter-pub');
const subClient = pubClient.duplicate();
subClient.on('error', (err: any) => logger.error({ err, connection: 'adapter-sub' }, 'Redis connection error'));

// Resolves once all three connections are ready. Use this at boot so the
// HTTP/socket server doesn't start accepting traffic before Redis-backed
// state is actually usable.
function waitForRedisReady() {
  const ready = (client: Redis) =>
    client.status === 'ready' ? Promise.resolve() : new Promise((res) => client.once('ready', res));
  return Promise.all([ready(redis), ready(pubClient), ready(subClient)]);
}

export { redis, pubClient, subClient, waitForRedisReady, REDIS_URL };

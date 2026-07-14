import Redis from 'ioredis';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'queue-redis' });
import { config } from '../config/env';

/**
 * BullMQ needs its own Redis connection, separate from `redis` /
 * `pubClient` / `subClient` in socket/redisClient.ts — it requires
 * `maxRetriesPerRequest: null` (it does its own retry/backoff internally;
 * ioredis retrying underneath it breaks blocking commands like BRPOPLPUSH)
 * and `enableReadyCheck: false` is the documented BullMQ recommendation.
 * Sharing one of the app's existing clients would silently break both.
 *
 * All connections still point at the same REDIS_URL / Redis instance —
 * this doesn't add new infrastructure, just a connection with different
 * ioredis options.
 */
const queueConnection = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Route modules (e.g. routes/auth/passwordReset.ts) require this file
  // just to get the enqueue helper — they shouldn't open a live Redis
  // socket as a side effect of being require()'d (this is what lets
  // test/routes/auth.test.ts require the auth router with zero Redis
  // dependency, same as before queues existed). The actual connection is
  // opened lazily on the first real command — i.e. the first .add()/job.
  lazyConnect: true,
});

queueConnection.on('error', (err: any) => {
  logger.error({ err }, 'Queue Redis connection error');
});
queueConnection.on('ready', () => logger.info('Queue Redis ready'));

export { queueConnection };

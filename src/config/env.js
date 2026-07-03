const logger = require('../utils/logger');

function getServerConfig() {
  const port = Number(process.env.PORT || 3000);
  const nodeEnv = process.env.NODE_ENV || 'development';
  const clientOrigin = process.env.CLIENT_URL || '*';
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    nodeEnv,
    clientOrigin,
    redisUrl,
  };
}

function validateEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  // REDIS_URL is not in `required` on purpose: it defaults to
  // redis://127.0.0.1:6379 for local dev. In staging/production you should
  // always set it explicitly — warn loudly instead of silently falling
  // back to localhost, which would just fail to connect.
  if (!process.env.REDIS_URL && process.env.NODE_ENV === 'production') {
    logger.warn('REDIS_URL is not set in production — falling back to redis://127.0.0.1:6379');
  }
}

module.exports = { getServerConfig, validateEnv };

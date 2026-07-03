/**
 * Centralized Pino logger.
 *
 * Design goals:
 *  - Pretty, human-readable output in development.
 *  - Structured, machine-parseable JSON in production (for log
 *    aggregators like Datadog / CloudWatch / Railway logs).
 *  - Consistent redaction of sensitive fields everywhere, so a stray
 *    `logger.info({ req: ... })` can never leak a password or JWT.
 *  - A single place to change log level, redaction rules, or the base
 *    payload attached to every line (service name, env, version...).
 *
 * Usage:
 *   const logger = require('./utils/logger');
 *   logger.info('Server started');
 *   logger.error({ err }, 'Failed to connect to Redis');
 *
 *   // Scoped/child loggers (recommended inside modules & handlers):
 *   const log = logger.child({ module: 'auth' });
 *   log.warn({ userId }, 'Refresh token reuse detected');
 */

const pino = require('pino');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// Allow overriding via env var, but pick sensible defaults per environment:
// verbose `debug` locally, `info` in production (avoid paying the cost of
// debug-level logging — and the noise — in prod unless explicitly enabled).
const LOG_LEVEL = process.env.LOG_LEVEL || (IS_PRODUCTION ? 'info' : 'debug');

// ── Redaction ────────────────────────────────────────────────────────────
// Pino's `redact` uses fast-redact paths. We cover the field itself at any
// nesting depth (`*.password`) as well as common containers (headers,
// request/response bodies, error objects) so this stays safe even as new
// call sites are added without anyone remembering to scrub manually.
const REDACT_PATHS = [
  // Auth headers / tokens
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.cookie',

  // Common sensitive field names, wildcarded across nesting depth
  '*.password',
  '*.password_hash',
  '*.newPassword',
  '*.currentPassword',
  '*.confirmPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.jti',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.jwt',
  '*.jwt_secret',

  // Third-party credentials that occasionally end up in payloads/config dumps
  '*.SUPABASE_SERVICE_KEY',
  '*.SUPABASE_ANON_KEY',
  '*.AGORA_APP_CERTIFICATE',
  '*.SMTP_PASS',

  // One level deeper for common nested shapes (body/query/params on req
  // logs from pino-http, or {user, body} objects passed manually)
  '*.body.password',
  '*.body.token',
  '*.body.refreshToken',
  '*.body.currentPassword',
  '*.body.newPassword',
];

const redact = {
  paths: REDACT_PATHS,
  censor: '[REDACTED]',
};

// ── Base fields attached to every log line ─────────────────────────────
const base = {
  service: 'chalk-backend',
  env: NODE_ENV,
  pid: process.pid,
};

// ── Transport ────────────────────────────────────────────────────────────
// Pretty-printed, colorized logs in development; raw JSON (fastest, and
// what every log shipper expects) in production. Using pino.transport
// keeps pretty-printing off the main thread (worker thread) so it doesn't
// impact request latency even in dev.
const transport = IS_PRODUCTION
  ? undefined
  : {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    };

const logger = pino({
  level: LOG_LEVEL,
  base,
  redact,
  transport,
  // ISO timestamps are far easier to correlate against other systems
  // (Supabase, Redis, Agora dashboards) than pino's default epoch ms.
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Keep level as a string ("info") instead of pino's default numeric
    // level — much friendlier when eyeballing raw JSON in production logs.
    level(label) {
      return { level: label };
    },
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
});

module.exports = logger;

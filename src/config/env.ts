export {};
/**
 * Single source of truth for every environment variable this app reads.
 *
 * Before this, `process.env.X` was scattered across ~10 files (supabase.ts,
 * mailer.ts, redisClient.ts, jwt.ts, agora.ts, sentry.ts, index.ts, ...),
 * each with its own ad-hoc default and no shared validation — a typo'd var
 * name, or a var that's required in one environment but not another, would
 * only surface as a runtime crash deep inside whatever feature first
 * touched it (e.g. the first password-reset email attempt discovering
 * SMTP_HOST was misspelled).
 *
 * The fix: read every var exactly ONCE, right here, into a single frozen
 * `config` object, and have every other module import from `config`
 * instead of touching `process.env` directly. validateEnv() then fails
 * fast at startup — before the server ever binds a port — if something
 * required is missing, and logs a warning for anything that's optional but
 * recommended in production.
 *
 * The ONLY files in this codebase still allowed to read `process.env`
 * directly are:
 *   - THIS file (obviously).
 *   - src/utils/logger.ts, for its own LOG_LEVEL/NODE_ENV bootstrap — the
 *     logger has to exist and be configured before this config module can
 *     use it to log anything (including its own validation warnings), so
 *     there's an unavoidable chicken-and-egg here. Documented there too.
 * Every other file: require('./config/env') (or the relevant relative
 * path) and use config.whatever instead.
 *
 * NOTE for tests: `config` is computed ONCE, when this module is first
 * require()'d, and frozen — mutating `process.env` afterwards will NOT
 * change an already-loaded `config`. Tests that need a config built from
 * different env vars must bust the require cache and re-require this
 * module (see test/env.test.ts for the pattern).
 */

const logger = require('../utils/logger');

// Read every var exactly once, at module load time.
const config = Object.freeze({
  server: Object.freeze({
    port: (() => {
      const n = Number(process.env.PORT || 3000);
      return Number.isFinite(n) && n > 0 ? n : 3000;
    })(),
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction: (process.env.NODE_ENV || 'development') === 'production',
    // '*' (allow any origin) is a deliberate permissive default for local
    // dev — validateEnv() below warns loudly if this is still unset in
    // production, where it should always be a specific domain.
    clientOrigin: process.env.CLIENT_URL || '*',
  }),

  supabase: Object.freeze({
    url: process.env.SUPABASE_URL || null,
    anonKey: process.env.SUPABASE_ANON_KEY || null,
    serviceKey: process.env.SUPABASE_SERVICE_KEY || null,
  }),

  redis: Object.freeze({
    // Defaults to local Redis for dev convenience; validateEnv() warns if
    // this is still unset in production, where it would just fail to
    // connect instead of pointing at a real Redis instance.
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  }),

  jwt: Object.freeze({
    secret: process.env.JWT_SECRET || null,
  }),

  agora: Object.freeze({
    appId: process.env.AGORA_APP_ID || null,
    appCertificate: process.env.AGORA_APP_CERTIFICATE || null,
  }),

  smtp: Object.freeze({
    // host === null is the documented signal (see services/mailer.ts) to
    // fall back to logging the email instead of sending it — useful for
    // local dev, expected to always be set in production.
    host: process.env.SMTP_HOST || null,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM || 'Chalk <no-reply@chalk.gg>',
  }),

  sentry: Object.freeze({
    dsn: process.env.SENTRY_DSN || null,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    // Railway sets this automatically; falls back to package.json's
    // version so releases are still distinguishable off-Railway too.
    release: process.env.RAILWAY_GIT_COMMIT_SHA || require('../../package.json').version,
  }),

  metrics: Object.freeze({
    token: process.env.METRICS_TOKEN || null,
  }),

  docs: Object.freeze({
    // Swagger UI at /api/docs. Defaults to ON in development (so it's
    // discoverable with zero setup) and OFF in production unless
    // explicitly enabled — this is a private app's internal API, not a
    // public API product, so it shouldn't be reachable by default on a
    // public Railway URL. Accepts the literal string 'true'.
    enabled: process.env.API_DOCS_ENABLED != null
      ? process.env.API_DOCS_ENABLED === 'true'
      : !((process.env.NODE_ENV || 'development') === 'production'),
  }),

  admin: Object.freeze({
    // Gates the feature-flag admin endpoints (see routes/featureFlags.ts,
    // middleware/requireAdminKey.ts). Unset = those endpoints are disabled
    // entirely (fail closed, not open) rather than silently unauthenticated.
    apiKey: process.env.ADMIN_API_KEY || null,
  }),

  giphy: Object.freeze({
    // Used by routes/gifs.ts to proxy GIF search server-side, so the key
    // never ships to the browser (see that file's header comment for why
    // a client-side Giphy key is a bad idea even though Giphy search keys
    // are low-stakes: it's still an account-tied, rate-limited credential
    // that shouldn't be handed to every visitor). Unset = the GIF picker
    // is disabled (503), not broken with a confusing downstream error.
    apiKey: process.env.GIPHY_API_KEY || null,
  }),

  // Not read from anywhere else in the old (pre-centralization) codebase —
  // added here directly since index.ts/worker.ts both need it and every
  // other env var already lives here.
  workers: Object.freeze({
    runInProcess: process.env.RUN_WORKERS_IN_PROCESS !== 'false',
  }),
});

// ── Fail fast for anything the app truly cannot run without ────────────────
function validateEnv() {
  const required = {
    SUPABASE_URL: config.supabase.url,
    SUPABASE_ANON_KEY: config.supabase.anonKey,
    SUPABASE_SERVICE_KEY: config.supabase.serviceKey,
    JWT_SECRET: config.jwt.secret,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  // ── Recommended-but-optional, warn once at startup instead of letting
  //    each feature discover its own missing config lazily (and
  //    inconsistently — some as a crash, some silently degraded). ─────────
  if (!process.env.REDIS_URL && config.server.isProduction) {
    logger.warn('REDIS_URL is not set in production — falling back to redis://127.0.0.1:6379');
  }
  if (!config.smtp.host && config.server.isProduction) {
    logger.warn('SMTP_HOST is not set in production — password reset emails will only be logged, never sent');
  }
  if ((!config.agora.appId || !config.agora.appCertificate) && config.server.isProduction) {
    logger.warn('AGORA_APP_ID/AGORA_APP_CERTIFICATE not set in production — voice/video calls will fail to obtain a token');
  }
  if (!config.sentry.dsn && config.server.isProduction) {
    logger.warn('SENTRY_DSN is not set in production — errors will not be reported to Sentry');
  }
  if (!config.metrics.token && config.server.isProduction) {
    logger.warn('METRICS_TOKEN is not set in production — /metrics is publicly readable');
  }
  if (config.server.clientOrigin === '*' && config.server.isProduction) {
    logger.warn('CLIENT_URL is not set in production — CORS currently allows any origin ("*")');
  }
  if (config.docs.enabled && config.server.isProduction) {
    logger.warn('API_DOCS_ENABLED=true in production — /api/docs is publicly reachable. Fine for an internal/admin-only deploy, but don\'t expose it on a public app URL without also protecting it (e.g. behind METRICS_TOKEN-style auth or a private network).');
  }
  if (!config.admin.apiKey && config.server.isProduction) {
    logger.warn('ADMIN_API_KEY is not set in production — the feature-flag admin endpoints (/api/flags/admin/*) are disabled (fail closed).');
  }
  if (!config.giphy.apiKey && config.server.isProduction) {
    logger.warn('GIPHY_API_KEY is not set in production — the GIF picker will return 503 instead of search results.');
  }
}

module.exports = { config, validateEnv };

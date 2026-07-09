// ── Product analytics (PostHog) ─────────────────────────────────────────────
// Server-side event capture for product questions ("how many users who
// swiped ended up in a call?") — deliberately separate from utils/metrics.ts
// (Prometheus), which answers OPS questions about this process.
//
// Fail-safe by design:
//   - No POSTHOG_API_KEY (or NODE_ENV=test) -> every function is a no-op.
//   - capture() never throws and never blocks a request — posthog-node
//     batches events in memory and flushes in the background.
//   - shutdown() flushes the queue during graceful shutdown so the last
//     events of a draining instance aren't lost.
//
// Event naming: snake_case verbs in past tense ("user_registered"), one
// event per product action, properties for dimensions. Keep the catalog
// small and intentional — every event here should back a real question.
import loggerBase from '../utils/logger';
import { config } from '../config/env';
const logger = loggerBase.child({ module: 'analytics' });

let client: any = null;
let initialized = false;

function getClient() {
  if (initialized) return client;
  initialized = true;

  if (!config.analytics.posthogKey || config.server.nodeEnv === 'test') {
    return null;
  }

  // Lazy require so the (heavy-ish) SDK isn't even loaded when disabled.
  const { PostHog } = require('posthog-node');
  client = new PostHog(config.analytics.posthogKey, {
    host: config.analytics.posthogHost,
    flushAt: 20,        // batch size
    flushInterval: 10_000,
  });
  client.on('error', (err: any) => {
    logger.warn({ err }, 'PostHog delivery error (events may be dropped)');
  });
  logger.info({ host: config.analytics.posthogHost }, 'Product analytics enabled (PostHog)');
  return client;
}

/**
 * Records one product event for a user. Fire-and-forget: never throws,
 * never awaited by callers.
 */
function capture(userId: string, event: string, properties: Record<string, any> = {}) {
  const c = getClient();
  if (!c || !userId) return;
  try {
    c.capture({ distinctId: String(userId), event, properties });
  } catch (err: any) {
    logger.warn({ err, event }, 'Failed to capture analytics event');
  }
}

/** Attaches profile properties to a user (called on register/profile update). */
function identify(userId: string, properties: Record<string, any> = {}) {
  const c = getClient();
  if (!c || !userId) return;
  try {
    c.identify({ distinctId: String(userId), properties });
  } catch (err: any) {
    logger.warn({ err }, 'Failed to identify analytics user');
  }
}

/** Flushes pending events; called from graceful shutdown. */
async function shutdownAnalytics() {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err: any) {
    logger.warn({ err }, 'Analytics shutdown flush failed');
  }
}

// Test hook: lets unit tests inject a fake client without a real API key.
function _setClientForTests(fake: any) {
  client = fake;
  initialized = true;
}

export { capture, identify, shutdownAnalytics, _setClientForTests };

export {};
import type { TypedSocket } from './types';
const { checkSlidingWindow } = require('./rateLimiter');

/**
 * All Socket.io flood/rate-limit checks for this app. Backed by Redis (see
 * rateLimiter.ts) so limits hold up across horizontal scaling — a socket or
 * user can't dodge a limit by reconnecting onto a different server instance.
 *
 * Two tiers, wired together in validation.ts's secureOn():
 *
 * 1. LEGACY per-event checks (isFlooding / isFloodingUser / isFloodingGlobal)
 *    — unchanged in spirit from the original in-memory version, just async
 *    now. Breaching one of these rejects *that single action* (an ack
 *    error), the socket stays connected. Used for the app's existing
 *    finer-grained per-event limits (chat:gif, chat:voice, trial:vote,
 *    swipe, etc. — see DEFAULT_RATE_LIMITS in validation.ts).
 *
 * 2. HARD limits (checkConnectionBudget / checkNamedLimit) — the
 *    requirements this module was built to satisfy: an overall per-
 *    connection budget, plus named per-event-family limits for
 *    match:join / chat:message / signal:*. Breaching one of these
 *    DISCONNECTS the socket (error:rate_limit_exceeded); getting close
 *    (80%) emits a one-shot warning:rate_limit_approaching.
 */

// ── Tier 1: legacy granular checks (soft — reject the one action) ─────────

// Scoped to a single socket connection.
async function isFlooding(socket: TypedSocket, key: string, windowMs: number, max: number) {
  const res = await checkSlidingWindow(`socket:${socket.id}:${key}`, windowMs, max);
  return !res.allowed;
}

// Scoped to the authenticated user — survives reconnects/multiple tabs, so
// it's what actually closes the "just open a new connection" loophole that
// a pure per-socket check has.
async function isFloodingUser(userId: any, key: any, windowMs: any, max: any) {
  const res = await checkSlidingWindow(`user:${userId}:${key}`, windowMs, max);
  return !res.allowed;
}

// Global "all socket events combined" budget per user, independent of which
// specific event they're spamming — a safety net against event-hopping
// (chat:gif / chat:voice / chat:edit each individually under its own limit,
// but adding up to a flood), not the primary per-event limit.
const GLOBAL_EVENT_BUDGET = { windowMs: 10_000, max: 120 };
async function isFloodingGlobal(userId: any) {
  return isFloodingUser(userId, '__global__', GLOBAL_EVENT_BUDGET.windowMs, GLOBAL_EVENT_BUDGET.max);
}

// Kept for backward compatibility with index.ts's disconnect handler. A
// no-op now: Redis keys expire on their own via PEXPIRE, there's no
// in-process Map left to sweep.
function clearRateLimitsFor(_socket: TypedSocket) {}

// ── Tier 2: hard limits (disconnect on breach, warn at 80%) ───────────────

// 1) Overall per-connection budget: 80–100 events / 10s per the spec.
// Deliberately scoped to the SOCKET, not the user: this guards against one
// runaway/malicious *connection* (e.g. a compromised or misbehaving client
// tab), so a user with several tabs/devices open gets one independent
// budget per connection rather than sharing a single one. Enforced via
// socket.onAny() in socket/index.ts so it covers every incoming event on
// the connection, including ones with no registered handler.
const CONNECTION_BUDGET = {
  windowMs: Number(process.env.RATE_LIMIT_CONNECTION_WINDOW_MS) || 10_000,
  max: Number(process.env.RATE_LIMIT_CONNECTION_MAX) || 90, // within the required 80–100 range
};

async function checkConnectionBudget(socket: TypedSocket) {
  return checkSlidingWindow(`conn:${socket.id}`, CONNECTION_BUDGET.windowMs, CONNECTION_BUDGET.max, 0.8);
}

// 2) Named per-event-family hard limits, keyed by userId (not socket.id) so
// a reconnect can't reset the counter.
//
// NOTE on "signal:*": this app doesn't have a `signal:` event namespace —
// call setup is negotiated over Agora, a separate SDK connection that never
// touches this Socket.io server at all, so there's nothing to rate-limit
// there. The signaling that DOES cross this server is the
// call:invite / call:accept / call:reject / call:end / call:request_join /
// call:join_response family, which is this app's equivalent of "signal:*"
// and is treated as such: all of it shares ONE combined 60/min budget, per
// spec. Any event actually named `signal:...` (e.g. if raw WebRTC signaling
// is added later) is covered automatically too — see resolveNamedLimit().
const NAMED_LIMITS: any = {
  'match:join': { windowMs: 60_000, max: Number(process.env.RATE_LIMIT_MATCH_JOIN_MAX) || 6 },
  'chat:message': { windowMs: 60_000, max: Number(process.env.RATE_LIMIT_CHAT_MESSAGE_MAX) || 25 },
  signal: { windowMs: 60_000, max: Number(process.env.RATE_LIMIT_SIGNAL_MAX) || 60 },
};

function resolveNamedLimit(eventName: any) {
  if (eventName === 'match:join') return { limitKey: 'match:join', ...NAMED_LIMITS['match:join'] };
  if (eventName === 'chat:message') return { limitKey: 'chat:message', ...NAMED_LIMITS['chat:message'] };
  if (eventName.startsWith('signal:') || eventName.startsWith('call:')) {
    return { limitKey: 'signal', ...NAMED_LIMITS.signal };
  }
  return null;
}

// Returns null if `eventName` isn't covered by a named hard limit, else the
// checkSlidingWindow() result plus `limitKey` (for logging/emit payloads).
async function checkNamedLimit(userId: any, eventName: any) {
  const cfg = resolveNamedLimit(eventName);
  if (!cfg) return null;
  const res = await checkSlidingWindow(`named:${cfg.limitKey}:${userId}`, cfg.windowMs, cfg.max, 0.8);
  return { ...res, limitKey: cfg.limitKey };
}

module.exports = {
  // tier 1 (legacy, soft)
  isFlooding,
  isFloodingUser,
  isFloodingGlobal,
  clearRateLimitsFor,
  // tier 2 (hard, disconnects on breach)
  checkConnectionBudget,
  checkNamedLimit,
  CONNECTION_BUDGET,
  NAMED_LIMITS,
};

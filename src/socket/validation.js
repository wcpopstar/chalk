const { socketEventSchemas } = require('../validation/socketSchemas');
const { isFlooding, isFloodingUser, isFloodingGlobal } = require('./rateLimit');
const fallbackLogger = require('../utils/logger').child({ module: 'socket-validation' });

// ── Per-event rate limits ───────────────────────────────────────────────────
// These mirror the isFlooding(...) calls that used to be hand-written inline
// in each socket/*.js handler (chat.js, globalChat.js, match.js, calls.js,
// swipe.js) — same numbers, just centralized — plus sane defaults added for
// events that previously had NO rate limit at all (chat:join/leave,
// call:accept/reject/end, call:join_response, friends:call_status,
// match:leave). Override per-call via secureOn(..., { rateLimit: {...} }) if
// a specific handler needs something different.
const DEFAULT_RATE_LIMITS = {
  'chat:join': { windowMs: 10_000, max: 20 },
  'chat:leave': { windowMs: 10_000, max: 20 },
  'chat:message': { windowMs: 10_000, max: 20 },
  'chat:gif': { windowMs: 10_000, max: 12 },
  'chat:voice': { windowMs: 30_000, max: 6 },
  'chat:video_note': { windowMs: 30_000, max: 6 },
  'chat:edit': { windowMs: 10_000, max: 15 },
  'chat:delete': { windowMs: 10_000, max: 15 },
  'chat:typing': { windowMs: 5_000, max: 15 },

  'global:message': { windowMs: 10_000, max: 20 },
  'global:gif': { windowMs: 10_000, max: 12 },
  'global:voice': { windowMs: 30_000, max: 6 },
  'global:video_note': { windowMs: 30_000, max: 6 },
  'global:edit': { windowMs: 10_000, max: 15 },
  'global:delete': { windowMs: 10_000, max: 15 },

  'match:join': { windowMs: 10_000, max: 8 },
  'match:leave': { windowMs: 10_000, max: 8 },
  'trial:vote': { windowMs: 10_000, max: 10 },

  swipe: { windowMs: 10_000, max: 40 },

  'call:end': { windowMs: 10_000, max: 10 },
  'call:invite': { windowMs: 30_000, max: 8 },
  'call:accept': { windowMs: 10_000, max: 15 },
  'call:reject': { windowMs: 10_000, max: 15 },
  'call:request_join': { windowMs: 30_000, max: 8 },
  'call:join_response': { windowMs: 10_000, max: 15 },
  'friends:call_status': { windowMs: 10_000, max: 20 },
};

// ── validateSocketEvent ──────────────────────────────────────────────────
// Parses+validates a raw payload against the Zod schema registered for
// `eventName`. Returns { ok: true, data } or { ok: false, error }.
//
// Unknown events (not in the registry) are rejected by default — every
// event this server accepts must have an explicit schema, so a typo'd or
// newly-added event can't silently skip validation.
function validateSocketEvent(eventName, payload) {
  const schema = socketEventSchemas[eventName];
  if (!schema) {
    return { ok: false, error: `Unknown event: ${eventName} (no schema registered)` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path?.length ? firstIssue.path.join('.') + ': ' : '';
    return { ok: false, error: `${path}${firstIssue?.message || 'Некорректные данные'}` };
  }
  return { ok: true, data: result.data };
}

// ── secureOn ─────────────────────────────────────────────────────────────
// Drop-in replacement for `socket.on(eventName, handler)` that adds, in
// order: (1) a global per-user event budget, (2) a per-event rate limit
// (both per-socket and per-user, so reconnecting doesn't reset it), then
// (3) Zod validation of the payload — and only then calls your handler with
// the *parsed, validated* data.
//
// handler signature: (data, ack, socket) => void | Promise<void>
//   - `data` is the Zod-parsed payload (defaults applied, extra keys stripped
//     for .object() schemas).
//   - `ack` is always a callable function — a no-op if the client didn't
//     pass one, so handlers can call ack({ ok: true }) / ack({ error })
//     unconditionally without checking typeof first.
//
// options:
//   - rateLimit: { windowMs, max } — override the DEFAULT_RATE_LIMITS entry
//   - onRateLimited(socket, ack) — custom response when rate-limited
//     (default: ack({ error: '...' }) and, for non-ack events, a matching
//     `${eventName}:error` emit so existing client listeners keep working)
//   - onInvalid(socket, ack, error) — custom response on validation failure
//     (same default behavior as onRateLimited)
function secureOn(io, socket, userId, eventName, handler, options = {}) {
  const rl = options.rateLimit || DEFAULT_RATE_LIMITS[eventName] || { windowMs: 10_000, max: 20 };

  const defaultReject = (sock, ackFn, message) => {
    ackFn({ error: message });
    // Best-effort compatibility with the ad-hoc `${event}:error` /
    // `${event}_failed`-style events handlers used to emit manually. We
    // can't guess every handler's exact event name, so we emit one
    // consistent, additive event any client can opt into listening for,
    // without removing/breaking the handler-specific ones already in place.
    socket.emit('socket:error', { event: eventName, error: message });
  };

  socket.on(eventName, async (rawPayload, rawCallback) => {
    const ack = typeof rawCallback === 'function' ? rawCallback : () => {};

    // 1) Global cross-event budget — catches "hop between 5 different
    //    under-the-limit events" abuse that no single per-event check sees.
    if (isFloodingGlobal(userId)) {
      return (options.onRateLimited || defaultReject)(socket, ack, 'Слишком много действий, притормози немного');
    }

    // 2) Per-event limit, checked both per-socket (fast, catches a single
    //    connection mashing) and per-user (survives reconnects).
    if (isFlooding(socket, eventName, rl.windowMs, rl.max) || isFloodingUser(userId, eventName, rl.windowMs, rl.max)) {
      return (options.onRateLimited || defaultReject)(socket, ack, 'Слишком часто, подожди немного');
    }

    // 3) Schema validation.
    const { ok, data, error } = validateSocketEvent(eventName, rawPayload || {});
    if (!ok) {
      return (options.onInvalid || defaultReject)(socket, ack, error);
    }

    try {
      await handler(data, ack, socket);
    } catch (err) {
      // socket.log is a child logger tagged with connectionId/socketId/
      // userId (see socketLogger.js) — no need to repeat those here.
      (socket.log || fallbackLogger).error({ err, event: eventName }, 'Socket event handler threw');
      ack({ error: err.message || 'Внутренняя ошибка' });
    }
  });
}

// ── Connection-level middleware ───────────────────────────────────────────
// Separate from per-event limits above: this throttles how many NEW socket
// connections a single IP can open in a short window, which per-event
// limiters can't do anything about since they only start counting *after*
// a connection (and auth) already succeeded. Protects against connection
// churn / handshake-flood style abuse (incl. auth brute forcing via
// repeated handshakes with different tokens).
const CONNECTION_LIMIT = { windowMs: 60_000, max: 30 }; // 30 new connections/min/IP

function socketConnectionRateLimiter(socket, next) {
  const ip = socket.handshake.address || socket.conn?.remoteAddress || 'unknown';
  if (isFloodingUser(`ip:${ip}`, 'connect', CONNECTION_LIMIT.windowMs, CONNECTION_LIMIT.max)) {
    return next(new Error('Too many connection attempts, please slow down'));
  }
  next();
}

module.exports = {
  secureOn,
  validateSocketEvent,
  socketConnectionRateLimiter,
  DEFAULT_RATE_LIMITS,
};

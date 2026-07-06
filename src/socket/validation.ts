export {};
import type { TypedServer, TypedSocket, ClientToServerEvents, SecuredEventName } from './types';
const { socketEventSchemas } = require('../validation/socketSchemas');
const {
  isFlooding,
  isFloodingUser,
  isFloodingGlobal,
  checkNamedLimit,
} = require('./rateLimit');
const fallbackLogger = require('../utils/logger').child({ module: 'socket-validation' });
const Sentry = require('../utils/sentry');
const metrics = require('../utils/metrics');

// ── secureOn() handler/options types ─────────────────────────────────────
// `E` is the event name; the handler's `data`/`ack` parameter types are
// derived from ClientToServerEvents[E] (which itself comes straight from
// the Zod schema for that event — see validation/socketSchemas.ts), so a
// handler registered for e.g. 'chat:message' gets `data: { conversationId:
// string; text: string }` with no manual annotation needed at the call
// site, and a typo'd event name (one not in ClientToServerEvents) is a
// compile error.
type EventData<E extends SecuredEventName> = Parameters<ClientToServerEvents[E]>[0];
type EventAck<E extends SecuredEventName> = Parameters<ClientToServerEvents[E]>[1];

type SecureOnHandler<E extends SecuredEventName> = (
  data: EventData<E>,
  ack: EventAck<E>,
  socket: TypedSocket
) => void | Promise<void>;

interface SecureOnOptions<E extends SecuredEventName> {
  rateLimit?: { windowMs: number; max: number };
  onRateLimited?: (socket: TypedSocket, ack: EventAck<E>, message: string) => void;
  onInvalid?: (socket: TypedSocket, ack: EventAck<E>, error: string) => void;
}

// ── Per-event rate limits (soft — rejects just the one action) ─────────────
// These mirror the isFlooding(...) calls that used to be hand-written inline
// in each socket/*.ts handler (chat.ts, globalChat.ts, match.ts, calls.ts,
// swipe.ts) — same numbers, just centralized — plus sane defaults added for
// events that previously had NO rate limit at all (chat:join/leave,
// call:accept/reject/end, call:join_response, friends:call_status,
// match:leave). Override per-call via secureOn(..., { rateLimit: {...} }) if
// a specific handler needs something different.
//
// match:join, chat:message, and the whole call:* family are deliberately
// NOT here — they're covered by the HARD, Redis-backed limits in
// rateLimit.ts's NAMED_LIMITS instead (disconnects the socket on breach,
// per the rate-limiting spec), checked separately below in secureOn().
const DEFAULT_RATE_LIMITS: any = {
  'chat:join': { windowMs: 10_000, max: 20 },
  'chat:leave': { windowMs: 10_000, max: 20 },
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

  'match:leave': { windowMs: 10_000, max: 8 },
  'trial:vote': { windowMs: 10_000, max: 10 },

  swipe: { windowMs: 10_000, max: 40 },

  'friends:call_status': { windowMs: 10_000, max: 20 },
};

// ── validateSocketEvent ──────────────────────────────────────────────────
// Parses+validates a raw payload against the Zod schema registered for
// `eventName`. Returns { ok: true, data } or { ok: false, error }.
//
// Unknown events (not in the registry) are rejected by default — every
// event this server accepts must have an explicit schema, so a typo'd or
// newly-added event can't silently skip validation.
function validateSocketEvent<E extends SecuredEventName>(eventName: E, payload: unknown) {
  const schema = (socketEventSchemas as Record<string, any>)[eventName as string];
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
//   - onRateLimited(socket, ack) — custom response when soft rate-limited
//     (default: ack({ error: '...' }) and, for non-ack events, a matching
//     `${eventName}:error` emit so existing client listeners keep working)
//   - onInvalid(socket, ack, error) — custom response on validation failure
//     (same default behavior as onRateLimited)
//
// Note: the HARD limits (match:join / chat:message / signal:* aka call:*,
// plus the overall per-connection budget — see rateLimit.ts) are NOT
// configurable per-call the way `rl` above is; they disconnect the socket
// on breach regardless of which handler triggered them, so letting
// individual handlers opt out would defeat the point.
export function secureOn<E extends SecuredEventName>(
  io: TypedServer,
  socket: TypedSocket,
  userId: string,
  eventName: E,
  handler: SecureOnHandler<E>,
  options: SecureOnOptions<E> = {}
): void {
  const rl = options.rateLimit || DEFAULT_RATE_LIMITS[eventName as string] || { windowMs: 10_000, max: 20 };

  const defaultReject = (sock: TypedSocket, ackFn: EventAck<E>, message: string) => {
    ackFn({ error: message } as Parameters<EventAck<E>>[0]);
    // Best-effort compatibility with the ad-hoc `${event}:error` /
    // `${event}_failed`-style events handlers used to emit manually. We
    // can't guess every handler's exact event name, so we emit one
    // consistent, additive event any client can opt into listening for,
    // without removing/breaking the handler-specific ones already in place.
    socket.emit('socket:error', { event: eventName as string, error: message });
  };

  // The cast on the listener itself is the one deliberate escape hatch in
  // this file: Socket.IO's own `.on()` overload needs a listener whose type
  // matches `ClientToServerEvents[E]` exactly for a *generic* E, which
  // TypeScript can't verify structurally inside a generic function body.
  // Every caller of secureOn(), and the `handler`/`options` parameters
  // above, stay fully and correctly typed — this cast only affects the
  // internal wiring, not the public API.
  socket.on(eventName, (async (rawPayload: unknown, rawCallback: unknown) => {
    const ack = (typeof rawCallback === 'function' ? rawCallback : () => {}) as EventAck<E>;

    // 1) HARD named-family limit (match:join / chat:message / signal:* aka
    //    call:*) — 80% warns, breach disconnects the socket entirely. This
    //    runs before anything else so a client already over its budget for
    //    this event family can't still slip a validated action through.
    const named = await checkNamedLimit(userId, eventName as string);
    if (named) {
      if (named.warn) {
        socket.emit('warning:rate_limit_approaching', {
          scope: named.limitKey,
          event: eventName as string,
          limit: named.limit,
          remaining: named.remaining,
          windowMs: named.windowMs,
        });
      }
      if (!named.allowed) {
        return disconnectForRateLimit(socket, {
          scope: named.limitKey,
          event: eventName as string,
          limit: named.limit,
          windowMs: named.windowMs,
          message: `Превышен лимит для "${named.limitKey}" (${named.limit}/${Math.round(named.windowMs / 1000)}с), соединение закрыто`,
        });
      }
    }

    // 2) Global cross-event budget (soft) — catches "hop between 5 different
    //    under-the-limit events" abuse that no single per-event check sees.
    if (await isFloodingGlobal(userId)) {
      return (options.onRateLimited || defaultReject)(socket, ack, 'Слишком много действий, притормози немного');
    }

    // 3) Per-event limit (soft), checked both per-socket (fast, catches a
    //    single connection mashing) and per-user (survives reconnects).
    const [socketFlooded, userFlooded] = await Promise.all([
      isFlooding(socket, eventName as string, rl.windowMs, rl.max),
      isFloodingUser(userId, eventName as string, rl.windowMs, rl.max),
    ]);
    if (socketFlooded || userFlooded) {
      return (options.onRateLimited || defaultReject)(socket, ack, 'Слишком часто, подожди немного');
    }

    // 4) Schema validation.
    const { ok, data, error } = validateSocketEvent(eventName, rawPayload ?? {});
    if (!ok) {
      return (options.onInvalid || defaultReject)(socket, ack, error as string);
    }

    try {
      await handler(data as EventData<E>, ack, socket);
    } catch (err: any) {
      // socket.data.log is a child logger tagged with connectionId/socketId/
      // userId (see socketLogger.ts) — no need to repeat those here.
      (socket.data?.log || fallbackLogger).error({ err, event: eventName as string }, 'Socket event handler threw');
      Sentry.captureException(err, { tags: { event: eventName as string, userId } });
      metrics.appErrorsTotal.inc({ source: 'socket' });
      metrics.socketErrorsTotal.inc({ event: eventName as string });
      ack({ error: err.message || 'Внутренняя ошибка' } as Parameters<EventAck<E>>[0]);
    }
  }) as any);
}

// ── disconnectForRateLimit ──────────────────────────────────────────────
// Shared by secureOn() (named per-event-family limits) and the overall
// per-connection budget (enforced via socket.onAny() in socket/index.ts).
// Emits `error:rate_limit_exceeded` with enough detail for the client to
// know what it hit, logs it, then closes the connection.
//
// The disconnect is deferred one tick (setImmediate) so the emit above
// actually has a chance to reach the client over the wire before we tear
// the transport down — disconnect(true) closes the underlying connection
// immediately, which can otherwise race the outgoing packet.
function disconnectForRateLimit(
  socket: TypedSocket,
  details: { scope: string; event?: string; limit: number; windowMs: number; message: string }
) {
  socket.emit('error:rate_limit_exceeded', details);
  (socket.data?.log || fallbackLogger).warn({ ...details, socketId: socket.id }, 'Disconnecting socket: rate limit exceeded');
  setImmediate(() => socket.disconnect(true));
}

// ── Connection-level middleware ───────────────────────────────────────────
// Separate from per-event limits above: this throttles how many NEW socket
// connections a single IP can open in a short window, which per-event
// limiters can't do anything about since they only start counting *after*
// a connection (and auth) already succeeded. Protects against connection
// churn / handshake-flood style abuse (incl. auth brute forcing via
// repeated handshakes with different tokens).
const CONNECTION_LIMIT = { windowMs: 60_000, max: 30 }; // 30 new connections/min/IP

// Socket.io doesn't await middleware functions — it just calls fn(socket,
// next) and trusts `next()` to eventually be called. An async function
// works fine here: everything before the first `await` runs synchronously
// as usual, and `next()` still fires exactly once, just after the Redis
// round trip resolves instead of immediately.
async function socketConnectionRateLimiter(socket: TypedSocket, next: (err?: Error) => void) {
  const ip = socket.handshake.address || socket.conn?.remoteAddress || 'unknown';
  if (await isFloodingUser(`ip:${ip}`, 'connect', CONNECTION_LIMIT.windowMs, CONNECTION_LIMIT.max)) {
    return next(new Error('Too many connection attempts, please slow down'));
  }
  next();
}

module.exports = {
  secureOn,
  validateSocketEvent,
  socketConnectionRateLimiter,
  disconnectForRateLimit,
  DEFAULT_RATE_LIMITS,
};

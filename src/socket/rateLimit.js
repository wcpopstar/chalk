// ── Flood guards ─────────────────────────────────────────────────────────
// Two layers:
//
// 1. Per-socket, per-event fixed-window limiter (`isFlooding`) — the
//    original guard. Scoped to a single socket connection + a single event
//    key. Cheap and fine-grained, but has a real weakness: it resets the
//    moment the socket reconnects, so a scripted client can dodge it by
//    just opening a new connection every N seconds.
//
// 2. Per-user limiter (`isFloodingUser`) — keyed on the authenticated
//    userId instead of socket.id, so it survives reconnects/multiple tabs.
//    This is what closes the reconnect-to-reset hole above, and it's also
//    used as a *global* "all events combined" budget (see
//    GLOBAL_EVENT_BUDGET below) so someone can't dodge a single event's
//    limit by round-robining between chat:message / chat:gif / chat:voice /
//    etc. — each individually under its own limit, but adding up to a flood.
const buckets = new Map();     // `${socket.id}:${key}` -> { start, count }
const userBuckets = new Map(); // `${userId}:${key}`     -> { start, count }

function checkBucket(map, bucketKey, windowMs, max) {
  const now = Date.now();
  const bucket = map.get(bucketKey);
  if (!bucket || now - bucket.start > windowMs) {
    map.set(bucketKey, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

// Returns true when the caller is OVER the limit and should be rejected.
function isFlooding(socket, key, windowMs, max) {
  return checkBucket(buckets, socket.id + ':' + key, windowMs, max);
}

// Same shape as isFlooding, but keyed by userId — survives socket reconnects.
function isFloodingUser(userId, key, windowMs, max) {
  return checkBucket(userBuckets, userId + ':' + key, windowMs, max);
}

// Global "all socket events combined" budget per user, independent of which
// specific event they're spamming. Deliberately generous — this is a safety
// net against event-hopping, not the primary per-event limit.
const GLOBAL_EVENT_BUDGET = { windowMs: 10_000, max: 120 };
function isFloodingGlobal(userId) {
  return isFloodingUser(userId, '__global__', GLOBAL_EVENT_BUDGET.windowMs, GLOBAL_EVENT_BUDGET.max);
}

// Call this from the 'disconnect' handler so the per-socket map doesn't grow
// forever. (userBuckets deliberately outlive the socket — that's the point —
// so they're swept by time instead; see below.)
function clearRateLimitsFor(socket) {
  for (const key of buckets.keys()) {
    if (key.startsWith(socket.id + ':')) buckets.delete(key);
  }
}

// Periodic sweep for both maps: drop any bucket whose window closed a while
// ago. Without this, userBuckets grows for as long as the process runs
// (entries are keyed by userId, not socket.id, so disconnect can't clean
// them up), and a busy server could otherwise accumulate one stale entry per
// user/event pair indefinitely.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
function sweep(map) {
  const now = Date.now();
  for (const [key, bucket] of map.entries()) {
    if (now - bucket.start > STALE_AFTER_MS) map.delete(key);
  }
}
const sweepInterval = setInterval(() => {
  sweep(buckets);
  sweep(userBuckets);
}, SWEEP_INTERVAL_MS);
sweepInterval.unref?.(); // don't keep the process alive just for this

module.exports = { isFlooding, isFloodingUser, isFloodingGlobal, clearRateLimitsFor };

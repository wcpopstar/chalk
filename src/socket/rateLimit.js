// ── Per-socket flood guard ──────────────────────────────────────────────────
// Fixed-window rate limiter scoped to a single socket connection. Used to stop
// someone from mashing a button (or scripting an emit loop) and hammering the
// database / other users' clients — e.g. sending 100 messages/sec, swiping
// nonstop, or spamming call invites.
const buckets = new Map(); // `${socket.id}:${key}` -> { start, count }

// Returns true when the caller is OVER the limit and should be rejected.
function isFlooding(socket, key, windowMs, max) {
  const now = Date.now();
  const bucketKey = socket.id + ':' + key;
  const bucket = buckets.get(bucketKey);
  if (!bucket || now - bucket.start > windowMs) {
    buckets.set(bucketKey, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

// Call this from the 'disconnect' handler so the map doesn't grow forever.
function clearRateLimitsFor(socket) {
  for (const key of buckets.keys()) {
    if (key.startsWith(socket.id + ':')) buckets.delete(key);
  }
}

module.exports = { isFlooding, clearRateLimitsFor };

const { redis } = require('./redisClient');

/**
 * Matchmaking queues, now stored in Redis instead of in-process arrays.
 *
 * Queue entry shape (unchanged, JSON-serialized as the hash value):
 * {
 *   userId, socketId, gameId, mode ('solo'|'group'), squadSize,
 *   rank, languages, region, joinedAt
 * }
 *
 * Redis layout:
 *   chalk:queue:solo    hash   userId -> JSON entry   (max 2 players/match)
 *   chalk:queue:group   hash   userId -> JSON entry   (up to 5 players/match)
 *
 * A hash keyed by userId gives us "dedupe on enqueue" and O(1) dequeue for
 * free — HSET/HDEL by userId does exactly what the old findIndex+splice did.
 *
 * The compatibility-scoring / greedy-grouping logic is O(n^2) over the
 * whole queue and needs the full queue in memory to run at all, so it's
 * unchanged: we HGETALL the queue into an array, run the same pure
 * functions, then HDEL whoever got matched.
 *
 * IMPORTANT — multi-instance correctness:
 * `startMatchLoop` in match.js calls runMatchCycle() once a second from
 * EVERY server instance. If two instances both HGETALL the same queue at
 * the same moment, they could both select and try to match the same
 * waiting player. To prevent that, runMatchCycle() takes a short-lived
 * Redis lock (SET NX PX) before touching the queues, so only one instance
 * in the whole cluster actually runs a match cycle at any given tick.
 */

const NS = 'chalk';
const QUEUE_KEYS = {
  solo: `${NS}:queue:solo`,
  group: `${NS}:queue:group`,
};

const LOCK_KEY = `${NS}:matchloop:lock`;
const LOCK_TTL_MS = 900; // < the 1000ms tick interval in match.js, so the lock never outlives a cycle

// Time after which we relax matching criteria (ms)
const RELAX_AFTER = 15_000;

async function acquireMatchLoopLock() {
  const ok = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  return ok === 'OK';
}

// ── Add player to queue ──────────────────────────────────────────────────
async function enqueue(entry) {
  const key = QUEUE_KEYS[entry.mode];
  if (!key) throw new Error(`Unknown matchmaking mode: ${entry.mode}`);
  // HSET on an existing field overwrites it — same "replace stale entry" behavior
  // the old findIndex+splice+push gave us.
  await redis.hset(key, entry.userId, JSON.stringify({ ...entry, joinedAt: Date.now() }));
}

// ── Remove player from queue ─────────────────────────────────────────────
async function dequeue(userId) {
  const removedCounts = await Promise.all(
    Object.values(QUEUE_KEYS).map((key) => redis.hdel(key, userId))
  );
  return removedCounts.some((n) => n > 0);
}

async function loadQueue(mode) {
  const raw = await redis.hgetall(QUEUE_KEYS[mode]);
  return Object.values(raw).map((v) => JSON.parse(v));
}

async function removeFromQueue(mode, userIds) {
  if (!userIds.length) return;
  await redis.hdel(QUEUE_KEYS[mode], ...userIds);
}

// ── Score compatibility between two entries (higher = better match) ──────
// Pure function, unchanged from the in-memory version.
function compatibility(a, b) {
  let score = 0;
  const wait = Math.min(Date.now() - a.joinedAt, Date.now() - b.joinedAt);
  const relaxed = wait > RELAX_AFTER;

  // Same game is required
  if (a.gameId !== b.gameId) return -1;

  // Region
  if (a.region && b.region) {
    if (a.region === b.region) score += 30;
    else if (!relaxed) return -1; // strict mode: must match region
  }

  // Shared language
  const sharedLang = (a.languages || []).some((l) => (b.languages || []).includes(l));
  if (sharedLang) score += 20;
  else if (!relaxed) return -1;

  // Rank proximity (simple numeric comparison)
  const rankDiff = Math.abs((a.rankScore || 0) - (b.rankScore || 0));
  if (rankDiff === 0) score += 30;
  else if (rankDiff === 1) score += 15;
  else if (rankDiff > 2 && !relaxed) return -1;

  return score;
}

// ── Try to form a solo match (2 players) ────────────────────────────────
async function tryMatchSolo() {
  const q = await loadQueue('solo');
  if (q.length < 2) return null;

  let bestScore = -1;
  let bestPair = null;

  for (let i = 0; i < q.length; i++) {
    for (let j = i + 1; j < q.length; j++) {
      const score = compatibility(q[i], q[j]);
      if (score > bestScore) {
        bestScore = score;
        bestPair = [q[i], q[j]];
      }
    }
  }

  if (!bestPair) return null;

  await removeFromQueue('solo', bestPair.map((p) => p.userId));
  return bestPair;
}

// ── Try to form a group match (up to squadSize players) ─────────────────
async function tryMatchGroup(squadSize = 4) {
  const all = await loadQueue('group');
  const q = all.filter((e) => e.squadSize === squadSize);
  if (q.length < squadSize) return null;

  // Simple greedy: take the oldest entries that are compatible with each other
  const anchor = q[0];
  const group = [anchor];

  for (const entry of q.slice(1)) {
    if (group.length >= squadSize) break;
    const allCompat = group.every((g) => compatibility(g, entry) >= 0);
    if (allCompat) group.push(entry);
  }

  if (group.length < squadSize) return null;

  await removeFromQueue('group', group.map((p) => p.userId));
  return group;
}

// ── Run one matching cycle (called periodically by Socket handler) ────────
// Only actually runs if this instance wins the cluster-wide lock for this
// tick; otherwise returns no matches so the caller does nothing.
async function runMatchCycle() {
  const gotLock = await acquireMatchLoopLock();
  if (!gotLock) return { soloMatch: null, groupMatch: null };

  const soloMatch = await tryMatchSolo();
  const groupMatch =
    (await tryMatchGroup(5)) ||
    (await tryMatchGroup(4)) ||
    (await tryMatchGroup(3));

  return { soloMatch, groupMatch };
}

async function queueSize() {
  const [solo, group] = await Promise.all([
    redis.hlen(QUEUE_KEYS.solo),
    redis.hlen(QUEUE_KEYS.group),
  ]);
  return { solo, group };
}

module.exports = { enqueue, dequeue, runMatchCycle, queueSize };

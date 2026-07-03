const { redis } = require('../socket/redisClient');
const logger = require('../utils/logger').child({ module: 'matchmakingRedis' });

/**
 * Redis-backed matchmaking queue.
 *
 * Replaces the old fully in-memory implementation (arrays + setInterval)
 * so matchmaking works correctly across multiple server instances behind
 * a load balancer — every instance reads/writes the same Redis queues
 * instead of its own private array.
 *
 * ── Key layout ─────────────────────────────────────────────────────────
 *   chalk:mm:queue:{mode}:{gameId}          SET     userId, ...
 *   chalk:mm:entry:{mode}:{gameId}:{userId} STRING  JSON entry, EX ENTRY_TTL_SEC
 *   chalk:mm:userloc:{userId}               STRING  "{mode}:::{gameId}", EX ENTRY_TTL_SEC
 *   chalk:mm:games                          SET     "{mode}:::{gameId}" for every queue ever touched
 *   chalk:mm:lock                           STRING  cluster-wide lock for a single match tick
 *
 * The queue is partitioned per gameId *and* mode, per the requirement —
 * players are only ever matched against others queued for the same game.
 *
 * Entry data (userId, rankScore, languages, region, squadSize, ...) is
 * stored verbatim as JSON in the entry key, so nothing is lost compared
 * to the old in-memory objects.
 *
 * ── TTL ────────────────────────────────────────────────────────────────
 * Every entry (and its userloc pointer) carries a 10 minute TTL. If a
 * player's client dies without ever sending `match:leave` (crashed tab,
 * lost connection before the disconnect handler runs, etc.) they still
 * fall out of the queue on their own after ENTRY_TTL_SEC — no server
 * process needs to stay alive to enforce it, Redis does it natively.
 * Stale queue-set membership (entry expired but userId still in the SET)
 * is cleaned up lazily whenever the queue is read.
 *
 * ── Multi-instance correctness ────────────────────────────────────────
 * `runMatchCycle()` is meant to be called once a second from every
 * server instance. Before touching any queue it takes a short-lived
 * cluster-wide lock (SET NX PX); only the instance that wins the lock
 * for that tick actually reads/matches/removes players, so two instances
 * can never grab the same waiting player in the same tick.
 *
 * ── Backward compatibility ────────────────────────────────────────────
 * `enqueue`, `dequeue`, `runMatchCycle`, `queueSize` keep the same names
 * and call signatures the old src/socket/matchmaking.js exposed, so
 * existing call sites (src/socket/match.js) keep working unmodified.
 * src/socket/matchmaking.js now simply re-exports this module.
 */

const NS = 'chalk:mm';
const ENTRY_TTL_SEC = 10 * 60; // 10 minutes
const RELAX_AFTER_MS = 15_000; // after this wait, relax region/lang/rank strictness
const LOCK_KEY = `${NS}:lock`;
const LOCK_TTL_MS = 900; // < the 1s tick interval, so a lock can never outlive a cycle
const LOC_SEP = ':::';

// ── Key helpers ───────────────────────────────────────────────────────────
const queueSetKey = (mode, gameId) => `${NS}:queue:${mode}:${gameId}`;
const entryKey = (mode, gameId, userId) => `${NS}:entry:${mode}:${gameId}:${userId}`;
const userLocKey = (userId) => `${NS}:userloc:${userId}`;
const gamesIndexKey = () => `${NS}:games`;

const encodeLoc = (mode, gameId) => `${mode}${LOC_SEP}${gameId}`;
const decodeLoc = (loc) => {
  const [mode, gameId] = loc.split(LOC_SEP);
  return { mode, gameId };
};

// ── Cluster-wide lock for a single match tick ───────────────────────────
async function acquireMatchLoopLock() {
  const ok = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  return ok === 'OK';
}

// ── Remove a user's queue entry no matter which mode/gameId it's in ────
async function removeUserEverywhere(userId) {
  const loc = await redis.get(userLocKey(userId));
  if (!loc) return false;

  const { mode, gameId } = decodeLoc(loc);
  const pipeline = redis.pipeline();
  pipeline.srem(queueSetKey(mode, gameId), userId);
  pipeline.del(entryKey(mode, gameId, userId));
  pipeline.del(userLocKey(userId));
  await pipeline.exec();
  return true;
}

// ── Add player to queue ──────────────────────────────────────────────────
// entry must include userId, mode ('solo'|'group'), gameId. Everything else
// (socketId, rankScore, rank, languages, region, squadSize, ...) is stored
// as-is so consumers can read it back untouched.
async function enqueue(entry) {
  const { userId, mode, gameId } = entry || {};
  if (!userId) throw new Error('matchmakingRedis.enqueue: userId is required');
  if (mode !== 'solo' && mode !== 'group') {
    throw new Error(`matchmakingRedis.enqueue: unknown mode "${mode}"`);
  }
  if (!gameId) throw new Error('matchmakingRedis.enqueue: gameId is required');

  // If the player was already queued (possibly for a different game/mode —
  // e.g. they backed out and picked a new game), drop the stale entry first.
  // This mirrors the old "replace stale entry" behavior of findIndex+splice.
  await removeUserEverywhere(userId);

  const loc = encodeLoc(mode, gameId);
  const payload = JSON.stringify({ ...entry, joinedAt: Date.now() });

  const pipeline = redis.pipeline();
  pipeline.set(entryKey(mode, gameId, userId), payload, 'EX', ENTRY_TTL_SEC);
  pipeline.sadd(queueSetKey(mode, gameId), userId);
  pipeline.set(userLocKey(userId), loc, 'EX', ENTRY_TTL_SEC);
  pipeline.sadd(gamesIndexKey(), loc);
  await pipeline.exec();
}

// ── Remove player from queue (any mode/game) ─────────────────────────────
async function dequeue(userId) {
  return removeUserEverywhere(userId);
}

// ── Load all live entries for one mode+gameId queue, cleaning up any
//    membership whose entry already expired (TTL) as we go ──────────────
async function loadQueue(mode, gameId) {
  const setKey = queueSetKey(mode, gameId);
  const userIds = await redis.smembers(setKey);
  if (!userIds.length) return [];

  const raws = await redis.mget(userIds.map((id) => entryKey(mode, gameId, id)));

  const entries = [];
  const staleIds = [];
  raws.forEach((raw, i) => {
    if (raw) {
      try {
        entries.push(JSON.parse(raw));
      } catch (err) {
        logger.warn({ err, userId: userIds[i] }, 'Dropping unparsable queue entry');
        staleIds.push(userIds[i]);
      }
    } else {
      staleIds.push(userIds[i]); // TTL-expired, membership is now stale
    }
  });

  if (staleIds.length) await redis.srem(setKey, ...staleIds);

  return entries;
}

// ── Remove matched players from a specific mode+gameId queue ────────────
async function removeMatched(mode, gameId, userIds) {
  if (!userIds.length) return;
  const pipeline = redis.pipeline();
  pipeline.srem(queueSetKey(mode, gameId), ...userIds);
  for (const userId of userIds) {
    pipeline.del(entryKey(mode, gameId, userId));
    pipeline.del(userLocKey(userId));
  }
  await pipeline.exec();
}

// ── Score compatibility between two entries (higher = better match) ──────
// Pure function, unchanged from the previous in-memory/Redis-hash version.
function compatibility(a, b) {
  let score = 0;
  const wait = Math.min(Date.now() - a.joinedAt, Date.now() - b.joinedAt);
  const relaxed = wait > RELAX_AFTER_MS;

  // Queues are already partitioned per gameId, but keep this as a defensive
  // guard in case callers ever mix entries from different sources.
  if (a.gameId !== b.gameId) return -1;

  if (a.region && b.region) {
    if (a.region === b.region) score += 30;
    else if (!relaxed) return -1;
  }

  const sharedLang = (a.languages || []).some((l) => (b.languages || []).includes(l));
  if (sharedLang) score += 20;
  else if (!relaxed) return -1;

  const rankDiff = Math.abs((a.rankScore || 0) - (b.rankScore || 0));
  if (rankDiff === 0) score += 30;
  else if (rankDiff === 1) score += 15;
  else if (rankDiff > 2 && !relaxed) return -1;

  return score;
}

// ── Try to form a solo match (2 players) within one gameId queue ────────
async function tryMatchSolo(gameId) {
  const q = await loadQueue('solo', gameId);
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

  await removeMatched('solo', gameId, bestPair.map((p) => p.userId));
  return bestPair;
}

// ── Try to form a group match (squadSize players) within one gameId queue
async function tryMatchGroup(gameId, squadSize) {
  const all = await loadQueue('group', gameId);
  const q = all.filter((e) => e.squadSize === squadSize);
  if (q.length < squadSize) return null;

  const anchor = q[0];
  const group = [anchor];

  for (const entry of q.slice(1)) {
    if (group.length >= squadSize) break;
    const allCompat = group.every((g) => compatibility(g, entry) >= 0);
    if (allCompat) group.push(entry);
  }

  if (group.length < squadSize) return null;

  await removeMatched('group', gameId, group.map((p) => p.userId));
  return group;
}

// ── All (mode, gameId) queues that have ever had a player enqueued ──────
async function activeQueues() {
  const locs = await redis.smembers(gamesIndexKey());
  return locs.map(decodeLoc);
}

// ── Run one matching cycle across every game/mode queue ──────────────────
// Only actually does work if this instance wins the cluster-wide lock for
// this tick; otherwise it's a no-op so exactly one instance in the fleet
// processes any given tick.
//
// Pass `io` to have this function emit `match:found` to each matched
// participant's socket directly (removeFromQueue + emit, as requested).
// Callers that need richer match handling (persisting match history,
// creating a call room, enriching with profile data — see
// src/socket/match.js) can omit `io` and use the returned matches instead,
// exactly like before.
async function runMatchCycle(io) {
  const gotLock = await acquireMatchLoopLock();
  if (!gotLock) return { soloMatch: null, groupMatch: null, matches: [] };

  const queues = await activeQueues();
  const matches = [];
  let soloMatch = null; // first solo match this tick — kept for backward compat
  let groupMatch = null; // first group match this tick — kept for backward compat

  for (const { mode, gameId } of queues) {
    if (mode === 'solo') {
      const pair = await tryMatchSolo(gameId);
      if (pair) {
        matches.push({ mode, gameId, participants: pair });
        if (!soloMatch) soloMatch = pair;
      }
    } else if (mode === 'group') {
      for (const squadSize of [5, 4, 3]) {
        const group = await tryMatchGroup(gameId, squadSize);
        if (group) {
          matches.push({ mode, gameId, participants: group });
          if (!groupMatch) groupMatch = group;
          break; // one match per gameId per tick is enough, same as before
        }
      }
    }
  }

  if (io && matches.length) {
    for (const match of matches) {
      const payload = { mode: match.mode, gameId: match.gameId, participants: match.participants };
      for (const participant of match.participants) {
        io.to(participant.socketId).emit('match:found', payload);
      }
    }
    logger.info({ count: matches.length }, 'Match cycle emitted match:found');
  }

  return { soloMatch, groupMatch, matches };
}

// ── Queue size, for monitoring / UI ──────────────────────────────────────
// queueSize()                -> { solo, group } totals across all games (old shape, back-compat)
// queueSize(mode, gameId)    -> number, size of that one queue
async function queueSize(mode, gameId) {
  if (mode && gameId) {
    return redis.scard(queueSetKey(mode, gameId));
  }

  const queues = await activeQueues();
  const sizes = await Promise.all(
    queues.map(async (q) => ({ ...q, size: await redis.scard(queueSetKey(q.mode, q.gameId)) }))
  );

  const totals = { solo: 0, group: 0 };
  for (const q of sizes) totals[q.mode] = (totals[q.mode] || 0) + q.size;

  return { ...totals, byQueue: sizes.filter((q) => q.size > 0) };
}

module.exports = {
  enqueue,
  dequeue,
  runMatchCycle,
  queueSize,
  // explicit alias matching the requirement wording ("посмотреть размер очереди")
  getQueueSize: queueSize,
};

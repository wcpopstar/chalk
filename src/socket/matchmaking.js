/**
 * In-memory matchmaking queues.
 * In production you'd back this with Redis for multi-server support.
 *
 * Queue entry shape:
 * {
 *   userId, socketId, gameId, mode ('solo'|'group'), squadSize,
 *   rank, languages, region, joinedAt
 * }
 */

const queues = {
  solo:  [], // max 2 players per match
  group: [], // up to 5 players per match
};

// Time after which we relax matching criteria (ms)
const RELAX_AFTER = 15_000;

// ── Add player to queue ──────────────────────────────────────────────────
function enqueue(entry) {
  const q = queues[entry.mode];
  // Prevent duplicate entries
  const idx = q.findIndex(e => e.userId === entry.userId);
  if (idx !== -1) q.splice(idx, 1);
  q.push({ ...entry, joinedAt: Date.now() });
}

// ── Remove player from queue ─────────────────────────────────────────────
function dequeue(userId) {
  for (const mode of Object.keys(queues)) {
    const idx = queues[mode].findIndex(e => e.userId === userId);
    if (idx !== -1) {
      queues[mode].splice(idx, 1);
      return true;
    }
  }
  return false;
}

// ── Score compatibility between two entries (higher = better match) ──────
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
  const sharedLang = (a.languages || []).some(l => (b.languages || []).includes(l));
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
function tryMatchSolo() {
  const q = queues.solo;
  if (q.length < 2) return null;

  let bestScore = -1;
  let bestPair  = null;

  for (let i = 0; i < q.length; i++) {
    for (let j = i + 1; j < q.length; j++) {
      const score = compatibility(q[i], q[j]);
      if (score > bestScore) {
        bestScore = score;
        bestPair  = [q[i], q[j]];
      }
    }
  }

  if (!bestPair) return null;

  // Remove matched players from queue
  for (const p of bestPair) {
    const idx = q.findIndex(e => e.userId === p.userId);
    if (idx !== -1) q.splice(idx, 1);
  }

  return bestPair;
}

// ── Try to form a group match (up to squadSize players) ─────────────────
function tryMatchGroup(squadSize = 4) {
  const q = queues.group.filter(e => e.squadSize === squadSize);
  if (q.length < squadSize) return null;

  // Simple greedy: take the oldest entries that are compatible with each other
  const anchor = q[0];
  const group  = [anchor];

  for (const entry of q.slice(1)) {
    if (group.length >= squadSize) break;
    const allCompat = group.every(g => compatibility(g, entry) >= 0);
    if (allCompat) group.push(entry);
  }

  if (group.length < squadSize) return null;

  // Remove from queue
  for (const p of group) {
    const idx = queues.group.findIndex(e => e.userId === p.userId);
    if (idx !== -1) queues.group.splice(idx, 1);
  }

  return group;
}

// ── Run one matching cycle (called periodically by Socket handler) ────────
function runMatchCycle() {
  const soloMatch  = tryMatchSolo();
  const groupMatch =
    tryMatchGroup(5) ||
    tryMatchGroup(4) ||
    tryMatchGroup(3);

  return { soloMatch, groupMatch };
}

function queueSize() {
  return { solo: queues.solo.length, group: queues.group.length };
}

module.exports = { enqueue, dequeue, runMatchCycle, queueSize };

export {};
// ── Access-token blacklist ───────────────────────────────────────────────────
// Access tokens are short-lived JWTs (15 min) identified by a `jti` claim.
// "Revoking" one just means remembering its jti until the token would have
// expired anyway — after that, JWT expiry makes the blacklist entry moot,
// so we can safely forget it.
//
// This is in-memory (per-process) storage — fine for a single Node instance,
// which is what this app runs as today. The day this runs behind more than
// one instance, swap the three methods below for Redis:
//   revoke(jti, exp)   -> SETEX jti <ttlSeconds> "1"
//   isRevoked(jti)     -> EXISTS jti
//   (sweep becomes unnecessary — Redis expires keys itself)
// Nothing in middleware/auth.js or socket/authenticate.js needs to change;
// they only call revoke()/isRevoked() on this module.
class TokenBlacklist {
  store: Map<string, number>;
  _sweepTimer: NodeJS.Timeout;

  constructor() {
    this.store = new Map(); // jti -> epoch ms after which the entry is dead weight
    this._sweepTimer = setInterval(() => this._sweep(), 5 * 60 * 1000);
    this._sweepTimer.unref?.();
  }

  // expiresAtMs: when the underlying JWT itself expires — no point keeping
  // the blacklist entry around any longer than that.
  revoke(jti: any, expiresAtMs: any) {
    if (!jti) return;
    const ttl = Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 15 * 60 * 1000;
    this.store.set(jti, ttl);
  }

  isRevoked(jti: any) {
    if (!jti) return false;
    return this.store.has(jti);
  }

  _sweep() {
    const now = Date.now();
    for (const [jti, exp] of this.store) {
      if (exp <= now) this.store.delete(jti);
    }
  }
}

module.exports = new TokenBlacklist();

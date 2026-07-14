export {};

// ── FakeRedis ────────────────────────────────────────────────────────────
// A minimal, in-memory stand-in for the subset of the ioredis API this
// project actually uses (see: grep -rohE "redis\.[a-zA-Z]+\(" src/). It is
// NOT a general-purpose Redis emulator — no encodings/edge cases beyond
// what src/socket/state.ts, src/services/matchmakingRedis.ts, and
// src/socket/rateLimiter.ts rely on.
//
// Supports: get/set (EX/PX/NX), del, exists, hset/hget/hdel/hlen/hexists,
// sadd/srem/smembers/scard, mget, eval (special-cased for the one GETDEL
// Lua script state.ts actually uses), pipeline(), duplicate() with
// watch/multi/exec (optimistic-locking semantics good enough for
// single-process tests), AND defineCommand()/a minimal sorted-set
// implementation — added specifically to support rateLimiter.ts's
// slidingWindowCheck custom command (see below), since that file calls
// `redis.defineCommand('slidingWindowCheck', {...})` at module load time;
// without this, simply requiring any socket/*.ts module (which all
// transitively require rateLimit.ts) would throw immediately in tests.
class FakeRedis {
  store: any;
  _version: any;
  _keyVersions: any;
  _commands: any;

  constructor() {
    // key -> { type: 'string'|'hash'|'set'|'zset', value, expiresAt: number|null }
    this.store = new Map();
    this._version = 0; // bumped on every write, used for WATCH
    this._keyVersions = new Map(); // key -> version at last write
    this._commands = new Map(); // name -> { numberOfKeys, lua } (see defineCommand)
  }

  // ── internals ────────────────────────────────────────────────────────
  _touch(key: any) {
    this._version += 1;
    this._keyVersions.set(key, this._version);
  }

  _entry(key: any) {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && Date.now() > e.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  _parseSetArgs(args: any) {
    // Mirrors the subset of ioredis' set(key, value, ...opts) signature
    // actually used in this codebase: 'EX' n | 'PX' n | 'NX'.
    let ex = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'EX') { ex = Number(args[++i]) * 1000; }
      else if (a === 'PX') { ex = Number(args[++i]); }
      else if (a === 'NX') { nx = true; }
    }
    return { ex, nx };
  }

  // ── strings ──────────────────────────────────────────────────────────
  async get(key: any) {
    const e = this._entry(key);
    return e && e.type === 'string' ? e.value : null;
  }

  async set(key: any, value: any, ...rest: any[]) {
    const { ex, nx } = this._parseSetArgs(rest);
    if (nx && this._entry(key) !== undefined) return null; // NX: key already exists
    this.store.set(key, { type: 'string', value: String(value), expiresAt: ex ? Date.now() + ex : null });
    this._touch(key);
    return 'OK';
  }

  async del(...keys: any[]) {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) { n++; this._touch(k); }
    return n;
  }

  async exists(...keys: any[]) {
    let n = 0;
    for (const k of keys) if (this._entry(k) !== undefined) n++;
    return n;
  }

  async mget(keys: any) {
    return keys.map((k: any) => {
      const e = this._entry(k);
      return e && e.type === 'string' ? e.value : null;
    });
  }

  async pexpire(key: any, ms: any) {
    const e = this._entry(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + Number(ms);
    this._touch(key);
    return 1;
  }

  async expire(key: any, seconds: any) {
    return this.pexpire(key, Number(seconds) * 1000);
  }

  async ttl(key: any) {
    const e = this._entry(key);
    if (!e) return -2;                 // key doesn't exist
    if (e.expiresAt === null) return -1; // no expiry set
    return Math.ceil((e.expiresAt - Date.now()) / 1000);
  }

  async incr(key: any) {
    const e = this._entry(key);
    const next = (e && e.type === 'string' ? Number(e.value) || 0 : 0) + 1;
    this.store.set(key, { type: 'string', value: String(next), expiresAt: e ? e.expiresAt : null });
    this._touch(key);
    return next;
  }

  // ── hashes ───────────────────────────────────────────────────────────
  async hset(key: any, field: any, value: any) {
    let e = this._entry(key);
    if (!e) { e = { type: 'hash', value: new Map(), expiresAt: null }; this.store.set(key, e); }
    const isNew = !e.value.has(field);
    e.value.set(field, String(value));
    this._touch(key);
    return isNew ? 1 : 0;
  }

  async hget(key: any, field: any) {
    const e = this._entry(key);
    return e && e.type === 'hash' ? (e.value.has(field) ? e.value.get(field) : null) : null;
  }

  async hgetall(key: any) {
    const e = this._entry(key);
    if (!e || e.type !== 'hash') return {};
    return Object.fromEntries(e.value.entries());
  }

  async hdel(key: any, field: any) {
    const e = this._entry(key);
    if (!e || e.type !== 'hash' || !e.value.has(field)) return 0;
    e.value.delete(field);
    this._touch(key);
    return 1;
  }

  async hlen(key: any) {
    const e = this._entry(key);
    return e && e.type === 'hash' ? e.value.size : 0;
  }

  async hexists(key: any, field: any) {
    const e = this._entry(key);
    return e && e.type === 'hash' && e.value.has(field) ? 1 : 0;
  }

  // ── sets ─────────────────────────────────────────────────────────────
  async sadd(key: any, ...members: any[]) {
    let e = this._entry(key);
    if (!e) { e = { type: 'set', value: new Set(), expiresAt: null }; this.store.set(key, e); }
    let added = 0;
    for (const m of members) if (!e.value.has(m)) { e.value.add(m); added++; }
    if (added) this._touch(key);
    return added;
  }

  async srem(key: any, ...members: any[]) {
    const e = this._entry(key);
    if (!e || e.type !== 'set') return 0;
    let removed = 0;
    for (const m of members) if (e.value.delete(m)) removed++;
    if (removed) this._touch(key);
    return removed;
  }

  async smembers(key: any) {
    const e = this._entry(key);
    return e && e.type === 'set' ? [...e.value] : [];
  }

  async scard(key: any) {
    const e = this._entry(key);
    return e && e.type === 'set' ? e.value.size : 0;
  }

  // ── sorted sets ──────────────────────────────────────────────────────
  // Just enough for rateLimiter.ts's slidingWindowCheck implementation
  // below (which is what actually exercises these) — member -> score map,
  // no ranking/range commands beyond what that algorithm needs.
  _zentry(key: any) {
    let e = this._entry(key);
    if (!e) { e = { type: 'zset', value: new Map(), expiresAt: null }; this.store.set(key, e); }
    return e;
  }

  async zadd(key: any, score: any, member: any) {
    const e = this._zentry(key);
    const isNew = !e.value.has(member);
    e.value.set(member, Number(score));
    this._touch(key);
    return isNew ? 1 : 0;
  }

  async zremrangebyscore(key: any, min: any, max: any) {
    const e = this._entry(key);
    if (!e || e.type !== 'zset') return 0;
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    let removed = 0;
    for (const [member, score] of e.value) {
      if (score >= lo && score <= hi) { e.value.delete(member); removed++; }
    }
    if (removed) this._touch(key);
    return removed;
  }

  async zcard(key: any) {
    const e = this._entry(key);
    return e && e.type === 'zset' ? e.value.size : 0;
  }

  // ── Lua eval — special-cased for state.ts's GETDEL_SCRIPT only ───────
  async eval(script: any, _numKeys: any, ...keysAndArgs: any[]) {
    if (script.includes("redis.call('GET'") && script.includes("redis.call('DEL'")) {
      const key = keysAndArgs[0];
      const v = await this.get(key);
      if (v !== null) await this.del(key);
      return v;
    }
    throw new Error('FakeRedis.eval: unrecognized script — extend the fake to support it');
  }

  // ── defineCommand — special-cased for rateLimiter.ts's slidingWindowCheck ──
  // Real ioredis compiles `lua` into a genuine custom command via Redis'
  // own EVAL/SCRIPT LOAD. Re-implementing a Lua interpreter here would be
  // its own project, so instead — same philosophy as eval() above — this
  // recognizes the ONE custom command this codebase actually registers (by
  // name) and re-implements its exact semantics natively in JS against
  // this same in-memory store. See src/socket/rateLimiter.ts for the
  // authoritative Lua version these two must stay in sync with.
  defineCommand(name: any, { numberOfKeys }: any = {}) {
    this._commands.set(name, { numberOfKeys });

    if (name === 'slidingWindowCheck') {
      (this as any)[name] = async (zkey: any, warnkey: any, now: any, window: any, limit: any, warnThreshold: any, member: any) => {
        now = Number(now); window = Number(window); limit = Number(limit); warnThreshold = Number(warnThreshold);

        await this.zremrangebyscore(zkey, '-inf', now - window);
        let count = await this.zcard(zkey);

        if (count >= limit) return [count, 0, 0];

        await this.zadd(zkey, now, member);
        await this.pexpire(zkey, window);
        count += 1;

        let warn = 0;
        if (count >= warnThreshold) {
          const set = await this.set(warnkey, '1', 'NX', 'PX', window);
          if (set) warn = 1;
        }
        return [count, 1, warn];
      };
      return;
    }

    // Any other custom command this codebase might register in the future
    // isn't supported yet — fail loudly at call time rather than silently
    // returning undefined, so a test surfaces "extend the fake" instead of
    // a confusing downstream assertion failure.
    (this as any)[name] = async () => {
      throw new Error(`FakeRedis.defineCommand: "${name}" is registered but not implemented — extend fakeRedis.ts to support it`);
    };
  }

  // ── pipeline ─────────────────────────────────────────────────────────
  pipeline() {
    const ops: any[] = [];
    const self = this;
    const p: any = {};
    for (const cmd of ['set', 'sadd', 'srem', 'del', 'hset', 'hdel']) {
      p[cmd] = (...args: any[]) => { ops.push([cmd, args]); return p; };
    }
    p.exec = async () => {
      const results: any[] = [];
      for (const [cmd, args] of ops) {
        try { results.push([null, await (self as any)[cmd](...args)]); } catch (err) { results.push([err, null]); }
      }
      return results;
    };
    return p;
  }

  // ── duplicate() + WATCH/MULTI/EXEC ────────────────────────────────────
  // Good enough for single-process tests: exec() returns null (mirroring
  // real ioredis' "a watched key changed" signal) only if something else
  // wrote to a watched key after watch() was called.
  duplicate() {
    const self = this;
    let watchedSnapshot: any = null; // key -> version at watch() time

    return {
      watch: async (...keys: any[]) => {
        watchedSnapshot = new Map(keys.map((k) => [k, self._keyVersions.get(k) || 0]));
      },
      hget: (...args: any[]) => self.hget(...(args as [any, any])),
      multi: () => {
        const ops: any[] = [];
        const tx: any = {};
        for (const cmd of ['hset', 'hdel', 'set', 'sadd', 'srem', 'del']) {
          tx[cmd] = (...args: any[]) => { ops.push([cmd, args]); return tx; };
        }
        tx.exec = async () => {
          if (watchedSnapshot) {
            for (const [key, version] of watchedSnapshot) {
              if ((self._keyVersions.get(key) || 0) !== version) return null; // conflict
            }
          }
          const results: any[] = [];
          for (const [cmd, args] of ops) results.push(await (self as any)[cmd](...args));
          return results;
        };
        return tx;
      },
      disconnect: () => {},
    };
  }

  async ping() { return 'PONG'; }
  async quit() { return 'OK'; }

  // ── test helper (not part of the ioredis API) ─────────────────────────
  // Lets a test simulate "some other server instance/process modified this
  // key concurrently" for exercising updateRoom()'s WATCH-conflict retry.
  _simulateExternalWrite(key: any) {
    this._touch(key);
  }
}

module.exports = { FakeRedis };

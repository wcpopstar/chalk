export {};

// ── FakeSocket ───────────────────────────────────────────────────────────
// Minimal stand-in for a Socket.IO `socket`. Supports exactly what
// secureOn()/register*Handlers() in src/socket/*.ts actually use:
// on()/emit()/join()/leave(), plus a `.log` child-logger stub (secureOn
// logs to socket.log on a thrown handler error) and a `trigger()` helper so
// tests can simulate the client firing an event.
//
// Bypasses secureOn()'s own rate-limit/validation layers only in the sense
// that `.trigger()` calls the registered listener directly — it exercises
// the FULL secureOn()-wrapped handler (see socket/validation.ts), including
// its Redis-backed rate limiting and Zod schema validation, exactly as a
// real client's event would. Tests that want to bypass rate limiting
// entirely should stub socket/redisClient.ts with a fresh FakeRedis per
// test (see test/socket/*.test.ts) so limits don't carry over between
// tests sharing the same socket/user id.
let counter = 0;
class FakeSocket {
  id: any;
  _handlers: any;
  emitted: any;
  rooms: any;
  log: any;
  _io: any;

  constructor(id?: any) {
    this.id = id || `sock-${++counter}`;
    this._handlers = new Map(); // event -> [callback, ...]
    this.emitted = []; // { event, payload }
    this.rooms = new Set([this.id]);
    this.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
  }

  on(event: any, cb: any) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(cb);
    return this;
  }

  // secureOn() also registers a socket.onAny(...) listener (see
  // socket/index.ts's overall per-connection budget) — stored the same way
  // under the special key '__any__' and dispatched by trigger() below.
  onAny(cb: any) {
    if (!this._handlers.has('__any__')) this._handlers.set('__any__', []);
    this._handlers.get('__any__').push(cb);
    return this;
  }

  emit(event: any, payload: any) {
    this.emitted.push({ event, payload });
    return true;
  }

  disconnect(_close?: any) {
    this.emitted.push({ event: '__disconnect__', payload: null });
  }

  join(room: any) {
    this.rooms.add(room);
    if (this._io) {
      if (!this._io._rooms.has(room)) this._io._rooms.set(room, new Set());
      this._io._rooms.get(room).add(this.id);
    }
  }

  leave(room: any) {
    this.rooms.delete(room);
    if (this._io && this._io._rooms.has(room)) this._io._rooms.get(room).delete(this.id);
  }

  // socket.to(room).emit(...) broadcasts to everyone else in `room`
  // (excluding this socket itself) — mirrors real Socket.IO semantics.
  // Requires the socket to have been registered with a FakeIo via
  // io.register(socket), which sets this._io.
  to(target: any) {
    const self = this;
    return {
      emit(event: any, payload: any) {
        if (!self._io) throw new Error('FakeSocket.to(): socket was never registered with a FakeIo — call io.register(socket) first');
        self._io._deliver(target, event, payload, self.id);
      },
    };
  }

  // Simulates the client sending `event` with `payload`, optionally with an
  // ack callback — i.e. what secureOn's registered socket.on(...) listener
  // receives. Also fires any onAny() listeners first, same order Socket.io
  // itself uses. Awaits every handler (they're async).
  async trigger(event: any, payload: any, ack?: any) {
    const anyCbs = this._handlers.get('__any__');
    if (anyCbs) for (const cb of anyCbs) await cb(event, payload);

    const cbs = this._handlers.get(event);
    if (!cbs || !cbs.length) throw new Error(`FakeSocket.trigger: no handler registered for "${event}"`);
    for (const cb of cbs) await cb(payload, ack);
  }

  hasHandler(event: any) {
    return this._handlers.has(event) && this._handlers.get(event).length > 0;
  }
}

// ── FakeIo ───────────────────────────────────────────────────────────────
// Minimal stand-in for the Socket.IO server (`io`) instance, supporting
// io.to(target).emit(...), io.in(target).socketsJoin(room), io.emit(...),
// and delivering to whichever FakeSockets have actually joined a given
// room (registered via register()/socketsJoin()) or match a raw socketId.
function makeFakeIo() {
  const sockets = new Map(); // socketId -> FakeSocket
  const rooms = new Map(); // roomName -> Set<socketId>
  const allEmits: any[] = []; // { target, event, payload } — every io.to(...)/io.emit(...) call, for assertions

  function deliver(target: any, event: any, payload: any, excludeSocketId?: any) {
    allEmits.push({ target, event, payload });
    const direct: any = sockets.get(target);
    if (direct && target !== excludeSocketId) direct.emit(event, payload);
    const members: any = rooms.get(target);
    if (members) {
      for (const sid of members) {
        if (sid === excludeSocketId) continue;
        const s: any = sockets.get(sid);
        if (s) s.emit(event, payload);
      }
    }
  }

  return {
    _sockets: sockets,
    _rooms: rooms,
    _deliver: deliver,
    allEmits,
    register(socket: any) { sockets.set(socket.id, socket); socket._io = this; },
    to(target: any) { return { emit: (event: any, payload: any) => deliver(target, event, payload) }; },
    in(target: any) {
      return {
        socketsJoin: async (room: any) => {
          if (!rooms.has(room)) rooms.set(room, new Set());
          (rooms.get(room) as any).add(target);
          const s: any = sockets.get(target);
          if (s) s.join(room);
        },
      };
    },
    emit(event: any, payload: any) { allEmits.push({ target: 'ALL', event, payload }); },
  };
}

module.exports = { FakeSocket, makeFakeIo };

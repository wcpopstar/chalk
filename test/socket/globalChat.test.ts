export {};
require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { FakeRedis } = require('../helpers/fakeRedis');
const { FakeSocket, makeFakeIo } = require('../helpers/fakeSocket');

// Not present in the original version of this test file — added because
// every socket event now goes through secureOn()'s Redis-backed rate
// limiting (see socket/validation.ts, socket/rateLimit.ts). Without this,
// requiring globalChat.ts would transitively require the REAL
// socket/redisClient.ts and attempt a real network connection.
const fakeRedis = new FakeRedis();
stubModule(require.resolve('../../src/socket/redisClient'), {
  redis: fakeRedis,
  pubClient: fakeRedis,
  subClient: fakeRedis,
  waitForRedisReady: async () => {},
  REDIS_URL: 'redis://fake',
});

const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});

const { registerGlobalChatHandlers } = require('../../src/socket/globalChat');

const FAKE_WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);

function setup(userId: any) {
  const io = makeFakeIo();
  const socket = new FakeSocket();
  io.register(socket);
  socket.join('global');
  registerGlobalChatHandlers(io, socket, userId);
  return { io, socket };
}

describe('socket/globalChat.js', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    supaMock.reset();
  });

  it('global:message saves and broadcasts to everyone in the global room', async () => {
    const { io, socket } = setup('me');
    const other = new FakeSocket();
    io.register(other);
    other.join('global');

    supaMock.enqueue({ data: { id: 'bb000001-0000-4000-8000-000000000001', text: 'hi everyone', type: 'text' }, error: null });

    let ackResult: any;
    await socket.trigger('global:message', { text: 'hi everyone' }, (r: any) => { ackResult = r; });

    assert.deepEqual(ackResult, { ok: true });
    assert.ok(other.emitted.some((e: any) => e.event === 'global:message' && e.payload.text === 'hi everyone'));
    // The sender is also a member of 'global' and DOES receive their own
    // message back via io.to('global') (unlike socket.to(), this isn't
    // self-excluding) — matches real chat UIs that render from the
    // server echo rather than optimistic local insert.
    assert.ok(socket.emitted.some((e: any) => e.event === 'global:message'));
  });

  it('global:gif saves and broadcasts a gif message', async () => {
    const { socket } = setup('me');
    supaMock.enqueue({ data: { id: 'g2', type: 'gif', media_url: 'https://example.com/x.gif' }, error: null });

    let ackResult: any;
    await socket.trigger('global:gif', { gifUrl: 'https://example.com/x.gif' }, (r: any) => { ackResult = r; });

    assert.deepEqual(ackResult, { ok: true });
  });

  it('global:voice uploads and broadcasts a valid voice note', async () => {
    const { io, socket } = setup('me');
    const other = new FakeSocket();
    io.register(other);
    other.join('global');

    supaMock.enqueue({ error: null }); // storage upload
    supaMock.enqueue({ data: { id: 'v1', type: 'voice' }, error: null }); // saveGlobalMessage

    let ackResult: any;
    await socket.trigger('global:voice', { audio: FAKE_WEBM, mime: 'audio/webm', duration: 3.2 }, (r: any) => { ackResult = r; });

    assert.deepEqual(ackResult, { ok: true });
    assert.ok(other.emitted.some((e: any) => e.event === 'global:message' && e.payload.type === 'voice'));
  });

  it('global:edit broadcasts the edited message', async () => {
    const { socket } = setup('me');
    supaMock.enqueue({ data: { id: 'bb000001-0000-4000-8000-000000000001', text: 'edited' }, error: null });

    let ackResult: any;
    await socket.trigger('global:edit', { messageId: 'bb000001-0000-4000-8000-000000000001', text: 'edited' }, (r: any) => { ackResult = r; });

    assert.deepEqual(ackResult, { ok: true });
    assert.ok(socket.emitted.some((e: any) => e.event === 'global:message:edited' && e.payload.text === 'edited'));
  });

  it('global:delete broadcasts a deletion notice', async () => {
    const { socket } = setup('me');
    supaMock.enqueue({ data: { id: 'bb000001-0000-4000-8000-000000000001' }, error: null });

    let ackResult: any;
    await socket.trigger('global:delete', { messageId: 'bb000001-0000-4000-8000-000000000001' }, (r: any) => { ackResult = r; });

    assert.deepEqual(ackResult, { ok: true });
    assert.ok(socket.emitted.some((e: any) => e.event === 'global:message:deleted' && e.payload.messageId === 'bb000001-0000-4000-8000-000000000001'));
  });

  it('acks an error instead of throwing when the DB insert fails', async () => {
    const { socket } = setup('me');
    supaMock.enqueue({ data: null, error: { message: 'insert failed' } });

    let ackResult: any;
    await socket.trigger('global:message', { text: 'hello' }, (r: any) => { ackResult = r; });

    assert.match(ackResult.error, /insert failed/);
  });
});

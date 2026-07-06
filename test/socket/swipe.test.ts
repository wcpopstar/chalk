export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { FakeRedis } = require('../helpers/fakeRedis');
const { FakeSocket, makeFakeIo } = require('../helpers/fakeSocket');

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

const state = require('../../src/socket/state');
const { registerSwipeHandlers } = require('../../src/socket/swipe');

function setup(userId: any) {
  const io = makeFakeIo();
  const socket = new FakeSocket();
  io.register(socket);
  registerSwipeHandlers(io, socket, userId);
  return { io, socket };
}

describe('socket/swipe.js', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    supaMock.reset();
  });

  it('records a left swipe with no further checks', async () => {
    const { socket } = setup('me');
    supaMock.enqueue({ error: null }); // upsert

    await socket.trigger('swipe', { targetUserId: 'other', direction: 'left' });

    assert.equal(socket.emitted.length, 0);
  });

  it('records a right swipe and checks for a mutual match, finding none', async () => {
    const { socket } = setup('me');
    supaMock.enqueue({ error: null }); // upsert
    supaMock.enqueue({ data: null, error: null }); // mutual check -> none

    await socket.trigger('swipe', { targetUserId: 'other', direction: 'right' });

    assert.ok(!socket.emitted.some((e: any) => e.event === 'swipe:match'));
  });

  it('emits swipe:match to both users when a mutual right-swipe is found and the other user is online', async () => {
    const { io, socket } = setup('me');
    const otherSocket = new FakeSocket();
    io.register(otherSocket);
    await state.setOnline('other', otherSocket.id);

    supaMock.enqueue({ error: null }); // upsert
    supaMock.enqueue({ data: { id: 'swipe-row' }, error: null }); // mutual check -> found

    await socket.trigger('swipe', { targetUserId: 'other', direction: 'right' });

    assert.ok(socket.emitted.some((e: any) => e.event === 'swipe:match' && e.payload.with === 'other'));
    assert.ok(otherSocket.emitted.some((e: any) => e.event === 'swipe:match' && e.payload.with === 'me'));
  });

  it('a super swipe also triggers the mutual-match check', async () => {
    const { socket } = setup('me');
    supaMock.enqueue({ error: null }); // upsert
    supaMock.enqueue({ data: { id: 'swipe-row' }, error: null }); // mutual check -> found

    await socket.trigger('swipe', { targetUserId: 'other', direction: 'super' });

    assert.ok(socket.emitted.some((e: any) => e.event === 'swipe:match'));
  });

  it('does not error when the matched other user is offline (just skips their emit)', async () => {
    const { socket } = setup('me');
    // 'other' never calls setOnline() — getOnlineSocket resolves to null.
    supaMock.enqueue({ error: null }); // upsert
    supaMock.enqueue({ data: { id: 'swipe-row' }, error: null }); // mutual check -> found

    await socket.trigger('swipe', { targetUserId: 'other', direction: 'right' });

    assert.ok(socket.emitted.some((e: any) => e.event === 'swipe:match'));
  });
});

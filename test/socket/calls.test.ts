export {};

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
const { registerCallHandlers } = require('../../src/socket/calls');

function setup(userId: any, username: any) {
  const io = makeFakeIo();
  const socket = new FakeSocket();
  io.register(socket);
  registerCallHandlers(io, socket, userId, username || userId);
  return { io, socket };
}

describe('socket/calls.js', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    supaMock.reset();
  });

  describe('call:invite', () => {
    it('fails with call:invite_failed when the target has blocked the caller', async () => {
      const { socket } = setup('alice');
      supaMock.enqueue({ data: [{ id: 'block-row' }], error: null }); // areUsersBlocked -> true

      await socket.trigger('call:invite', { targetUserId: 'bob', roomId: 'room-1' });

      const failed = socket.emitted.find((e: any) => e.event === 'call:invite_failed');
      assert.ok(failed);
      assert.match(failed.payload.reason, /заблокирован/);
    });

    it('fails when the target is offline', async () => {
      const { socket } = setup('alice');
      supaMock.enqueue({ data: [], error: null }); // not blocked
      // bob never called setOnline() -> getOnlineSocket returns null

      await socket.trigger('call:invite', { targetUserId: 'bob', roomId: 'room-1' });

      const failed = socket.emitted.find((e: any) => e.event === 'call:invite_failed');
      assert.ok(failed);
      assert.match(failed.payload.reason, /офлайн/);
    });

    it('sends call:incoming to the target with the caller\'s profile', async () => {
      const { io, socket } = setup('alice', 'Alice');
      const bobSocket = new FakeSocket();
      io.register(bobSocket);
      await state.setOnline('bob', bobSocket.id);

      supaMock.enqueue({ data: [], error: null }); // not blocked
      supaMock.enqueue({ data: { id: 'alice', username: 'Alice', avatar_emoji: '🦊', avatar_url: null }, error: null });

      await socket.trigger('call:invite', { targetUserId: 'bob', roomId: 'room-1' });

      const incoming = bobSocket.emitted.find((e: any) => e.event === 'call:incoming');
      assert.ok(incoming);
      assert.equal(incoming.payload.from.username, 'Alice');
      assert.equal(incoming.payload.roomId, 'room-1');
    });
  });

  describe('call:accept', () => {
    it('ignores an accept with no matching pending invite', async () => {
      const { io, socket } = setup('bob');
      const aliceSocket = new FakeSocket();
      io.register(aliceSocket);
      await state.setOnline('alice', aliceSocket.id);

      await socket.trigger('call:accept', { roomId: 'room-1', inviterId: 'alice' });

      assert.equal(aliceSocket.emitted.length, 0);
    });

    it('creates the room, notifies the inviter, and marks both as call partners', async () => {
      const { io, socket } = setup('bob');
      const aliceSocket = new FakeSocket();
      io.register(aliceSocket);
      await state.setOnline('alice', aliceSocket.id);
      await state.addPendingInvite('room-1', 'bob', 'alice');

      // setUserRoom() x2 (alice, bob) each trigger a friend-status broadcast query.
      supaMock.enqueue({ data: [], error: null });
      supaMock.enqueue({ data: [], error: null });

      await socket.trigger('call:accept', { roomId: 'room-1', inviterId: 'alice' });

      assert.ok(aliceSocket.emitted.some((e: any) => e.event === 'call:accepted' && e.payload.by === 'bob'));
      assert.ok(socket.rooms.has('room-1'));

      const room = await state.getRoom('room-1');
      assert.deepEqual(room.participants.sort(), ['alice', 'bob']);

      assert.equal(await state.wereRecentCallPartners('alice', 'bob'), true);
    });
  });

  describe('call:reject', () => {
    it('notifies the inviter that the invite was rejected', async () => {
      const { io, socket } = setup('bob');
      const aliceSocket = new FakeSocket();
      io.register(aliceSocket);
      await state.setOnline('alice', aliceSocket.id);
      await state.addPendingInvite('room-1', 'bob', 'alice');

      await socket.trigger('call:reject', { roomId: 'room-1', inviterId: 'alice' });

      assert.ok(aliceSocket.emitted.some((e: any) => e.event === 'call:rejected' && e.payload.by === 'bob'));
    });
  });

  describe('call:end', () => {
    it('does nothing if the room does not exist', async () => {
      const { socket } = setup('alice');
      await socket.trigger('call:end', { roomId: 'ghost-room' });
      assert.equal(socket.emitted.length, 0);
    });

    it('notifies participants and tears down the room', async () => {
      const { io, socket } = setup('alice');
      await state.saveRoom('room-1', { participants: ['alice', 'bob'], mode: 'direct' });
      await io.in(socket.id).socketsJoin('room-1'); // alice must be a room member to receive io.to(roomId) emits

      supaMock.enqueue({ data: [], error: null }); // clearUserRoom(alice) friend broadcast
      supaMock.enqueue({ data: [], error: null }); // clearUserRoom(bob) friend broadcast

      await socket.trigger('call:end', { roomId: 'room-1' });

      assert.ok(socket.emitted.some((e: any) => e.event === 'call:ended' && e.payload.by === 'alice'));
      assert.equal(await state.hasRoom('room-1'), false);
    });
  });

  describe('call:request_join / call:join_response', () => {
    it('call:request_join fails when the target is not currently in a call', async () => {
      const { socket } = setup('carol');
      await socket.trigger('call:request_join', { targetUserId: 'bob' });

      const failed = socket.emitted.find((e: any) => e.event === 'call:join_failed');
      assert.ok(failed);
      assert.match(failed.payload.reason, /не в звонке/);
    });

    it('call:request_join notifies every current room participant', async () => {
      const { io, socket } = setup('carol', 'Carol');
      const aliceSocket = new FakeSocket();
      const bobSocket = new FakeSocket();
      io.register(aliceSocket);
      io.register(bobSocket);
      await state.setOnline('alice', aliceSocket.id);
      await state.setOnline('bob', bobSocket.id);
      await state.saveRoom('room-1', { participants: ['alice', 'bob'] });
      supaMock.enqueue({ data: [], error: null }); // setUserRoom's friend broadcast
      await state.setUserRoom(io, 'bob', 'room-1'); // so getUserCurrentRoom('bob') resolves

      supaMock.enqueue({ data: { id: 'carol', username: 'Carol', avatar_emoji: '🐧', avatar_url: null }, error: null });

      await socket.trigger('call:request_join', { targetUserId: 'bob' });

      assert.ok(aliceSocket.emitted.some((e: any) => e.event === 'call:join_requested'));
      const bobReq = bobSocket.emitted.find((e: any) => e.event === 'call:join_requested');
      assert.ok(bobReq);
      assert.equal(bobReq.payload.from.username, 'Carol');
      assert.ok(socket.emitted.some((e: any) => e.event === 'call:join_request_sent'));
    });

    it('call:join_response(accept:false) notifies the requester and does not add them to the room', async () => {
      const { io, socket } = setup('alice'); // alice is the participant approving
      const carolSocket = new FakeSocket();
      io.register(carolSocket);
      await state.setOnline('carol', carolSocket.id);
      await state.saveRoom('room-1', { participants: ['alice', 'bob'] });
      await state.addPendingJoinRequest('room-1', 'carol');

      await socket.trigger('call:join_response', { roomId: 'room-1', requesterId: 'carol', accept: false });

      assert.ok(carolSocket.emitted.some((e: any) => e.event === 'call:join_rejected'));
      const room = await state.getRoom('room-1');
      assert.ok(!room.participants.includes('carol'));
    });

    it('call:join_response(accept:true) adds the requester to the room and notifies everyone', async () => {
      const { io, socket } = setup('alice');
      const carolSocket = new FakeSocket();
      io.register(carolSocket);
      await state.setOnline('carol', carolSocket.id);
      await state.saveRoom('room-1', { participants: ['alice', 'bob'] });
      await state.addPendingJoinRequest('room-1', 'carol');
      await io.in(socket.id).socketsJoin('room-1'); // alice already in the room

      supaMock.enqueue({ data: [], error: null }); // setUserRoom(carol)'s friend broadcast

      await socket.trigger('call:join_response', { roomId: 'room-1', requesterId: 'carol', accept: true });

      const room = await state.getRoom('room-1');
      assert.deepEqual(room.participants.sort(), ['alice', 'bob', 'carol']);
      assert.ok(carolSocket.emitted.some((e: any) => e.event === 'call:join_accepted'));
      assert.ok(carolSocket.rooms.has('room-1'));
    });

    it('ignores a join_response from someone who is not actually a room participant', async () => {
      const { io, socket } = setup('mallory'); // not a participant of room-1
      const carolSocket = new FakeSocket();
      io.register(carolSocket);
      await state.setOnline('carol', carolSocket.id);
      await state.saveRoom('room-1', { participants: ['alice', 'bob'] });
      await state.addPendingJoinRequest('room-1', 'carol');

      await socket.trigger('call:join_response', { roomId: 'room-1', requesterId: 'carol', accept: true });

      const room = await state.getRoom('room-1');
      assert.ok(!room.participants.includes('carol'));
      assert.equal(carolSocket.emitted.length, 0);
    });
  });

  describe('friends:call_status', () => {
    it('acks with in-call info only for friends who are currently in a room', async () => {
      const { io, socket } = setup('me');
      await state.saveRoom('room-1', { participants: ['friend-in-call', 'other'] });

      // setUserRoom(friend-in-call) fires its own internal broadcastCallStatus
      // friends-select query immediately — this must be queued first.
      supaMock.enqueue({ data: [], error: null });
      await state.setUserRoom(io, 'friend-in-call', 'room-1');

      // Now queue the friends:call_status handler's own friends-select query.
      supaMock.enqueue({
        data: [{ user_a: 'me', user_b: 'friend-in-call' }, { user_a: 'friend-idle', user_b: 'me' }],
        error: null,
      });

      let ackResult = null;
      await socket.trigger('friends:call_status', {}, (result: any) => { ackResult = result; });

      assert.ok(ackResult['friend-in-call']);
      assert.equal(ackResult['friend-in-call'].inCall, true);
      assert.ok(!ackResult['friend-idle']);
    });

    it('acks an error via secureOn\'s centralized handling instead of silently swallowing it', async () => {
      // Older behavior (before this handler's own try/catch was removed —
      // see socket/calls.ts) used to catch this locally and ack `{}`,
      // which looked identical to "you have no friends currently in
      // calls" and never reached Sentry/metrics/logs. secureOn() (see
      // socket/validation.ts) now handles it centrally instead, acking a
      // real error the client can actually distinguish from "no friends".
      const { socket } = setup('me');
      supaMock.enqueue(new Error('db exploded'));

      let ackResult: any = 'not called';
      await socket.trigger('friends:call_status', {}, (result: any) => { ackResult = result; });

      assert.match(ackResult.error, /db exploded/);
    });
  });
});

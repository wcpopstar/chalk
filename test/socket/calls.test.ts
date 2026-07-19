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

function setup(userId: any, username?: any) {
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
      const { socket } = setup('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      supaMock.enqueue({ data: [{ id: 'block-row' }], error: null }); // areUsersBlocked -> true

      await socket.trigger('call:invite', { targetUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', roomId: '10000000-0000-4000-8000-000000000001' });

      const failed = socket.emitted.find((e: any) => e.event === 'call:invite_failed');
      assert.ok(failed);
      assert.match(failed.payload.reason, /заблокирован/);
    });

    it('fails when the target is offline', async () => {
      const { socket } = setup('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      supaMock.enqueue({ data: [], error: null }); // not blocked
      // bob never called setOnline() -> getOnlineSocket returns null

      await socket.trigger('call:invite', { targetUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', roomId: '10000000-0000-4000-8000-000000000001' });

      const failed = socket.emitted.find((e: any) => e.event === 'call:invite_failed');
      assert.ok(failed);
      assert.match(failed.payload.reason, /офлайн/);
    });

    it('sends call:incoming to the target with the caller\'s profile', async () => {
      const { io, socket } = setup('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Alice');
      const bobSocket = new FakeSocket();
      io.register(bobSocket);
      await state.setOnline('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bobSocket.id);

      supaMock.enqueue({ data: [], error: null }); // not blocked
      supaMock.enqueue({ data: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'Alice', avatar_emoji: '🦊', avatar_url: null }, error: null });

      await socket.trigger('call:invite', { targetUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', roomId: '10000000-0000-4000-8000-000000000001' });

      const incoming = bobSocket.emitted.find((e: any) => e.event === 'call:incoming');
      assert.ok(incoming);
      assert.equal(incoming.payload.from.username, 'Alice');
      assert.equal(incoming.payload.roomId, '10000000-0000-4000-8000-000000000001');
    });
  });

  describe('call:accept', () => {
    it('ignores an accept with no matching pending invite', async () => {
      const { io, socket } = setup('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      const aliceSocket = new FakeSocket();
      io.register(aliceSocket);
      await state.setOnline('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aliceSocket.id);

      await socket.trigger('call:accept', { roomId: '10000000-0000-4000-8000-000000000001', inviterId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

      assert.equal(aliceSocket.emitted.length, 0);
    });

    it('creates the room, notifies the inviter, and marks both as call partners', async () => {
      const { io, socket } = setup('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      const aliceSocket = new FakeSocket();
      io.register(aliceSocket);
      await state.setOnline('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aliceSocket.id);
      await state.addPendingInvite('10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

      // setUserRoom() x2 (alice, bob) each trigger a friend-status broadcast query.
      supaMock.enqueue({ data: [], error: null });
      supaMock.enqueue({ data: [], error: null });

      await socket.trigger('call:accept', { roomId: '10000000-0000-4000-8000-000000000001', inviterId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

      assert.ok(aliceSocket.emitted.some((e: any) => e.event === 'call:accepted' && e.payload.by === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
      assert.ok(socket.rooms.has('10000000-0000-4000-8000-000000000001'));

      const room = await state.getRoom('10000000-0000-4000-8000-000000000001');
      assert.deepEqual(room.participants.sort(), ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);

      assert.equal(await state.wereRecentCallPartners('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), true);
    });
  });

  describe('call:reject', () => {
    it('notifies the inviter that the invite was rejected', async () => {
      const { io, socket } = setup('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      const aliceSocket = new FakeSocket();
      io.register(aliceSocket);
      await state.setOnline('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aliceSocket.id);
      await state.addPendingInvite('10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

      await socket.trigger('call:reject', { roomId: '10000000-0000-4000-8000-000000000001', inviterId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

      assert.ok(aliceSocket.emitted.some((e: any) => e.event === 'call:rejected' && e.payload.by === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    });
  });

  describe('call:end', () => {
    it('does nothing if the room does not exist', async () => {
      const { socket } = setup('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      await socket.trigger('call:end', { roomId: 'e0000000-0000-4000-8000-0000000000ee' });
      assert.equal(socket.emitted.length, 0);
    });

    it('does nothing if the caller is not a participant of the room', async () => {
      const { socket } = setup('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      await state.saveRoom('10000000-0000-4000-8000-000000000001', { participants: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], mode: 'direct' });

      await socket.trigger('call:end', { roomId: '10000000-0000-4000-8000-000000000001' });

      assert.equal(socket.emitted.length, 0);
      assert.equal(await state.hasRoom('10000000-0000-4000-8000-000000000001'), true);
    });

    it('notifies participants and tears down the room', async () => {
      const { io, socket } = setup('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      await state.saveRoom('10000000-0000-4000-8000-000000000001', { participants: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], mode: 'direct' });
      await io.in(socket.id).socketsJoin('10000000-0000-4000-8000-000000000001'); // alice must be a room member to receive io.to(roomId) emits

      supaMock.enqueue({ data: [], error: null }); // clearUserRoom(alice) friend broadcast
      supaMock.enqueue({ data: [], error: null }); // clearUserRoom(bob) friend broadcast

      await socket.trigger('call:end', { roomId: '10000000-0000-4000-8000-000000000001' });

      assert.ok(socket.emitted.some((e: any) => e.event === 'call:ended' && e.payload.by === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
      assert.equal(await state.hasRoom('10000000-0000-4000-8000-000000000001'), false);
    });
  });

  describe('call:request_join / call:join_response', () => {
    it('call:request_join fails when the target is not currently in a call', async () => {
      const { socket } = setup('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      await socket.trigger('call:request_join', { targetUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });

      const failed = socket.emitted.find((e: any) => e.event === 'call:join_failed');
      assert.ok(failed);
      assert.match(failed.payload.reason, /не в звонке/);
    });

    it('call:request_join notifies every current room participant', async () => {
      const { io, socket } = setup('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Carol');
      const aliceSocket = new FakeSocket();
      const bobSocket = new FakeSocket();
      io.register(aliceSocket);
      io.register(bobSocket);
      await state.setOnline('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aliceSocket.id);
      await state.setOnline('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bobSocket.id);
      await state.saveRoom('10000000-0000-4000-8000-000000000001', { participants: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] });
      supaMock.enqueue({ data: [], error: null }); // setUserRoom's friend broadcast
      await state.setUserRoom(io, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000001'); // so getUserCurrentRoom('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') resolves

      supaMock.enqueue({ data: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', username: 'Carol', avatar_emoji: '🐧', avatar_url: null }, error: null });

      await socket.trigger('call:request_join', { targetUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });

      assert.ok(aliceSocket.emitted.some((e: any) => e.event === 'call:join_requested'));
      const bobReq = bobSocket.emitted.find((e: any) => e.event === 'call:join_requested');
      assert.ok(bobReq);
      assert.equal(bobReq.payload.from.username, 'Carol');
      assert.ok(socket.emitted.some((e: any) => e.event === 'call:join_request_sent'));
    });

    it('call:join_response(accept:false) notifies the requester and does not add them to the room', async () => {
      const { io, socket } = setup('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); // alice is the participant approving
      const carolSocket = new FakeSocket();
      io.register(carolSocket);
      await state.setOnline('cccccccc-cccc-4ccc-8ccc-cccccccccccc', carolSocket.id);
      await state.saveRoom('10000000-0000-4000-8000-000000000001', { participants: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] });
      await state.addPendingJoinRequest('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

      await socket.trigger('call:join_response', { roomId: '10000000-0000-4000-8000-000000000001', requesterId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', accept: false });

      assert.ok(carolSocket.emitted.some((e: any) => e.event === 'call:join_rejected'));
      const room = await state.getRoom('10000000-0000-4000-8000-000000000001');
      assert.ok(!room.participants.includes('cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
    });

    it('call:join_response(accept:true) adds the requester to the room and notifies everyone', async () => {
      const { io, socket } = setup('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const carolSocket = new FakeSocket();
      io.register(carolSocket);
      await state.setOnline('cccccccc-cccc-4ccc-8ccc-cccccccccccc', carolSocket.id);
      await state.saveRoom('10000000-0000-4000-8000-000000000001', { participants: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] });
      await state.addPendingJoinRequest('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      await io.in(socket.id).socketsJoin('10000000-0000-4000-8000-000000000001'); // alice already in the room

      supaMock.enqueue({ data: [], error: null }); // setUserRoom(carol)'s friend broadcast

      await socket.trigger('call:join_response', { roomId: '10000000-0000-4000-8000-000000000001', requesterId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', accept: true });

      const room = await state.getRoom('10000000-0000-4000-8000-000000000001');
      assert.deepEqual(room.participants.sort(), ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
      assert.ok(carolSocket.emitted.some((e: any) => e.event === 'call:join_accepted'));
      assert.ok(carolSocket.rooms.has('10000000-0000-4000-8000-000000000001'));
    });

    it('ignores a join_response from someone who is not actually a room participant', async () => {
      const { io, socket } = setup('mallory'); // not a participant of room-1
      const carolSocket = new FakeSocket();
      io.register(carolSocket);
      await state.setOnline('cccccccc-cccc-4ccc-8ccc-cccccccccccc', carolSocket.id);
      await state.saveRoom('10000000-0000-4000-8000-000000000001', { participants: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] });
      await state.addPendingJoinRequest('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

      await socket.trigger('call:join_response', { roomId: '10000000-0000-4000-8000-000000000001', requesterId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', accept: true });

      const room = await state.getRoom('10000000-0000-4000-8000-000000000001');
      assert.ok(!room.participants.includes('cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
      assert.equal(carolSocket.emitted.length, 0);
    });
  });

  describe('friends:call_status', () => {
    it('acks with in-call info only for friends who are currently in a room', async () => {
      const { io, socket } = setup('me');
      await state.saveRoom('10000000-0000-4000-8000-000000000001', { participants: ['friend-in-call', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'] });

      // setUserRoom(friend-in-call) fires its own internal broadcastCallStatus
      // friends-select query immediately — this must be queued first.
      supaMock.enqueue({ data: [], error: null });
      await state.setUserRoom(io, 'friend-in-call', '10000000-0000-4000-8000-000000000001');

      // Now queue the friends:call_status handler's own friends-select query.
      supaMock.enqueue({
        data: [{ user_a: 'me', user_b: 'friend-in-call' }, { user_a: 'friend-idle', user_b: 'me' }],
        error: null,
      });

      let ackResult: any = null;
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

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
const { startMatchLoop, registerMatchHandlers } = require('../../src/socket/match');

describe('socket/match.js', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    supaMock.reset();
  });

  describe('match:join / match:leave', () => {
    it('enqueues the player and reports the queue position on match:join', async () => {
      const io = makeFakeIo();
      const socket = new FakeSocket();
      io.register(socket);
      registerMatchHandlers(io, socket, 'user-1');

      await socket.trigger('match:join', {
        gameId: 'valorant', mode: 'solo', squadSize: 2, rankScore: 0, languages: ['en'], region: 'eu',
      });

      const searching = socket.emitted.find((e: any) => e.event === 'match:searching');
      assert.ok(searching);
      assert.equal(typeof searching.payload.position, 'object'); // queueSize() with no args -> { solo, group, byQueue }
    });

    it('dequeues the player and emits match:cancelled on match:leave', async () => {
      const io = makeFakeIo();
      const socket = new FakeSocket();
      io.register(socket);
      registerMatchHandlers(io, socket, 'user-1');

      await socket.trigger('match:join', {
        gameId: 'valorant', mode: 'solo', squadSize: 2, rankScore: 0, languages: ['en'], region: 'eu',
      });
      await socket.trigger('match:leave', undefined);

      assert.ok(socket.emitted.some((e: any) => e.event === 'match:cancelled'));

      const { queueSize } = require('../../src/services/matchmakingRedis');
      assert.equal(await queueSize('solo', 'valorant'), 0);
    });
  });

  describe('trial:vote', () => {
    async function seedRoom(roomId: any, participantIds: any) {
      await state.saveRoom(roomId, {
        participants: participantIds, mode: 'solo', gameId: 'valorant',
        trialStart: Date.now(), promoted: false, votes: {},
      });
    }

    it('broadcasts trial:voted to the room on each vote', async () => {
      const io = makeFakeIo();
      const socketA = new FakeSocket();
      io.register(socketA);
      registerMatchHandlers(io, socketA, 'alice');
      await io.in(socketA.id).socketsJoin('room-1');

      await seedRoom('room-1', ['alice', 'bob']);

      await socketA.trigger('trial:vote', { roomId: 'room-1', vote: 'yes' });

      assert.ok(socketA.emitted.some((e: any) => e.event === 'trial:voted' && e.payload.userId === 'alice'));
      // Only one of two participants has voted so far — no result yet.
      assert.ok(!socketA.emitted.some((e: any) => e.event === 'trial:result'));
    });

    it('is a no-op if the voter is not a participant of the room', async () => {
      const io = makeFakeIo();
      const socket = new FakeSocket();
      io.register(socket);
      registerMatchHandlers(io, socket, 'not-in-this-room');

      await seedRoom('room-1', ['alice', 'bob']);
      await socket.trigger('trial:vote', { roomId: 'room-1', vote: 'yes' });

      assert.equal(socket.emitted.length, 0);
    });

    it('is a no-op if the room does not exist (e.g. already resolved/expired)', async () => {
      const io = makeFakeIo();
      const socket = new FakeSocket();
      io.register(socket);
      registerMatchHandlers(io, socket, 'alice');

      await socket.trigger('trial:vote', { roomId: 'ghost-room', vote: 'yes' });

      assert.equal(socket.emitted.length, 0);
    });

    it('unanimous yes: promotes to friends, creates a direct conversation, emits call:promoted', async () => {
      const io = makeFakeIo();
      const socketA = new FakeSocket();
      const socketB = new FakeSocket();
      io.register(socketA);
      io.register(socketB);
      registerMatchHandlers(io, socketA, 'alice');
      registerMatchHandlers(io, socketB, 'bob');
      await io.in(socketA.id).socketsJoin('room-1');
      await io.in(socketB.id).socketsJoin('room-1');

      await seedRoom('room-1', ['alice', 'bob']);

      // addFriendPairInstant(alice, bob): select -> none, then upsert.
      supaMock.enqueue({ data: null, error: null });
      supaMock.enqueue({ error: null });
      // promoteRoomToFriends: rpc find_direct_conversation -> none existing.
      supaMock.enqueue({ data: [], error: null });
      // insert conversations, then conversation_members.
      supaMock.enqueue({ error: null });
      supaMock.enqueue({ error: null });

      await socketA.trigger('trial:vote', { roomId: 'room-1', vote: 'yes' });
      await socketB.trigger('trial:vote', { roomId: 'room-1', vote: 'yes' });

      const result = socketB.emitted.find((e: any) => e.event === 'trial:result');
      assert.ok(result);
      assert.equal(result.payload.promote, true);

      const promoted = socketB.emitted.find((e: any) => e.event === 'call:promoted');
      assert.ok(promoted);
      assert.equal(promoted.payload.roomId, 'room-1');
      assert.ok(promoted.payload.conversationId);

      const room = await state.getRoom('room-1');
      assert.equal(room.promoted, true);
    });

    it('any no vote: does not promote, clears both users\' room and deletes the room', async () => {
      const io = makeFakeIo();
      const socketA = new FakeSocket();
      const socketB = new FakeSocket();
      io.register(socketA);
      io.register(socketB);
      registerMatchHandlers(io, socketA, 'alice');
      registerMatchHandlers(io, socketB, 'bob');
      await io.in(socketA.id).socketsJoin('room-2');
      await io.in(socketB.id).socketsJoin('room-2');

      await seedRoom('room-2', ['alice', 'bob']);
      await state.setUserRoom(io, 'alice', 'room-2'); // no friends -> broadcastCallStatus queries return []
      supaMock.enqueue({ data: [], error: null }); // setUserRoom's friend broadcast for alice above

      // clearUserRoom (x2, one per participant) each does its own friend broadcast query.
      supaMock.enqueue({ data: [], error: null });
      supaMock.enqueue({ data: [], error: null });

      await socketA.trigger('trial:vote', { roomId: 'room-2', vote: 'yes' });
      await socketB.trigger('trial:vote', { roomId: 'room-2', vote: 'no' });

      const result = socketB.emitted.find((e: any) => e.event === 'trial:result');
      assert.ok(result);
      assert.equal(result.payload.promote, false);
      assert.ok(!socketB.emitted.some((e: any) => e.event === 'call:promoted'));

      assert.equal(await state.hasRoom('room-2'), false);
      assert.equal(await state.getUserCurrentRoom('alice'), null);
    });
  });

  describe('startMatchLoop — full pipeline (real 1s tick)', () => {
    it('matches two queued players and emits match:found with enriched profiles', async () => {
      const io = makeFakeIo();
      const socketA = new FakeSocket();
      const socketB = new FakeSocket();
      io.register(socketA);
      io.register(socketB);
      registerMatchHandlers(io, socketA, 'alice');
      registerMatchHandlers(io, socketB, 'bob');

      await socketA.trigger('match:join', {
        gameId: 'valorant', mode: 'solo', squadSize: 2, rankScore: 10, languages: ['en'], region: 'eu',
      });
      await socketB.trigger('match:join', {
        gameId: 'valorant', mode: 'solo', squadSize: 2, rankScore: 10, languages: ['en'], region: 'eu',
      });

      // handleMatch(): match_history insert (result unused), then a users
      // profile lookup for both matched participants.
      supaMock.enqueue({ error: null });
      supaMock.enqueue({
        data: [
          { id: 'alice', username: 'Alice', avatar_emoji: '🦊', avatar_url: null },
          { id: 'bob', username: 'Bob', avatar_emoji: '🐼', avatar_url: null },
        ],
        error: null,
      });

      const stop = startMatchLoop(io);
      try {
        await new Promise((resolve: any) => setTimeout(resolve, 1100)); // let the 1s tick fire once
      } finally {
        stop();
      }

      const foundA = socketA.emitted.find((e: any) => e.event === 'match:found');
      assert.ok(foundA, 'expected socketA to receive match:found');
      assert.equal(foundA.payload.mode, 'solo');
      const usernames = foundA.payload.participants.map((p: any) => p.username).sort();
      assert.deepEqual(usernames, ['Alice', 'Bob']);

      assert.ok(socketB.emitted.some((e: any) => e.event === 'match:found'));
      // Both sockets should have been joined into the new call room.
      assert.equal(socketA.rooms.size, 2); // own id + the new room
    });
  });
});

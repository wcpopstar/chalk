export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { FakeRedis } = require('../helpers/fakeRedis');

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

function fakeIo() {
  const emitted: any = [];
  return {
    emitted,
    to: (socketId: any) => ({ emit: (event: any, payload: any) => emitted.push({ socketId, event, payload }) }),
  };
}

describe('socket/state.js', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    supaMock.reset();
  });

  describe('online presence', () => {
    it('setOnline/getOnlineSocket/removeOnline/onlineCount round-trip', async () => {
      await state.setOnline('user-1', 'socket-abc');
      assert.equal(await state.getOnlineSocket('user-1'), 'socket-abc');
      assert.equal(await state.onlineCount(), 1);

      await state.removeOnline('user-1');
      assert.equal(await state.getOnlineSocket('user-1'), null);
      assert.equal(await state.onlineCount(), 0);
    });
  });

  describe('rooms', () => {
    it('saveRoom/getRoom/hasRoom/deleteRoom round-trip a JSON room object', async () => {
      const room = { participants: ['u1', 'u2'], mode: 'solo', gameId: 'valorant' };
      await state.saveRoom('room-1', room);

      assert.equal(await state.hasRoom('room-1'), true);
      assert.deepEqual(await state.getRoom('room-1'), room);
      assert.equal(await state.roomSize('room-1'), 2);

      await state.deleteRoom('room-1');
      assert.equal(await state.hasRoom('room-1'), false);
      assert.equal(await state.getRoom('room-1'), null);
      assert.equal(await state.roomSize('room-1'), 0);
    });

    it('updateRoom applies the updater function and persists the result', async () => {
      await state.saveRoom('room-2', { participants: ['u1'] });

      const next = await state.updateRoom('room-2', (current: any) => ({
        ...current,
        participants: [...current.participants, 'u2'],
      }));

      assert.deepEqual(next.participants, ['u1', 'u2']);
      assert.deepEqual(await state.getRoom('room-2'), { participants: ['u1', 'u2'] });
    });

    it('updateRoom deletes the room when the updater returns null', async () => {
      await state.saveRoom('room-3', { participants: ['u1'] });

      await state.updateRoom('room-3', () => null);

      assert.equal(await state.hasRoom('room-3'), false);
    });

    it('updateRoom passes null to the updater for a room that does not exist yet', async () => {
      const next = await state.updateRoom('brand-new-room', (current: any) => {
        assert.equal(current, null);
        return { participants: ['first-user'] };
      });

      assert.deepEqual(next, { participants: ['first-user'] });
    });
  });

  describe('user current room + call status broadcast', () => {
    it('setUserRoom stores the mapping and broadcasts to online accepted friends', async () => {
      supaMock.enqueue({ data: [{ user_a: 'me', user_b: 'friend-1' }], error: null }); // accepted friends
      await state.setOnline('friend-1', 'friend-1-socket');

      const io = fakeIo();
      await state.setUserRoom(io, 'me', 'room-9');

      assert.equal(await state.getUserCurrentRoom('me'), 'room-9');
      assert.equal(io.emitted.length, 1);
      assert.equal(io.emitted[0].socketId, 'friend-1-socket');
      assert.equal(io.emitted[0].event, 'friend:call_status');
      assert.deepEqual(io.emitted[0].payload, { userId: 'me', inCall: true, roomSize: 0 });
    });

    it('does not broadcast to friends who are offline', async () => {
      supaMock.enqueue({ data: [{ user_a: 'me', user_b: 'offline-friend' }], error: null });
      // offline-friend never calls setOnline()

      const io = fakeIo();
      await state.setUserRoom(io, 'me', 'room-9');

      assert.equal(io.emitted.length, 0);
    });

    it('clearUserRoom is a no-op (no broadcast) if the user had no room set', async () => {
      const io = fakeIo();

      await state.clearUserRoom(io, 'nobody-in-a-call');

      assert.equal(io.emitted.length, 0);
    });

    it('clearUserRoom removes the mapping and broadcasts inCall:false', async () => {
      supaMock.enqueue({ data: [{ user_a: 'me', user_b: 'friend-1' }], error: null }); // setUserRoom's broadcast
      supaMock.enqueue({ data: [{ user_a: 'me', user_b: 'friend-1' }], error: null }); // clearUserRoom's broadcast
      await state.setOnline('friend-1', 'friend-1-socket');

      const io = fakeIo();
      await state.setUserRoom(io, 'me', 'room-9');
      await state.clearUserRoom(io, 'me');

      assert.equal(await state.getUserCurrentRoom('me'), null);
      const lastEmit = io.emitted[io.emitted.length - 1];
      assert.deepEqual(lastEmit.payload, { userId: 'me', inCall: false, roomSize: 0 });
    });
  });

  describe('pending invites', () => {
    it('consumePendingInvite returns true and consumes a matching invite', async () => {
      await state.addPendingInvite('room-1', 'target-user', 'inviter-user');

      assert.equal(await state.consumePendingInvite('room-1', 'target-user', 'inviter-user'), true);
      // Consumed — a second attempt must fail even with the right inviterId.
      assert.equal(await state.consumePendingInvite('room-1', 'target-user', 'inviter-user'), false);
    });

    it('consumePendingInvite returns false for a mismatched inviterId', async () => {
      await state.addPendingInvite('room-1', 'target-user', 'real-inviter');

      assert.equal(await state.consumePendingInvite('room-1', 'target-user', 'someone-else'), false);
    });

    it('consumePendingInvite returns false when there was never an invite', async () => {
      assert.equal(await state.consumePendingInvite('room-x', 'nobody', 'nobody-either'), false);
    });
  });

  describe('pending join requests', () => {
    it('consumePendingJoinRequest returns true once and only once', async () => {
      await state.addPendingJoinRequest('room-1', 'requester-1');

      assert.equal(await state.consumePendingJoinRequest('room-1', 'requester-1'), true);
      assert.equal(await state.consumePendingJoinRequest('room-1', 'requester-1'), false);
    });
  });

  describe('call partners', () => {
    it('wereRecentCallPartners is true while both users share a current room', async () => {
      const { redis } = require('../../src/socket/redisClient');
      await redis.hset('chalk:user_room', 'alice', 'room-shared');
      await redis.hset('chalk:user_room', 'bob', 'room-shared');

      assert.equal(await state.wereRecentCallPartners('alice', 'bob'), true);
    });

    it('markCallPartners + wereRecentCallPartners works after the room is gone', async () => {
      await state.markCallPartners(['alice', 'bob', 'carol']);

      assert.equal(await state.wereRecentCallPartners('alice', 'bob'), true);
      assert.equal(await state.wereRecentCallPartners('alice', 'carol'), true);
      assert.equal(await state.wereRecentCallPartners('bob', 'carol'), true);
    });

    it('wereRecentCallPartners is false for two users who never shared a call', async () => {
      assert.equal(await state.wereRecentCallPartners('stranger-1', 'stranger-2'), false);
    });

    it('wereRecentCallPartners is false for missing ids or comparing a user to themself', async () => {
      assert.equal(await state.wereRecentCallPartners(null, 'x'), false);
      assert.equal(await state.wereRecentCallPartners('same', 'same'), false);
    });

    it('markCallPartners is a no-op for fewer than 2 distinct participants', async () => {
      await state.markCallPartners(['only-one', 'only-one']); // dedups to 1
      assert.equal(await state.wereRecentCallPartners('only-one', 'only-one'), false);
    });
  });
});

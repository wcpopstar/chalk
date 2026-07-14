export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { stubModule } = require('../helpers/stubModule');
const { FakeRedis } = require('../helpers/fakeRedis');
const { FakeSocket, makeFakeIo } = require('../helpers/fakeSocket');

// Every handler here is wrapped in secureOn(), whose Zod validation and
// rate limiting are Redis-backed — so redisClient must be faked before
// socket/servers.ts is loaded (see the note in test/socket/globalChat.test.ts).
const fakeRedis = new FakeRedis();
stubModule(require.resolve('../../src/socket/redisClient'), {
  redis: fakeRedis,
  pubClient: fakeRedis,
  subClient: fakeRedis,
  waitForRedisReady: async () => {},
  REDIS_URL: 'redis://fake',
});

// The permission/anti-spam logic itself lives in services/serverMessaging and is
// covered directly in test/services/serverMessaging.test.ts. What's under test
// HERE is the socket layer's own job: who gets put in which room, what is
// broadcast to whom, and that a refusal never leaks into the room.
let resolveResult: any;
let sendResult: any;
let deleteResult: any;
const messagingCalls: any[] = [];
stubModule(require.resolve('../../src/services/serverMessaging'), {
  resolveContextByChannel: async (userId: string, channelId: string) => {
    messagingCalls.push({ fn: 'resolveContextByChannel', userId, channelId });
    return resolveResult;
  },
  sendChannelMessage: async (userId: string, channelId: string, content: string) => {
    messagingCalls.push({ fn: 'sendChannelMessage', userId, channelId, content });
    return sendResult;
  },
  deleteChannelMessage: async (userId: string, messageId: string) => {
    messagingCalls.push({ fn: 'deleteChannelMessage', userId, messageId });
    return deleteResult;
  },
});

const { registerServerHandlers } = require('../../src/socket/servers');
const { PERMISSIONS, ALL_PERMISSIONS } = require('../../src/services/serverPermissions');

const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const ROOM = `server:chan:${CHANNEL_ID}`;

function setup(userId = 'me', username = 'me') {
  const io = makeFakeIo();
  const socket = new FakeSocket();
  io.register(socket);
  registerServerHandlers(io, socket, userId, username);
  return { io, socket };
}

// A second client already watching the channel, so broadcasts have a witness.
function watcher(io: any) {
  const s = new FakeSocket();
  io.register(s);
  s.join(ROOM);
  return s;
}

const allowed = (mask = ALL_PERMISSIONS, isOwner = false) => ({
  ok: true,
  ctx: { channel: { id: CHANNEL_ID }, server: { id: 'srv-1' }, isOwner, mask },
});

describe('socket/servers.ts', () => {
  beforeEach(() => {
    // A fresh Redis per test, or secureOn's rate limiter would carry counts
    // across tests that share a user id.
    fakeRedis.store.clear();
    messagingCalls.length = 0;
    resolveResult = allowed();
    sendResult = { ok: true, message: { id: MESSAGE_ID, content: 'hi' } };
    deleteResult = { ok: true, channelId: CHANNEL_ID };
  });

  describe('server:join', () => {
    it('puts a permitted member into the channel room', async () => {
      const { socket } = setup();

      let ack: any;
      await socket.trigger('server:join', { channelId: CHANNEL_ID }, (r: any) => { ack = r; });

      assert.deepEqual(ack, { ok: true });
      assert.ok(socket.rooms.has(ROOM));
    });

    it('refuses a member who cannot view the channel, and does not join them', async () => {
      resolveResult = allowed(PERMISSIONS.SEND_MESSAGES); // no VIEW_CHANNELS
      const { socket } = setup();

      let ack: any;
      await socket.trigger('server:join', { channelId: CHANNEL_ID }, (r: any) => { ack = r; });

      assert.deepEqual(ack, { error: 'Cannot join channel' });
      // The real bug this guards: joining the room anyway would leak every
      // future message in it to someone with no permission to read them.
      assert.equal(socket.rooms.has(ROOM), false);
    });

    it('refuses when the channel cannot be resolved at all', async () => {
      resolveResult = { ok: false, status: 404, error: 'Channel not found' };
      const { socket } = setup();

      let ack: any;
      await socket.trigger('server:join', { channelId: CHANNEL_ID }, (r: any) => { ack = r; });

      // 404 and 403 are deliberately collapsed into one opaque message.
      assert.deepEqual(ack, { error: 'Cannot join channel' });
      assert.equal(socket.rooms.has(ROOM), false);
    });

    it('lets the owner in even with an empty role mask', async () => {
      resolveResult = allowed(0, true);
      const { socket } = setup();

      let ack: any;
      await socket.trigger('server:join', { channelId: CHANNEL_ID }, (r: any) => { ack = r; });

      assert.deepEqual(ack, { ok: true });
      assert.ok(socket.rooms.has(ROOM));
    });

    it('rejects a channelId that is not a uuid before any lookup', async () => {
      const { socket } = setup();

      await socket.trigger('server:join', { channelId: 'not-a-uuid' }, () => {});

      // secureOn's Zod layer must stop this — no repository work at all.
      assert.equal(messagingCalls.length, 0);
    });
  });

  describe('server:leave', () => {
    it('removes the socket from the channel room', async () => {
      const { socket } = setup();
      await socket.trigger('server:join', { channelId: CHANNEL_ID }, () => {});
      assert.ok(socket.rooms.has(ROOM));

      await socket.trigger('server:leave', { channelId: CHANNEL_ID });

      assert.equal(socket.rooms.has(ROOM), false);
    });
  });

  describe('server:message', () => {
    it('broadcasts a sent message to everyone in the room, including the sender', async () => {
      const { io, socket } = setup();
      const other = watcher(io);
      socket.join(ROOM);

      let ack: any;
      await socket.trigger('server:message', { channelId: CHANNEL_ID, content: 'hi' }, (r: any) => { ack = r; });

      assert.equal(ack.ok, true);
      assert.deepEqual(ack.message, { id: MESSAGE_ID, content: 'hi' });

      // io.to(room) — unlike socket.to(room) — includes the sender, so their
      // own client renders the message from the same broadcast.
      const delivered = other.emitted.filter((e: any) => e.event === 'server:message');
      assert.equal(delivered.length, 1);
      assert.deepEqual(delivered[0].payload, { id: MESSAGE_ID, content: 'hi' });
      assert.ok(socket.emitted.some((e: any) => e.event === 'server:message'));
    });

    it('acks the refusal and broadcasts nothing when sending is not permitted', async () => {
      sendResult = { ok: false, status: 403, error: 'Missing permission' };
      const { io, socket } = setup();
      const other = watcher(io);

      let ack: any;
      await socket.trigger('server:message', { channelId: CHANNEL_ID, content: 'hi' }, (r: any) => { ack = r; });

      assert.equal(ack.error, 'Missing permission');
      assert.equal(other.emitted.filter((e: any) => e.event === 'server:message').length, 0);
    });

    it('passes slow-mode retryAfter back to the sender', async () => {
      sendResult = { ok: false, status: 429, error: 'Slow mode active', retryAfter: 12 };
      const { socket } = setup();

      let ack: any;
      await socket.trigger('server:message', { channelId: CHANNEL_ID, content: 'hi' }, (r: any) => { ack = r; });

      // Without retryAfter the client can't show a countdown and will just
      // retry into the same 429.
      assert.deepEqual(ack, { error: 'Slow mode active', retryAfter: 12 });
    });

    it('rejects empty content at the schema layer', async () => {
      const { socket } = setup();

      await socket.trigger('server:message', { channelId: CHANNEL_ID, content: '' }, () => {});

      assert.equal(messagingCalls.length, 0);
    });

    it('rejects content over the 4000-char cap at the schema layer', async () => {
      const { socket } = setup();

      await socket.trigger('server:message', { channelId: CHANNEL_ID, content: 'x'.repeat(4001) }, () => {});

      assert.equal(messagingCalls.length, 0);
    });

    it('sends on behalf of the authenticated user, not any id in the payload', async () => {
      const { socket } = setup('real-user');

      await socket.trigger(
        'server:message',
        { channelId: CHANNEL_ID, content: 'hi', userId: 'someone-else' } as any,
        () => {},
      );

      const call = messagingCalls.find((c) => c.fn === 'sendChannelMessage');
      assert.equal(call.userId, 'real-user');
    });
  });

  describe('server:delete', () => {
    it('broadcasts the deletion to the room the message actually lived in', async () => {
      const { io, socket } = setup();
      const other = watcher(io);

      let ack: any;
      await socket.trigger('server:delete', { channelId: CHANNEL_ID, messageId: MESSAGE_ID }, (r: any) => { ack = r; });

      assert.deepEqual(ack, { ok: true });
      const evt = other.emitted.find((e: any) => e.event === 'server:message:deleted');
      // The room comes from the resolved message, not the client's claim —
      // otherwise a client could fire deletions into a channel it can't see.
      assert.deepEqual(evt.payload, { channelId: CHANNEL_ID, messageId: MESSAGE_ID });
    });

    it('acks the refusal and broadcasts nothing when deleting is not permitted', async () => {
      deleteResult = { ok: false, status: 403, error: 'Missing permission' };
      const { io, socket } = setup();
      const other = watcher(io);

      let ack: any;
      await socket.trigger('server:delete', { channelId: CHANNEL_ID, messageId: MESSAGE_ID }, (r: any) => { ack = r; });

      assert.deepEqual(ack, { error: 'Missing permission' });
      assert.equal(other.emitted.filter((e: any) => e.event === 'server:message:deleted').length, 0);
    });

    it('deletes on behalf of the authenticated user', async () => {
      const { socket } = setup('real-user');

      await socket.trigger('server:delete', { channelId: CHANNEL_ID, messageId: MESSAGE_ID }, () => {});

      const call = messagingCalls.find((c) => c.fn === 'deleteChannelMessage');
      assert.equal(call.userId, 'real-user');
      assert.equal(call.messageId, MESSAGE_ID);
    });

    it('rejects a messageId that is not a uuid', async () => {
      const { socket } = setup();

      await socket.trigger('server:delete', { channelId: CHANNEL_ID, messageId: 'nope' }, () => {});

      assert.equal(messagingCalls.length, 0);
    });
  });

  describe('server:typing', () => {
    it('relays the typing signal to the others in the room but not back to self', async () => {
      const { io, socket } = setup('me', 'my-name');
      const other = watcher(io);
      socket.join(ROOM);

      await socket.trigger('server:typing', { channelId: CHANNEL_ID });

      const evt = other.emitted.find((e: any) => e.event === 'server:typing');
      assert.deepEqual(evt.payload, { channelId: CHANNEL_ID, userId: 'me', username: 'my-name' });
      // Echoing typing back to the sender makes their own client show
      // "you are typing…" — socket.to() must exclude self.
      assert.equal(socket.emitted.filter((e: any) => e.event === 'server:typing').length, 0);
    });
  });

  describe('rate limiting', () => {
    it('eventually throttles a client hammering server:message', async () => {
      const { socket } = setup(`spammer-${crypto.randomUUID()}`);

      let refused = 0;
      for (let i = 0; i < 60; i++) {
        await socket.trigger('server:message', { channelId: CHANNEL_ID, content: `msg ${i}` }, (r: any) => {
          if (r && r.error) refused += 1;
        });
      }

      // secureOn's Redis sliding window must bite well before 60 messages —
      // otherwise a single socket can flood a channel.
      assert.ok(refused > 0, 'expected the socket rate limiter to refuse some messages');
      const accepted = messagingCalls.filter((c) => c.fn === 'sendChannelMessage').length;
      assert.ok(accepted < 60, `expected some sends to be dropped, but all ${accepted} got through`);
    });
  });
});

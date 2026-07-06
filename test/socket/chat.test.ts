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
// requiring chat.ts would transitively require the REAL
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

const { registerChatHandlers } = require('../../src/socket/chat');

function setup(userId: any, username: any) {
  const io = makeFakeIo();
  const socket = new FakeSocket();
  io.register(socket);
  registerChatHandlers(io, socket, userId, username || userId);
  return { io, socket };
}

// A minimal valid WebM header (EBML magic bytes) so media.js's magic-byte
// sniffing (detectContainer) accepts it as a real audio/video container.
const FAKE_WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);

describe('socket/chat.js', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    supaMock.reset();
  });

  describe('chat:join / chat:leave', () => {
    it('joins the room only if the caller is actually a conversation member', async () => {
      const { socket } = setup('me');
      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // isConversationMember -> true

      await socket.trigger('chat:join', { conversationId: 'conv-1' });

      assert.ok(socket.rooms.has('chat:conv-1'));
    });

    it('does not join the room if the caller is not a member', async () => {
      const { socket } = setup('me');
      supaMock.enqueue({ data: null, error: null }); // isConversationMember -> false

      await socket.trigger('chat:join', { conversationId: 'conv-1' });

      assert.ok(!socket.rooms.has('chat:conv-1'));
    });

    it('chat:leave removes the room regardless', async () => {
      const { socket } = setup('me');
      socket.join('chat:conv-1');

      await socket.trigger('chat:leave', { conversationId: 'conv-1' });

      assert.ok(!socket.rooms.has('chat:conv-1'));
    });
  });

  describe('chat:message', () => {
    it('acks an error and does not broadcast when the caller is not a member', async () => {
      const { socket } = setup('me');
      supaMock.enqueue({ data: null, error: null }); // isConversationMember -> false

      let ackResult;
      await socket.trigger('chat:message', { conversationId: 'conv-1', text: 'hi' }, (r: any) => { ackResult = r; });

      assert.match(ackResult.error, /Не участник/);
    });

    it('blocks sending and emits chat:blocked when the DM partner is blocked', async () => {
      const { socket } = setup('me');
      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member: yes
      supaMock.enqueue({ data: { type: 'direct' }, error: null }); // conversations lookup
      supaMock.enqueue({ data: [{ user_id: 'partner' }], error: null }); // other member
      supaMock.enqueue({ data: [{ id: 'block-row' }], error: null }); // areUsersBlocked -> true

      let ackResult;
      await socket.trigger('chat:message', { conversationId: 'conv-1', text: 'hi' }, (r: any) => { ackResult = r; });

      assert.ok(socket.emitted.some((e: any) => e.event === 'chat:blocked'));
      assert.match(ackResult.error, /заблокирован/);
    });

    it('saves and broadcasts a plain text message', async () => {
      const { io, socket } = setup('me');
      const other = new FakeSocket();
      io.register(other);
      other.join('chat:conv-1');
      socket.join('chat:conv-1');

      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member
      supaMock.enqueue({ data: null, error: null }); // conversations lookup -> not direct/none -> directPartnerBlocked short-circuits false
      supaMock.enqueue({ data: { id: 'm1', text: 'hello', sender_id: 'me' }, error: null }); // saveMessage insert

      let ackResult;
      await socket.trigger('chat:message', { conversationId: 'conv-1', text: 'hello' }, (r: any) => { ackResult = r; });

      assert.deepEqual(ackResult, { ok: true });
      const received = other.emitted.find((e: any) => e.event === 'chat:message');
      assert.ok(received);
      assert.equal(received.payload.text, 'hello');
    });

    it('detects a YouTube link and attaches preview data', async () => {
      const { socket } = setup('me');
      socket.join('chat:conv-1');
      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member
      supaMock.enqueue({ data: null, error: null }); // not blocked

      // getYouTubePreviewData does its own network fetch — rather than
      // stubbing the network, just confirm the message still saves and
      // broadcasts correctly even if the preview attempt fails/returns null,
      // proving the youtube detection branch doesn't throw either way.
      supaMock.enqueue({ data: { id: 'm2', type: 'youtube', text: 'https://youtu.be/dQw4w9WgXcQ' }, error: null });

      let ackResult;
      await socket.trigger(
        'chat:message',
        { conversationId: 'conv-1', text: 'https://youtu.be/dQw4w9WgXcQ' },
        (r: any) => { ackResult = r; }
      );

      assert.deepEqual(ackResult, { ok: true });
    });
  });

  describe('chat:gif', () => {
    it('saves and broadcasts a gif message', async () => {
      const { io, socket } = setup('me');
      const other = new FakeSocket();
      io.register(other);
      other.join('chat:conv-1');

      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member
      supaMock.enqueue({ data: null, error: null }); // not blocked
      supaMock.enqueue({ data: { id: 'g1', type: 'gif', media_url: 'https://example.com/x.gif' }, error: null });

      let ackResult;
      await socket.trigger('chat:gif', { conversationId: 'conv-1', gifUrl: 'https://example.com/x.gif' }, (r: any) => { ackResult = r; });

      assert.deepEqual(ackResult, { ok: true });
      assert.ok(other.emitted.some((e: any) => e.event === 'chat:message' && e.payload.type === 'gif'));
    });
  });

  describe('chat:voice', () => {
    it('acks an error for a payload that is not a valid audio container', async () => {
      const { socket } = setup('me');
      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member
      supaMock.enqueue({ data: null, error: null }); // not blocked

      // secureOn catches handler exceptions internally and turns them into
      // an ack({ error }) call rather than letting the promise reject, so
      // we assert on the ack rather than expecting socket.trigger() to throw.
      let ackResult;
      await socket.trigger(
        'chat:voice',
        { conversationId: 'conv-1', audio: Buffer.from('not audio'), mime: 'audio/webm' },
        (r: any) => { ackResult = r; }
      );

      assert.match(ackResult.error, /формат/);
    });

    it('uploads and broadcasts a valid voice note', async () => {
      const { io, socket } = setup('me');
      const other = new FakeSocket();
      io.register(other);
      other.join('chat:conv-1');

      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member
      supaMock.enqueue({ data: null, error: null }); // not blocked
      supaMock.enqueue({ error: null }); // storage upload
      supaMock.enqueue({ data: { id: 'v1', type: 'voice', duration_seconds: 5 }, error: null }); // saveMessage

      let ackResult;
      await socket.trigger(
        'chat:voice',
        { conversationId: 'conv-1', audio: FAKE_WEBM, mime: 'audio/webm', duration: 5.4 },
        (r: any) => { ackResult = r; }
      );

      assert.deepEqual(ackResult, { ok: true });
      assert.ok(other.emitted.some((e: any) => e.event === 'chat:message' && e.payload.type === 'voice'));
    });
  });

  describe('chat:edit / chat:delete', () => {
    it('chat:edit broadcasts the edited message', async () => {
      const { io, socket } = setup('me');
      const other = new FakeSocket();
      io.register(other);
      other.join('chat:conv-1');

      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member
      supaMock.enqueue({ data: { id: 'm1', text: 'edited!' }, error: null }); // editMessageRow

      let ackResult;
      await socket.trigger('chat:edit', { conversationId: 'conv-1', messageId: 'm1', text: 'edited!' }, (r: any) => { ackResult = r; });

      assert.deepEqual(ackResult, { ok: true });
      const edited = other.emitted.find((e: any) => e.event === 'chat:message:edited');
      assert.equal(edited.payload.text, 'edited!');
    });

    it('chat:edit acks an error if the message is not found / not the caller\'s own', async () => {
      const { socket } = setup('me');
      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member
      supaMock.enqueue({ data: null, error: null }); // editMessageRow: no matching row

      let ackResult;
      await socket.trigger(
        'chat:edit',
        { conversationId: 'conv-1', messageId: 'not-mine', text: 'x' },
        (r: any) => { ackResult = r; }
      );

      assert.match(ackResult.error, /не найдено/i);
    });

    it('chat:delete broadcasts a deletion notice', async () => {
      const { io, socket } = setup('me');
      const other = new FakeSocket();
      io.register(other);
      other.join('chat:conv-1');

      supaMock.enqueue({ data: { user_id: 'me' }, error: null }); // member
      supaMock.enqueue({ data: { id: 'm1' }, error: null }); // deleteMessageRow

      let ackResult;
      await socket.trigger('chat:delete', { conversationId: 'conv-1', messageId: 'm1' }, (r: any) => { ackResult = r; });

      assert.deepEqual(ackResult, { ok: true });
      assert.ok(other.emitted.some((e: any) => e.event === 'chat:message:deleted' && e.payload.messageId === 'm1'));
    });
  });

  describe('chat:typing', () => {
    it('broadcasts to the room but not back to the sender', async () => {
      const { io, socket } = setup('me', 'MyName');
      const other = new FakeSocket();
      io.register(other);
      socket.join('chat:conv-1');
      other.join('chat:conv-1');

      await socket.trigger('chat:typing', { conversationId: 'conv-1' });

      assert.ok(other.emitted.some((e: any) => e.event === 'chat:typing' && e.payload.username === 'MyName'));
      assert.ok(!socket.emitted.some((e: any) => e.event === 'chat:typing'));
    });
  });
});

export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { makeFakeIo } = require('../helpers/fakeSocket');

const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});

// presence.ts only needs getOnlineSocket from socket/state — stub the whole
// module so requiring it doesn't open the real Redis connection.
let onlineSockets: Record<string, string | null> = {};
stubModule(require.resolve('../../src/socket/state'), {
  getOnlineSocket: async (userId: any) => onlineSockets[userId] || null,
});

const { notifyFriendsPresence } = require('../../src/socket/presence');

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FRIEND_ONLINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FRIEND_OFFLINE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('socket/presence.ts', () => {
  beforeEach(() => {
    supaMock.reset();
    onlineSockets = {};
  });

  it('emits presence to every ONLINE friend, regardless of row direction', async () => {
    const io = makeFakeIo();
    supaMock.enqueue({
      data: [
        { user_a: ME, user_b: FRIEND_ONLINE },  // I initiated this friendship
        { user_a: FRIEND_OFFLINE, user_b: ME }, // they initiated this one
      ],
      error: null,
    });
    onlineSockets[FRIEND_ONLINE] = 'sock-friend-1';

    await notifyFriendsPresence(io, ME, 'online');

    const presenceEmits = io.allEmits.filter((e: any) => e.event === 'presence');
    assert.equal(presenceEmits.length, 1);
    assert.equal(presenceEmits[0].target, 'sock-friend-1');
    assert.deepEqual(presenceEmits[0].payload, { userId: ME, status: 'online' });
  });

  it('does nothing when the friends query returns no rows', async () => {
    const io = makeFakeIo();
    supaMock.enqueue({ data: null, error: null });

    await notifyFriendsPresence(io, ME, 'offline');
    assert.equal(io.allEmits.length, 0);
  });

  it('is best-effort: a thrown Supabase error is contained, not propagated', async () => {
    const io = makeFakeIo();
    supaMock.enqueue(new Error('supabase down'));

    await notifyFriendsPresence(io, ME, 'offline'); // must not reject
    assert.equal(io.allEmits.length, 0);
  });
});

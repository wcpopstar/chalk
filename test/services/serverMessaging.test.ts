export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');

// ── Repository ───────────────────────────────────────────────────────────
// Driven by per-test fixtures rather than the FIFO supabase mock: this module
// issues a *conditional* chain of queries (channel → server → member → mask →
// slow-mode → insert), so naming each result keeps the tests readable.
let channel: any;
let server: any;
let member: any;
let permissionMask: number;
let lastMessage: any;
let messageById: any;
let createResult: any;
let deleteResult: any;
let memberRoleIds: string[];
let channelOverrides: any[];
const repoCalls: any[] = [];

stubModule(require.resolve('../../src/repositories/serversRepository'), {
  getChannelById: async (id: string) => {
    repoCalls.push({ fn: 'getChannelById', id });
    return { data: channel };
  },
  getServerById: async (id: string) => {
    repoCalls.push({ fn: 'getServerById', id });
    return { data: server };
  },
  getMember: async (serverId: string, userId: string) => {
    repoCalls.push({ fn: 'getMember', serverId, userId });
    return { data: member };
  },
  getMemberPermissionMask: async (serverId: string, userId: string) => {
    repoCalls.push({ fn: 'getMemberPermissionMask', serverId, userId });
    return permissionMask;
  },
  getMemberRolesAndMask: async (serverId: string, userId: string) => {
    repoCalls.push({ fn: 'getMemberRolesAndMask', serverId, userId });
    return { roleIds: memberRoleIds, mask: permissionMask };
  },
  listChannelOverridesForRoles: async (channelId: string, roleIds: string[]) => {
    repoCalls.push({ fn: 'listChannelOverridesForRoles', channelId, roleIds });
    return { data: channelOverrides, error: null };
  },
  getLastMessageAt: async (channelId: string, userId: string) => {
    repoCalls.push({ fn: 'getLastMessageAt', channelId, userId });
    return { data: lastMessage };
  },
  createMessage: async (row: any) => {
    repoCalls.push({ fn: 'createMessage', row });
    return createResult;
  },
  getMessageById: async (id: string) => {
    repoCalls.push({ fn: 'getMessageById', id });
    return { data: messageById };
  },
  softDeleteMessage: async (id: string) => {
    repoCalls.push({ fn: 'softDeleteMessage', id });
    return deleteResult;
  },
});

let moderationVerdict: any;
stubModule(require.resolve('../../src/services/autoModeration'), {
  checkMessage: async (_userId: string, _content: string) => moderationVerdict,
});

const { resolveContextByChannel, sendChannelMessage, deleteChannelMessage } = require('../../src/services/serverMessaging');
const { PERMISSIONS, ALL_PERMISSIONS } = require('../../src/services/serverPermissions');

const USER = 'user-1';
const OWNER = 'owner-1';
const CHANNEL_ID = 'chan-1';
const SERVER_ID = 'srv-1';

describe('services/serverMessaging', () => {
  beforeEach(() => {
    repoCalls.length = 0;
    channel = { id: CHANNEL_ID, server_id: SERVER_ID, type: 'text', slow_mode_seconds: 0 };
    server = { id: SERVER_ID, owner_id: OWNER };
    member = { user_id: USER, is_banned: false };
    permissionMask = PERMISSIONS.VIEW_CHANNELS | PERMISSIONS.SEND_MESSAGES;
    memberRoleIds = ['role-default'];
    channelOverrides = [];
    lastMessage = null;
    messageById = null;
    createResult = { data: { id: 'msg-1', content: 'hello' }, error: null };
    deleteResult = { error: null };
    moderationVerdict = { ok: true };
  });

  describe('resolveContextByChannel', () => {
    it('404s on an unknown channel', async () => {
      channel = null;
      const r = await resolveContextByChannel(USER, CHANNEL_ID);
      assert.equal(r.ok, false);
      assert.equal(r.status, 404);
    });

    it('404s (not 403) for a non-member, so channel existence stays secret', async () => {
      member = null;
      const r = await resolveContextByChannel(USER, CHANNEL_ID);

      assert.equal(r.ok, false);
      // A 403 here would confirm to an outsider that the channel is real.
      assert.equal(r.status, 404);
      assert.equal(r.error, 'Channel not found');
    });

    it('403s a banned member', async () => {
      member = { user_id: USER, is_banned: true };
      const r = await resolveContextByChannel(USER, CHANNEL_ID);

      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
      assert.match(r.error, /banned/i);
    });

    it('gives the owner every permission without reading their roles', async () => {
      const r = await resolveContextByChannel(OWNER, CHANNEL_ID);

      assert.equal(r.ok, true);
      assert.equal(r.ctx.isOwner, true);
      assert.equal(r.ctx.mask, ALL_PERMISSIONS);
      assert.ok(!repoCalls.some((c) => c.fn === 'getMemberPermissionMask' || c.fn === 'getMemberRolesAndMask'));
    });

    it('applies per-channel overrides on top of the base role mask', async () => {
      // Base grants SEND; a channel override denies it for the member's role.
      channelOverrides = [{ role_id: 'role-default', allow: 0, deny: PERMISSIONS.SEND_MESSAGES }];
      const r = await resolveContextByChannel(USER, CHANNEL_ID);

      assert.equal(r.ok, true);
      assert.equal(r.ctx.mask & PERMISSIONS.SEND_MESSAGES, 0); // denied by override
      assert.ok(r.ctx.mask & PERMISSIONS.VIEW_CHANNELS);       // still granted
    });

    it('resolves an ordinary member to their role mask', async () => {
      const r = await resolveContextByChannel(USER, CHANNEL_ID);

      assert.equal(r.ok, true);
      assert.equal(r.ctx.isOwner, false);
      assert.equal(r.ctx.mask, PERMISSIONS.VIEW_CHANNELS | PERMISSIONS.SEND_MESSAGES);
    });
  });

  describe('sendChannelMessage', () => {
    it('refuses a member without SEND_MESSAGES', async () => {
      permissionMask = PERMISSIONS.VIEW_CHANNELS; // read-only

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');

      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
      assert.ok(!repoCalls.some((c) => c.fn === 'createMessage'));
    });

    it('refuses a member who can send but cannot even view the channel', async () => {
      permissionMask = PERMISSIONS.SEND_MESSAGES;

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');
      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
    });

    it('refuses to post into a non-text channel', async () => {
      channel = { ...channel, type: 'voice' };

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    });

    it('rejects empty, whitespace-only and non-string content', async () => {
      for (const bad of ['', '   ', null, undefined, 42, {}]) {
        const r = await sendChannelMessage(USER, CHANNEL_ID, bad);
        assert.equal(r.ok, false, `content ${JSON.stringify(bad)} should be rejected`);
        assert.equal(r.status, 400);
      }
      assert.ok(!repoCalls.some((c) => c.fn === 'createMessage'));
    });

    it('rejects content over 4000 characters', async () => {
      const r = await sendChannelMessage(USER, CHANNEL_ID, 'x'.repeat(4001));
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    });

    it('trims content before storing it', async () => {
      await sendChannelMessage(USER, CHANNEL_ID, '  hello  ');

      const create = repoCalls.find((c) => c.fn === 'createMessage');
      assert.equal(create.row.content, 'hello');
      assert.equal(create.row.sender_id, USER);
      assert.equal(create.row.channel_id, CHANNEL_ID);
    });

    it('rejects a message auto-moderation refuses', async () => {
      moderationVerdict = { ok: false, error: 'Слишком много ссылок' };

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'spam spam');

      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.equal(r.error, 'Слишком много ссылок');
      assert.ok(!repoCalls.some((c) => c.fn === 'createMessage'));
    });

    it('enforces slow mode with a retryAfter the client can wait out', async () => {
      channel = { ...channel, slow_mode_seconds: 30 };
      lastMessage = { created_at: new Date(Date.now() - 10_000).toISOString() }; // 10s ago

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');

      assert.equal(r.ok, false);
      assert.equal(r.status, 429);
      assert.equal(r.retryAfter, 20);
      assert.ok(!repoCalls.some((c) => c.fn === 'createMessage'));
    });

    it('allows the message once the slow-mode window has passed', async () => {
      channel = { ...channel, slow_mode_seconds: 30 };
      lastMessage = { created_at: new Date(Date.now() - 31_000).toISOString() };

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');

      assert.equal(r.ok, true);
      assert.ok(repoCalls.some((c) => c.fn === 'createMessage'));
    });

    it('allows the first message in a slow-mode channel', async () => {
      channel = { ...channel, slow_mode_seconds: 30 };
      lastMessage = null;

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');
      assert.equal(r.ok, true);
    });

    it('lets a moderator bypass slow mode', async () => {
      channel = { ...channel, slow_mode_seconds: 30 };
      lastMessage = { created_at: new Date().toISOString() };
      permissionMask = PERMISSIONS.VIEW_CHANNELS | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.MANAGE_MESSAGES;

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');
      assert.equal(r.ok, true);
    });

    it('lets the owner bypass slow mode', async () => {
      channel = { ...channel, slow_mode_seconds: 30 };
      lastMessage = { created_at: new Date().toISOString() };

      const r = await sendChannelMessage(OWNER, CHANNEL_ID, 'hello');
      assert.equal(r.ok, true);
    });

    it('propagates the resolve failure for a banned member', async () => {
      member = { user_id: USER, is_banned: true };

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');
      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
    });

    it('returns 500 when the insert fails', async () => {
      createResult = { data: null, error: { message: 'db down' } };

      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');
      assert.equal(r.ok, false);
      assert.equal(r.status, 500);
    });

    it('returns the stored message on success', async () => {
      const r = await sendChannelMessage(USER, CHANNEL_ID, 'hello');

      assert.equal(r.ok, true);
      assert.deepEqual(r.message, { id: 'msg-1', content: 'hello' });
    });
  });

  describe('deleteChannelMessage', () => {
    beforeEach(() => {
      messageById = { id: 'msg-1', channel_id: CHANNEL_ID, sender_id: USER };
    });

    it('404s an unknown message', async () => {
      messageById = null;

      const r = await deleteChannelMessage(USER, 'msg-1');
      assert.equal(r.ok, false);
      assert.equal(r.status, 404);
    });

    it('lets the author delete their own message', async () => {
      const r = await deleteChannelMessage(USER, 'msg-1');

      assert.equal(r.ok, true);
      assert.equal(r.channelId, CHANNEL_ID);
      assert.ok(repoCalls.some((c) => c.fn === 'softDeleteMessage' && c.id === 'msg-1'));
    });

    it("refuses to let a plain member delete someone else's message", async () => {
      messageById = { id: 'msg-1', channel_id: CHANNEL_ID, sender_id: 'someone-else' };

      const r = await deleteChannelMessage(USER, 'msg-1');

      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
      assert.ok(!repoCalls.some((c) => c.fn === 'softDeleteMessage'));
    });

    it("lets MANAGE_MESSAGES delete someone else's message", async () => {
      messageById = { id: 'msg-1', channel_id: CHANNEL_ID, sender_id: 'someone-else' };
      permissionMask = PERMISSIONS.VIEW_CHANNELS | PERMISSIONS.MANAGE_MESSAGES;

      const r = await deleteChannelMessage(USER, 'msg-1');
      assert.equal(r.ok, true);
    });

    it("lets the owner delete someone else's message", async () => {
      messageById = { id: 'msg-1', channel_id: CHANNEL_ID, sender_id: 'someone-else' };

      const r = await deleteChannelMessage(OWNER, 'msg-1');
      assert.equal(r.ok, true);
    });

    it('refuses a banned member even deleting their own message', async () => {
      member = { user_id: USER, is_banned: true };

      const r = await deleteChannelMessage(USER, 'msg-1');
      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
    });

    it('returns 500 when the delete fails', async () => {
      deleteResult = { error: { message: 'db down' } };

      const r = await deleteChannelMessage(USER, 'msg-1');
      assert.equal(r.ok, false);
      assert.equal(r.status, 500);
    });
  });
});

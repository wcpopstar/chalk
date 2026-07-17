export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('crypto');

const { stubModule } = require('../helpers/stubModule');
const { buildTestApp } = require('../helpers/buildTestApp');
const { FakeRedis } = require('../helpers/fakeRedis');
const { signAccessToken } = require('../../src/utils/jwt');

const fakeRedis = new FakeRedis();
stubModule(require.resolve('../../src/socket/redisClient'), {
  redis: fakeRedis,
  pubClient: fakeRedis,
  subClient: fakeRedis,
  waitForRedisReady: async () => {},
  REDIS_URL: 'redis://fake',
});

// ── Repository ───────────────────────────────────────────────────────────
// Fixture-driven rather than FIFO: this router branches (loadContext →
// permission check → sub-resource lookup → write), so naming each result makes
// the tests readable and lets a test assert "the write never happened".
let server: any;
let member: any;
let permissionMask: number;
let channel: any;
let role: any;
let targetMember: any;
let invite: any;
let writeError: any; // applied to the terminal write of whichever route is under test
let createServerResult: any;
let createInviteResult: any;
const calls: any[] = [];

const record = (fn: string, args: any = {}) => calls.push({ fn, ...args });
const wrote = (fn: string) => calls.some((c) => c.fn === fn);

stubModule(require.resolve('../../src/repositories/serversRepository'), {
  getServerById: async (id: string) => { record('getServerById', { id }); return { data: server }; },
  getMember: async (serverId: string, userId: string) => {
    record('getMember', { serverId, userId });
    // The router asks for its own membership and, on member routes, the
    // target's — distinguish them by user id.
    return { data: userId === CALLER ? member : targetMember };
  },
  getMemberPermissionMask: async () => permissionMask,
  listServersForUser: async () => ({ data: [{ id: 'srv-1' }], error: writeError }),
  createServer: async (row: any) => { record('createServer', { row }); return createServerResult; },
  updateServer: async (id: string, patch: any) => { record('updateServer', { id, patch }); return { data: { id, ...patch }, error: writeError }; },
  deleteServer: async (id: string) => { record('deleteServer', { id }); return { error: writeError }; },
  createRole: async (row: any) => { record('createRole', { row }); return { data: { id: 'role-new', ...row }, error: writeError }; },
  updateRole: async (id: string, patch: any) => { record('updateRole', { id, patch }); return { data: { id, ...patch }, error: writeError }; },
  deleteRole: async (id: string) => { record('deleteRole', { id }); return { error: writeError }; },
  getRoleById: async (id: string) => { record('getRoleById', { id }); return { data: role }; },
  listRoles: async () => ({ data: [] }),
  addMember: async (row: any) => { record('addMember', { row }); return { error: writeError }; },
  removeMember: async (serverId: string, userId: string) => { record('removeMember', { serverId, userId }); return { error: writeError }; },
  updateMember: async (serverId: string, userId: string, patch: any) => { record('updateMember', { serverId, userId, patch }); return { error: writeError }; },
  listMembers: async () => ({ data: [{ user_id: CALLER }], error: writeError }),
  listAllMemberRoles: async () => ({ data: [], error: null }),
  assignRole: async (serverId: string, userId: string, roleId: string) => { record('assignRole', { serverId, userId, roleId }); return { error: writeError }; },
  unassignRole: async (serverId: string, userId: string, roleId: string) => { record('unassignRole', { serverId, userId, roleId }); return { error: writeError }; },
  createChannel: async (row: any) => { record('createChannel', { row }); return { data: { id: 'chan-new', ...row }, error: writeError }; },
  updateChannel: async (id: string, patch: any) => { record('updateChannel', { id, patch }); return { data: { id, ...patch }, error: writeError }; },
  deleteChannel: async (id: string) => { record('deleteChannel', { id }); return { error: writeError }; },
  getChannelById: async (id: string) => { record('getChannelById', { id }); return { data: channel }; },
  listChannels: async () => ({ data: [] }),
  listMessages: async (channelId: string, limit: number, before: any) => {
    record('listMessages', { channelId, limit, before });
    return { data: messagesNewestFirst, error: writeError };
  },
  createInvite: async (row: any) => { record('createInvite', { row }); return createInviteResult; },
  listInvites: async () => ({ data: [{ code: 'abc' }], error: writeError }),
  getInvite: async (code: string) => { record('getInvite', { code }); return { data: invite }; },
  incrementInviteUses: async (code: string, uses: number) => { record('incrementInviteUses', { code, uses }); return { error: null }; },
});

let messagesNewestFirst: any = [];

// Send/delete delegate to serverMessaging (covered in its own test file); here
// we only care that the router translates its result to HTTP + a broadcast.
let sendResult: any;
let deleteResult: any;
stubModule(require.resolve('../../src/services/serverMessaging'), {
  sendChannelMessage: async (userId: string, channelId: string, content: any) => {
    record('sendChannelMessage', { userId, channelId, content });
    return sendResult;
  },
  deleteChannelMessage: async (userId: string, messageId: string) => {
    record('deleteChannelMessage', { userId, messageId });
    return deleteResult;
  },
});

const emits: any[] = [];
stubModule(require.resolve('../../src/socket/registry'), {
  getIO: () => ({ to: (room: string) => ({ emit: (event: string, payload: any) => emits.push({ room, event, payload }) }) }),
  setIO: () => {},
});

const { PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, ALL_PERMISSIONS } = require('../../src/services/serverPermissions');
const serversRouter = require('../../src/routes/servers');

const SERVER_ID = 'srv-1';
const OWNER = 'owner-1';
const OTHER_SERVER = 'srv-other';
let CALLER = 'caller-1';

describe('Servers routes (/api/servers)', () => {
  let app: any;
  let token: string;

  before(() => {
    app = buildTestApp({ '/api/servers': serversRouter });
  });

  beforeEach(() => {
    calls.length = 0;
    emits.length = 0;
    // Per-user rate limiters (create-server 10/h, message 12/10s, invite 10/min)
    // use a process-wide in-memory store in tests — a fresh caller per test
    // keeps them from throttling each other.
    CALLER = `caller-${crypto.randomUUID()}`;
    ({ token } = signAccessToken({ id: CALLER, username: 'caller' }));

    server = { id: SERVER_ID, owner_id: OWNER, name: 'My server' };
    member = { user_id: CALLER, is_banned: false };
    targetMember = { user_id: 'target-1', is_banned: false };
    permissionMask = DEFAULT_EVERYONE_PERMISSIONS;
    channel = { id: 'chan-1', server_id: SERVER_ID, type: 'text', slow_mode_seconds: 0 };
    role = { id: 'role-1', server_id: SERVER_ID, is_default: false };
    invite = { code: 'abc12345', server_id: SERVER_ID, uses: 0, max_uses: null, expires_at: null };
    writeError = null;
    createServerResult = { data: { id: SERVER_ID, name: 'My server' }, error: null };
    createInviteResult = { data: { code: 'abc12345' }, error: null };
    messagesNewestFirst = [];
    sendResult = { ok: true, message: { id: 'msg-1', content: 'hi' } };
    deleteResult = { ok: true, channelId: 'chan-1' };
  });

  const asOwner = () => { CALLER = OWNER; ({ token } = signAccessToken({ id: OWNER, username: 'owner' })); member = { user_id: OWNER, is_banned: false }; };
  const req = () => request(app);
  const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);

  // ── Access control shared by every /:id route ───────────────────────────
  describe('access control (loadContext)', () => {
    it('requires authentication', async () => {
      const res = await req().get(`/api/servers/${SERVER_ID}`);
      assert.equal(res.status, 401);
    });

    it('404s a server that does not exist', async () => {
      server = null;
      const res = await auth(req().get(`/api/servers/${SERVER_ID}`));
      assert.equal(res.status, 404);
    });

    it('404s (not 403) a non-member, so server existence stays secret', async () => {
      member = null;
      const res = await auth(req().get(`/api/servers/${SERVER_ID}`));

      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'Server not found');
    });

    it('403s a banned member', async () => {
      member = { user_id: CALLER, is_banned: true };
      const res = await auth(req().get(`/api/servers/${SERVER_ID}`));

      assert.equal(res.status, 403);
      assert.match(res.body.error, /banned/i);
    });

    it('gives the owner every permission without consulting their roles', async () => {
      asOwner();
      const res = await auth(req().get(`/api/servers/${SERVER_ID}`));

      assert.equal(res.status, 200);
      assert.equal(res.body.isOwner, true);
      assert.equal(res.body.myPermissions, ALL_PERMISSIONS);
    });

    it('reports an ordinary member\'s own mask', async () => {
      const res = await auth(req().get(`/api/servers/${SERVER_ID}`));

      assert.equal(res.status, 200);
      assert.equal(res.body.isOwner, false);
      assert.equal(res.body.myPermissions, DEFAULT_EVERYONE_PERMISSIONS);
    });
  });

  // ── Servers ─────────────────────────────────────────────────────────────
  describe('POST /api/servers', () => {
    it('rejects an empty or over-long name', async () => {
      for (const name of ['', '   ', 'x'.repeat(61)]) {
        const res = await auth(req().post('/api/servers')).send({ name });
        assert.equal(res.status, 400, `name ${JSON.stringify(name)} should be rejected`);
      }
      assert.ok(!wrote('createServer'));
    });

    it('seeds @everyone, the owner\'s membership and #general', async () => {
      const res = await auth(req().post('/api/servers')).send({ name: 'My server' });

      assert.equal(res.status, 201);

      const role = calls.find((c) => c.fn === 'createRole');
      assert.equal(role.row.name, '@everyone');
      assert.equal(role.row.is_default, true);
      assert.equal(role.row.permissions, DEFAULT_EVERYONE_PERMISSIONS);

      assert.ok(calls.some((c) => c.fn === 'addMember' && c.row.user_id === CALLER));
      assert.ok(calls.some((c) => c.fn === 'createChannel' && c.row.name === 'general' && c.row.type === 'text'));
    });

    it('makes the caller the owner regardless of any owner_id in the body', async () => {
      await auth(req().post('/api/servers')).send({ name: 'My server', owner_id: 'someone-else' });

      const create = calls.find((c) => c.fn === 'createServer');
      assert.equal(create.row.owner_id, CALLER);
    });

    it('truncates the icon emoji to 8 chars', async () => {
      await auth(req().post('/api/servers')).send({ name: 'My server', iconEmoji: 'x'.repeat(30) });

      const create = calls.find((c) => c.fn === 'createServer');
      assert.equal(create.row.icon_emoji.length, 8);
    });

    it('500s when the server cannot be created, and seeds nothing', async () => {
      createServerResult = { data: null, error: { message: 'db down' } };

      const res = await auth(req().post('/api/servers')).send({ name: 'My server' });

      assert.equal(res.status, 500);
      assert.ok(!wrote('createRole'));
      assert.ok(!wrote('addMember'));
    });
  });

  describe('PATCH /api/servers/:id', () => {
    it('refuses a member without MANAGE_SERVER', async () => {
      const res = await auth(req().patch(`/api/servers/${SERVER_ID}`)).send({ name: 'Renamed' });

      assert.equal(res.status, 403);
      assert.ok(!wrote('updateServer'));
    });

    it('renames the server for someone with MANAGE_SERVER', async () => {
      permissionMask = PERMISSIONS.MANAGE_SERVER;

      const res = await auth(req().patch(`/api/servers/${SERVER_ID}`)).send({ name: 'Renamed' });

      assert.equal(res.status, 200);
      const update = calls.find((c) => c.fn === 'updateServer');
      assert.equal(update.patch.name, 'Renamed');
    });

    it('rejects an invalid name even with permission', async () => {
      permissionMask = PERMISSIONS.MANAGE_SERVER;

      const res = await auth(req().patch(`/api/servers/${SERVER_ID}`)).send({ name: 'x'.repeat(61) });

      assert.equal(res.status, 400);
      assert.ok(!wrote('updateServer'));
    });
  });

  describe('DELETE /api/servers/:id', () => {
    it('refuses an admin who is not the owner', async () => {
      permissionMask = PERMISSIONS.ADMINISTRATOR;

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}`));

      // ADMINISTRATOR implies every *permission*, but deleting the whole
      // server is owner-only — an admin must not be able to nuke it.
      assert.equal(res.status, 403);
      assert.ok(!wrote('deleteServer'));
    });

    it('lets the owner delete it', async () => {
      asOwner();

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}`));

      assert.equal(res.status, 200);
      assert.ok(wrote('deleteServer'));
    });
  });

  // ── Channels ────────────────────────────────────────────────────────────
  describe('channels', () => {
    it('refuses to create a channel without MANAGE_CHANNELS', async () => {
      const res = await auth(req().post(`/api/servers/${SERVER_ID}/channels`)).send({ name: 'general' });

      assert.equal(res.status, 403);
      assert.ok(!wrote('createChannel'));
    });

    it('creates a channel and clamps slow-mode to the 6-hour cap', async () => {
      permissionMask = PERMISSIONS.MANAGE_CHANNELS;

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/channels`))
        .send({ name: 'general', slowModeSeconds: 999_999 });

      assert.equal(res.status, 201);
      const create = calls.find((c) => c.fn === 'createChannel');
      assert.equal(create.row.slow_mode_seconds, 21600);
    });

    it('clamps a negative slow-mode to zero', async () => {
      permissionMask = PERMISSIONS.MANAGE_CHANNELS;

      await auth(req().post(`/api/servers/${SERVER_ID}/channels`)).send({ name: 'general', slowModeSeconds: -5 });

      const create = calls.find((c) => c.fn === 'createChannel');
      assert.equal(create.row.slow_mode_seconds, 0);
    });

    it('defaults an unknown channel type to text', async () => {
      permissionMask = PERMISSIONS.MANAGE_CHANNELS;

      await auth(req().post(`/api/servers/${SERVER_ID}/channels`)).send({ name: 'general', type: 'nonsense' });

      const create = calls.find((c) => c.fn === 'createChannel');
      assert.equal(create.row.type, 'text');
    });

    it('404s a channel that belongs to a different server', async () => {
      permissionMask = PERMISSIONS.MANAGE_CHANNELS;
      channel = { id: 'chan-x', server_id: OTHER_SERVER, type: 'text' };

      const res = await auth(req().patch(`/api/servers/${SERVER_ID}/channels/chan-x`)).send({ name: 'hijacked' });

      // Cross-server IDOR: having MANAGE_CHANNELS here must not let you edit
      // a channel in a server you don't administer.
      assert.equal(res.status, 404);
      assert.ok(!wrote('updateChannel'));
    });

    it('refuses to delete a channel without MANAGE_CHANNELS', async () => {
      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/channels/chan-1`));

      assert.equal(res.status, 403);
      assert.ok(!wrote('deleteChannel'));
    });

    it('deletes a channel with MANAGE_CHANNELS', async () => {
      permissionMask = PERMISSIONS.MANAGE_CHANNELS;

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/channels/chan-1`));

      assert.equal(res.status, 200);
      assert.ok(wrote('deleteChannel'));
    });
  });

  // ── Messages ────────────────────────────────────────────────────────────
  describe('messages', () => {
    it('refuses history to a member without VIEW_CHANNELS', async () => {
      permissionMask = PERMISSIONS.SEND_MESSAGES;

      const res = await auth(req().get(`/api/servers/${SERVER_ID}/channels/chan-1/messages`));

      assert.equal(res.status, 403);
      assert.ok(!wrote('listMessages'));
    });

    it('returns history oldest-first for rendering', async () => {
      messagesNewestFirst = [{ id: 'm3' }, { id: 'm2' }, { id: 'm1' }];

      const res = await auth(req().get(`/api/servers/${SERVER_ID}/channels/chan-1/messages`));

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.messages.map((m: any) => m.id), ['m1', 'm2', 'm3']);
    });

    it('clamps the page size to 100 and defaults to 50', async () => {
      await auth(req().get(`/api/servers/${SERVER_ID}/channels/chan-1/messages?limit=5000`));
      assert.equal(calls.find((c) => c.fn === 'listMessages').limit, 100);

      calls.length = 0;
      await auth(req().get(`/api/servers/${SERVER_ID}/channels/chan-1/messages`));
      assert.equal(calls.find((c) => c.fn === 'listMessages').limit, 50);
    });

    it('404s history for a channel in another server', async () => {
      channel = { id: 'chan-x', server_id: OTHER_SERVER, type: 'text' };

      const res = await auth(req().get(`/api/servers/${SERVER_ID}/channels/chan-x/messages`));

      assert.equal(res.status, 404);
      assert.ok(!wrote('listMessages'));
    });

    it('posts a message and fans it out to the channel room', async () => {
      const res = await auth(req().post(`/api/servers/${SERVER_ID}/channels/chan-1/messages`)).send({ content: 'hi' });

      assert.equal(res.status, 201);
      assert.deepEqual(res.body.message, { id: 'msg-1', content: 'hi' });
      assert.deepEqual(emits, [{ room: 'server:chan:chan-1', event: 'server:message', payload: { id: 'msg-1', content: 'hi' } }]);
    });

    it('posts on behalf of the authenticated user, not a body-supplied id', async () => {
      await auth(req().post(`/api/servers/${SERVER_ID}/channels/chan-1/messages`))
        .send({ content: 'hi', userId: 'someone-else' });

      assert.equal(calls.find((c) => c.fn === 'sendChannelMessage').userId, CALLER);
    });

    it('mirrors the refusal status from serverMessaging and broadcasts nothing', async () => {
      sendResult = { ok: false, status: 403, error: 'Missing permission' };

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/channels/chan-1/messages`)).send({ content: 'hi' });

      assert.equal(res.status, 403);
      assert.equal(emits.length, 0);
    });

    it('passes slow-mode retryAfter through to the client', async () => {
      sendResult = { ok: false, status: 429, error: 'Slow mode active', retryAfter: 7 };

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/channels/chan-1/messages`)).send({ content: 'hi' });

      assert.equal(res.status, 429);
      assert.equal(res.body.retryAfter, 7);
    });

    it('throttles a client posting faster than 12 messages / 10s', async () => {
      let throttled = 0;
      for (let i = 0; i < 15; i++) {
        const res = await auth(req().post(`/api/servers/${SERVER_ID}/channels/chan-1/messages`)).send({ content: `m${i}` });
        if (res.status === 429) throttled += 1;
      }
      assert.ok(throttled > 0, 'expected the per-user message limiter to kick in');
    });

    it('broadcasts a deletion into the channel the message really lived in', async () => {
      deleteResult = { ok: true, channelId: 'chan-real' };

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/messages/msg-1`));

      assert.equal(res.status, 200);
      assert.equal(emits[0].room, 'server:chan:chan-real');
      assert.equal(emits[0].event, 'server:message:deleted');
    });

    it('mirrors a delete refusal and broadcasts nothing', async () => {
      deleteResult = { ok: false, status: 403, error: 'Missing permission' };

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/messages/msg-1`));

      assert.equal(res.status, 403);
      assert.equal(emits.length, 0);
    });
  });

  // ── Roles ───────────────────────────────────────────────────────────────
  describe('roles', () => {
    it('refuses role creation without MANAGE_ROLES', async () => {
      const res = await auth(req().post(`/api/servers/${SERVER_ID}/roles`)).send({ name: 'Mod' });

      assert.equal(res.status, 403);
      assert.ok(!wrote('createRole'));
    });

    it('will not let a moderator grant permissions they do not hold themselves', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES | PERMISSIONS.KICK_MEMBERS;

      await auth(req().post(`/api/servers/${SERVER_ID}/roles`))
        .send({ name: 'Mod', permissions: ALL_PERMISSIONS });

      // Privilege escalation guard: without this clamp, anyone with
      // MANAGE_ROLES could mint an ADMINISTRATOR role and take the server.
      const created = calls.find((c) => c.fn === 'createRole');
      assert.equal(created.row.permissions, permissionMask);
      assert.equal(created.row.permissions & PERMISSIONS.ADMINISTRATOR, 0);
      assert.equal(created.row.permissions & PERMISSIONS.BAN_MEMBERS, 0);
    });

    it('lets an ADMINISTRATOR grant anything', async () => {
      permissionMask = PERMISSIONS.ADMINISTRATOR;

      await auth(req().post(`/api/servers/${SERVER_ID}/roles`))
        .send({ name: 'Mod', permissions: ALL_PERMISSIONS });

      assert.equal(calls.find((c) => c.fn === 'createRole').row.permissions, ALL_PERMISSIONS);
    });

    it('lets the owner grant anything', async () => {
      asOwner();

      await auth(req().post(`/api/servers/${SERVER_ID}/roles`))
        .send({ name: 'Mod', permissions: ALL_PERMISSIONS });

      assert.equal(calls.find((c) => c.fn === 'createRole').row.permissions, ALL_PERMISSIONS);
    });

    it('masks off bits that are not real permissions', async () => {
      asOwner();

      await auth(req().post(`/api/servers/${SERVER_ID}/roles`))
        .send({ name: 'Mod', permissions: 0xffffffff });

      assert.equal(calls.find((c) => c.fn === 'createRole').row.permissions, ALL_PERMISSIONS);
    });

    it('ignores a malformed colour', async () => {
      asOwner();

      await auth(req().post(`/api/servers/${SERVER_ID}/roles`)).send({ name: 'Mod', color: 'red' });

      assert.equal(calls.find((c) => c.fn === 'createRole').row.color, null);
    });

    it('applies the same escalation clamp when editing a role', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;

      await auth(req().patch(`/api/servers/${SERVER_ID}/roles/role-1`))
        .send({ permissions: ALL_PERMISSIONS });

      const update = calls.find((c) => c.fn === 'updateRole');
      assert.equal(update.patch.permissions, PERMISSIONS.MANAGE_ROLES);
    });

    it('404s a role belonging to another server', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;
      role = { id: 'role-x', server_id: OTHER_SERVER, is_default: false };

      const res = await auth(req().patch(`/api/servers/${SERVER_ID}/roles/role-x`)).send({ name: 'hijacked' });

      assert.equal(res.status, 404);
      assert.ok(!wrote('updateRole'));
    });

    it('refuses to delete the @everyone role', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;
      role = { id: 'role-everyone', server_id: SERVER_ID, is_default: true };

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/roles/role-everyone`));

      assert.equal(res.status, 400);
      assert.ok(!wrote('deleteRole'));
    });

    it('deletes an ordinary role with MANAGE_ROLES', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/roles/role-1`));

      assert.equal(res.status, 200);
      assert.ok(wrote('deleteRole'));
    });
  });

  // ── Members ─────────────────────────────────────────────────────────────
  describe('members', () => {
    it('lists members for any member', async () => {
      const res = await auth(req().get(`/api/servers/${SERVER_ID}/members`));
      assert.equal(res.status, 200);
      assert.equal(res.body.members.length, 1);
    });

    it('refuses role assignment without MANAGE_ROLES', async () => {
      const res = await auth(req().post(`/api/servers/${SERVER_ID}/members/target-1/roles`)).send({ roleId: 'role-1' });

      assert.equal(res.status, 403);
      assert.ok(!wrote('assignRole'));
    });

    it('assigns a role to a member', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/members/target-1/roles`)).send({ roleId: 'role-1' });

      assert.equal(res.status, 200);
      assert.ok(calls.some((c) => c.fn === 'assignRole' && c.userId === 'target-1' && c.roleId === 'role-1'));
    });

    it('removes a role when asked to', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;

      await auth(req().post(`/api/servers/${SERVER_ID}/members/target-1/roles`))
        .send({ roleId: 'role-1', action: 'remove' });

      assert.ok(wrote('unassignRole'));
      assert.ok(!wrote('assignRole'));
    });

    it('refuses to assign the @everyone role', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;
      role = { id: 'role-everyone', server_id: SERVER_ID, is_default: true };

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/members/target-1/roles`)).send({ roleId: 'role-everyone' });

      assert.equal(res.status, 400);
      assert.ok(!wrote('assignRole'));
    });

    it('404s assigning a role from another server', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;
      role = { id: 'role-x', server_id: OTHER_SERVER, is_default: false };

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/members/target-1/roles`)).send({ roleId: 'role-x' });

      assert.equal(res.status, 404);
      assert.ok(!wrote('assignRole'));
    });

    it('404s assigning a role to a non-member', async () => {
      permissionMask = PERMISSIONS.MANAGE_ROLES;
      targetMember = null;

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/members/target-1/roles`)).send({ roleId: 'role-1' });

      assert.equal(res.status, 404);
      assert.ok(!wrote('assignRole'));
    });

    it('requires KICK_MEMBERS to kick', async () => {
      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/members/target-1`));

      assert.equal(res.status, 403);
      assert.ok(!wrote('removeMember'));
    });

    it('requires BAN_MEMBERS (not merely KICK_MEMBERS) to ban', async () => {
      permissionMask = PERMISSIONS.KICK_MEMBERS;

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/members/target-1?ban=true`));

      // Kicking is recoverable; banning is not — the stronger permission must
      // be required, and a kicker must not be able to ban by adding a query arg.
      assert.equal(res.status, 403);
      assert.ok(!wrote('updateMember'));
    });

    it('kicks a member with KICK_MEMBERS', async () => {
      permissionMask = PERMISSIONS.KICK_MEMBERS;

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/members/target-1`));

      assert.equal(res.status, 200);
      assert.ok(calls.some((c) => c.fn === 'removeMember' && c.userId === 'target-1'));
      assert.ok(!wrote('updateMember'));
    });

    it('bans a member with BAN_MEMBERS', async () => {
      permissionMask = PERMISSIONS.BAN_MEMBERS;

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/members/target-1?ban=true`));

      assert.equal(res.status, 200);
      assert.ok(calls.some((c) => c.fn === 'updateMember' && c.patch.is_banned === true));
    });

    it('refuses to remove the owner, even for an administrator', async () => {
      permissionMask = PERMISSIONS.ADMINISTRATOR;

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/members/${OWNER}?ban=true`));

      assert.equal(res.status, 403);
      assert.ok(!wrote('updateMember'));
      assert.ok(!wrote('removeMember'));
    });

    it('tells a self-kick to use leave instead', async () => {
      permissionMask = PERMISSIONS.KICK_MEMBERS;

      const res = await auth(req().delete(`/api/servers/${SERVER_ID}/members/${CALLER}`));

      assert.equal(res.status, 400);
      assert.ok(!wrote('removeMember'));
    });
  });

  describe('POST /api/servers/:id/leave', () => {
    it('lets an ordinary member leave', async () => {
      const res = await auth(req().post(`/api/servers/${SERVER_ID}/leave`));

      assert.equal(res.status, 200);
      assert.ok(calls.some((c) => c.fn === 'removeMember' && c.userId === CALLER));
    });

    it('refuses to let the owner leave (they must delete the server)', async () => {
      asOwner();

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/leave`));

      // An owner who left would orphan the server: nobody could ever delete it.
      assert.equal(res.status, 400);
      assert.ok(!wrote('removeMember'));
    });
  });

  // ── Invites ─────────────────────────────────────────────────────────────
  describe('invites', () => {
    it('refuses invite creation without CREATE_INVITE', async () => {
      permissionMask = PERMISSIONS.VIEW_CHANNELS;

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/invites`)).send({});

      assert.equal(res.status, 403);
      assert.ok(!wrote('createInvite'));
    });

    it('creates an invite with an 8-char code', async () => {
      const res = await auth(req().post(`/api/servers/${SERVER_ID}/invites`)).send({});

      assert.equal(res.status, 201);
      assert.equal(calls.find((c) => c.fn === 'createInvite').row.code.length, 8);
    });

    it('clamps maxUses and expiry to their caps', async () => {
      await auth(req().post(`/api/servers/${SERVER_ID}/invites`)).send({ maxUses: 99_999, expiresInHours: 99_999 });

      const row = calls.find((c) => c.fn === 'createInvite').row;
      assert.equal(row.max_uses, 1000);
      const hours = (new Date(row.expires_at).getTime() - Date.now()) / 3600_000;
      assert.ok(hours <= 720 && hours > 719);
    });

    it('defaults to a never-expiring, unlimited invite', async () => {
      await auth(req().post(`/api/servers/${SERVER_ID}/invites`)).send({});

      const row = calls.find((c) => c.fn === 'createInvite').row;
      assert.equal(row.max_uses, null);
      assert.equal(row.expires_at, null);
    });

    it('retries on a code collision, then gives up with a 500', async () => {
      createInviteResult = { data: null, error: { message: 'duplicate key' } };

      const res = await auth(req().post(`/api/servers/${SERVER_ID}/invites`)).send({});

      assert.equal(res.status, 500);
      assert.equal(calls.filter((c) => c.fn === 'createInvite').length, 3);
      // Each retry must use a fresh code, or retrying is pointless.
      const codes = calls.filter((c) => c.fn === 'createInvite').map((c) => c.row.code);
      assert.equal(new Set(codes).size, 3);
    });

    it('requires MANAGE_SERVER to list invites', async () => {
      const res = await auth(req().get(`/api/servers/${SERVER_ID}/invites`));
      assert.equal(res.status, 403);
    });

    it('lists invites for someone with MANAGE_SERVER', async () => {
      permissionMask = PERMISSIONS.MANAGE_SERVER;

      const res = await auth(req().get(`/api/servers/${SERVER_ID}/invites`));

      assert.equal(res.status, 200);
      assert.equal(res.body.invites.length, 1);
    });
  });

  describe('POST /api/servers/join/:code', () => {
    beforeEach(() => {
      member = null; // not yet a member of the server being joined
    });

    it('404s an unknown code', async () => {
      invite = null;

      const res = await auth(req().post('/api/servers/join/nope1234'));

      assert.equal(res.status, 404);
      assert.ok(!wrote('addMember'));
    });

    it('410s an expired invite', async () => {
      invite = { ...invite, expires_at: new Date(Date.now() - 1000).toISOString() };

      const res = await auth(req().post('/api/servers/join/abc12345'));

      assert.equal(res.status, 410);
      assert.ok(!wrote('addMember'));
    });

    it('410s a fully-used invite', async () => {
      invite = { ...invite, uses: 5, max_uses: 5 };

      const res = await auth(req().post('/api/servers/join/abc12345'));

      assert.equal(res.status, 410);
      assert.ok(!wrote('addMember'));
    });

    it('refuses a banned user even with a valid invite', async () => {
      member = { user_id: CALLER, is_banned: true };

      const res = await auth(req().post('/api/servers/join/abc12345'));

      // Otherwise a ban is trivially undone by asking anyone for an invite.
      assert.equal(res.status, 403);
      assert.ok(!wrote('addMember'));
    });

    it('adds the member and counts the use', async () => {
      const res = await auth(req().post('/api/servers/join/abc12345'));

      assert.equal(res.status, 200);
      assert.ok(calls.some((c) => c.fn === 'addMember' && c.row.user_id === CALLER));
      assert.ok(calls.some((c) => c.fn === 'incrementInviteUses' && c.code === 'abc12345'));
    });

    it('is idempotent for an existing member and does not burn a use', async () => {
      member = { user_id: CALLER, is_banned: false };

      const res = await auth(req().post('/api/servers/join/abc12345'));

      assert.equal(res.status, 200);
      assert.ok(!wrote('addMember'));
      assert.ok(!wrote('incrementInviteUses'));
    });

    it('500s and burns no use when the membership insert fails', async () => {
      writeError = { message: 'db down' };

      const res = await auth(req().post('/api/servers/join/abc12345'));

      assert.equal(res.status, 500);
      assert.ok(!wrote('incrementInviteUses'));
    });
  });
});

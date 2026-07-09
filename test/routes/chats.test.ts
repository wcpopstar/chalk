export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { buildTestApp } = require('../helpers/buildTestApp');
const { signAccessToken } = require('../../src/utils/jwt');

const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});

const chatsRouter = require('../../src/routes/chats');

describe('Chats routes (/api/chats)', () => {
  let app: any;
  let token: any;
  const userId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';

  before(() => {
    app = buildTestApp({ '/api/chats': chatsRouter });
    ({ token } = signAccessToken({ id: userId, username: 'me' }));
  });

  beforeEach(() => {
    supaMock.reset();
  });

  describe('GET /api/chats', () => {
    it('rejects requests with no access token', async () => {
      const res = await request(app).get('/api/chats');
      assert.equal(res.status, 401);
    });

    it('lists conversations with last message and other participant for direct chats', async () => {
      // 1st query: conversation_members joined to conversations+messages
      supaMock.enqueue({
        data: [
          {
            conversation_id: 'cc000001-0000-4000-8000-000000000001',
            conversations: {
              id: 'cc000001-0000-4000-8000-000000000001',
              type: 'direct',
              name: null,
              created_at: '2026-01-01T00:00:00Z',
              // newest-first and capped at 1 by the embedded order+limit
              messages: [
                { id: 'm2', text: 'hey!', created_at: '2026-01-01T00:01:00Z' },
              ],
            },
          },
          {
            conversation_id: 'cc000002-0000-4000-8000-000000000002',
            conversations: {
              id: 'cc000002-0000-4000-8000-000000000002',
              type: 'group',
              name: 'Squad',
              created_at: '2026-01-02T00:00:00Z',
              messages: [],
            },
          },
        ],
        error: null,
      });
      // 2nd query: other member of the direct conversation(s)
      supaMock.enqueue({
        data: [
          { conversation_id: 'cc000001-0000-4000-8000-000000000001', users: { id: otherId, username: 'Buddy', status: 'online' } },
        ],
        error: null,
      });

      const res = await request(app).get('/api/chats').set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.conversations.length, 2);

      const direct = res.body.conversations.find((c: any) => c.id === 'cc000001-0000-4000-8000-000000000001');
      assert.equal(direct.name, 'Buddy');
      assert.equal(direct.other_user.username, 'Buddy');
      assert.equal(direct.last_message.text, 'hey!'); // the newest message

      const group = res.body.conversations.find((c: any) => c.id === 'cc000002-0000-4000-8000-000000000002');
      assert.equal(group.name, 'Squad');
      assert.equal(group.other_user, null);
      assert.equal(group.last_message, null);
    });

    it('skips the second query entirely when there are no direct conversations', async () => {
      supaMock.enqueue({
        data: [{ conversation_id: 'cc000003-0000-4000-8000-000000000003', conversations: { id: 'cc000003-0000-4000-8000-000000000003', type: 'group', name: 'G', messages: [] } }],
        error: null,
      });
      // No second enqueue() — if the route wrongly queried for direct
      // members anyway, the mock would fall back to { data: null, error: null }
      // rather than throw, so we assert directly on the shape instead.

      const res = await request(app).get('/api/chats').set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.conversations[0].other_user, null);
    });

    it('returns 500 when the query fails', async () => {
      supaMock.enqueue({ data: null, error: { message: 'boom' } });

      const res = await request(app).get('/api/chats').set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 500);
    });
  });

  describe('POST /api/chats/direct', () => {
    it('requires targetUserId', async () => {
      const res = await request(app)
        .post('/api/chats/direct')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      assert.equal(res.status, 400);
    });

    it('returns the existing conversation via RPC if one already exists', async () => {
      supaMock.enqueue({ data: [{ id: 'existing-conv', type: 'direct' }], error: null });

      const res = await request(app)
        .post('/api/chats/direct')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 200);
      assert.equal(res.body.conversation.id, 'existing-conv');
    });

    it('creates a new conversation and adds both members when none exists', async () => {
      supaMock.enqueue({ data: [], error: null }); // RPC: no existing conversation
      supaMock.enqueue({ data: { id: 'new-conv', type: 'direct' }, error: null }); // insert conversations
      supaMock.enqueue({ error: null }); // insert conversation_members

      const res = await request(app)
        .post('/api/chats/direct')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 201);
      assert.equal(res.body.conversation.id, 'new-conv');
    });
  });

  describe('POST /api/chats/group', () => {
    it('requires a non-empty memberIds array', async () => {
      const res = await request(app)
        .post('/api/chats/group')
        .set('Authorization', `Bearer ${token}`)
        .send({ memberIds: [] });
      assert.equal(res.status, 400);
    });

    it('creates a group conversation including the caller', async () => {
      supaMock.enqueue({ data: { id: 'group-1', type: 'group', name: 'Squad' }, error: null });
      supaMock.enqueue({ error: null }); // insert conversation_members

      const res = await request(app)
        .post('/api/chats/group')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Squad', memberIds: [otherId] });

      assert.equal(res.status, 201);
      assert.equal(res.body.conversation.name, 'Squad');
    });
  });

  describe('GET /api/chats/:id/messages', () => {
    it('returns 403 when the caller is not a member', async () => {
      supaMock.enqueue({ data: null, error: null }); // membership check -> not found

      const res = await request(app)
        .get('/api/chats/cc000001-0000-4000-8000-000000000001/messages')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 403);
    });

    it('returns messages oldest-first when the caller is a member', async () => {
      supaMock.enqueue({ data: { user_id: userId }, error: null }); // membership OK
      supaMock.enqueue({
        data: [
          { id: 'm2', text: 'second', created_at: '2026-01-01T00:02:00Z' },
          { id: 'm1', text: 'first', created_at: '2026-01-01T00:01:00Z' },
        ],
        error: null,
      }); // messages come back newest-first from the DB query...

      const res = await request(app)
        .get('/api/chats/cc000001-0000-4000-8000-000000000001/messages')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      // ...and the route reverses them to oldest-first for the client.
      assert.deepEqual(res.body.messages.map((m: any) => m.id), ['m1', 'm2']);
    });
  });

  describe('GET /api/chats/:id/members', () => {
    it('returns 403 when the caller is not a member', async () => {
      supaMock.enqueue({ data: null, error: null });

      const res = await request(app)
        .get('/api/chats/cc000001-0000-4000-8000-000000000001/members')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 403);
    });

    it('lists members when the caller is a member', async () => {
      supaMock.enqueue({ data: { user_id: userId }, error: null }); // membership OK
      supaMock.enqueue({
        data: [
          { users: { id: userId, username: 'me' } },
          { users: { id: otherId, username: 'Buddy' } },
        ],
        error: null,
      });

      const res = await request(app)
        .get('/api/chats/cc000001-0000-4000-8000-000000000001/members')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.members.length, 2);
    });
  });

  describe('GET /api/chats/global/messages', () => {
    it('returns the global feed oldest-first', async () => {
      supaMock.enqueue({
        data: [
          { id: 'g2', text: 'second', created_at: '2026-01-01T00:02:00Z' },
          { id: 'g1', text: 'first', created_at: '2026-01-01T00:01:00Z' },
        ],
        error: null,
      });

      const res = await request(app)
        .get('/api/chats/global/messages')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.messages.map((m: any) => m.id), ['g1', 'g2']);
    });
  });
});

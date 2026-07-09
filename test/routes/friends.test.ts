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

// src/routes/friends.js does `require('../socket/state')` for
// wereRecentCallPartners(), and socket/state.js in turn opens a real
// ioredis connection at require time (src/socket/redisClient.js) — not
// something we want happening in a test process. Stub the whole module out
// with a controllable fake before friends.js is ever required.
let wereRecentCallPartnersResult = true;
stubModule(require.resolve('../../src/socket/state'), {
  wereRecentCallPartners: async () => wereRecentCallPartnersResult,
});

const friendsRouter = require('../../src/routes/friends');

describe('Friends routes (/api/friends)', () => {
  let app: any;
  let token: any;
  const userId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';

  before(() => {
    app = buildTestApp({ '/api/friends': friendsRouter });
    ({ token } = signAccessToken({ id: userId, username: 'me' }));
  });

  beforeEach(() => {
    supaMock.reset();
    wereRecentCallPartnersResult = true;
  });

  describe('GET /api/friends', () => {
    it('rejects requests with no access token', async () => {
      const res = await request(app).get('/api/friends');
      assert.equal(res.status, 401);
    });

    it('normalises rows so "friend" is always the other person, and flags incoming requests', async () => {
      supaMock.enqueue({
        data: [
          {
            id: 'ff111111-1111-4111-8111-111111111111', status: 'accepted', created_at: '2026-01-01',
            user_a_profile: { id: userId, username: 'me' },
            user_b_profile: { id: otherId, username: 'Buddy' },
          },
          {
            id: 'f2', status: 'pending', created_at: '2026-01-02',
            user_a_profile: { id: otherId, username: 'Requester' }, // they sent it to me
            user_b_profile: { id: userId, username: 'me' },
          },
        ],
        error: null,
      });

      const res = await request(app).get('/api/friends').set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.friends[0].friend.username, 'Buddy');
      assert.equal(res.body.friends[0].incoming, false); // I am user_a here

      assert.equal(res.body.friends[1].friend.username, 'Requester');
      assert.equal(res.body.friends[1].incoming, true); // I am user_b (recipient)
    });
  });

  describe('POST /api/friends/request', () => {
    it('rejects adding yourself', async () => {
      const res = await request(app)
        .post('/api/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: userId });
      assert.equal(res.status, 400);
    });

    it('rejects when the target has blocked (or is blocked by) the caller', async () => {
      supaMock.enqueue({ data: [{ id: 'block-row' }], error: null }); // areUsersBlocked -> true

      const res = await request(app)
        .post('/api/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 403);
    });

    it('returns 409 with alreadyFriend when already accepted', async () => {
      supaMock.enqueue({ data: [], error: null }); // not blocked
      supaMock.enqueue({ data: [{ id: 'ff111111-1111-4111-8111-111111111111', status: 'accepted' }], error: null }); // existing row

      const res = await request(app)
        .post('/api/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 409);
      assert.equal(res.body.alreadyFriend, true);
    });

    it('returns 409 when a pending request already exists', async () => {
      supaMock.enqueue({ data: [], error: null }); // not blocked
      supaMock.enqueue({ data: [{ id: 'ff111111-1111-4111-8111-111111111111', status: 'pending' }], error: null }); // existing row

      const res = await request(app)
        .post('/api/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 409);
      assert.equal(res.body.status, 'pending');
    });

    it('creates a pending request when none exists', async () => {
      supaMock.enqueue({ data: [], error: null }); // not blocked
      supaMock.enqueue({ data: [], error: null }); // no existing rows
      supaMock.enqueue({ data: { id: 'new-req', status: 'pending' }, error: null }); // insert

      const res = await request(app)
        .post('/api/friends/request')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 201);
      assert.equal(res.body.request.status, 'pending');
    });
  });

  describe('PATCH /api/friends/:id/accept', () => {
    it('returns 404 when there is no matching pending request for this recipient', async () => {
      supaMock.enqueue({ data: null, error: null });

      const res = await request(app)
        .patch('/api/friends/ff111111-1111-4111-8111-111111111111/accept')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 404);
    });

    it('accepts a pending request addressed to the caller', async () => {
      supaMock.enqueue({ data: { id: 'ff111111-1111-4111-8111-111111111111', user_a: otherId, user_b: userId, status: 'pending' }, error: null });
      supaMock.enqueue({ error: null }); // update

      const res = await request(app)
        .patch('/api/friends/ff111111-1111-4111-8111-111111111111/accept')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    });
  });

  describe('DELETE /api/friends/:id', () => {
    it('removes a friendship/request the caller is party to', async () => {
      supaMock.enqueue({ error: null });

      const res = await request(app)
        .delete('/api/friends/ff111111-1111-4111-8111-111111111111')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    });
  });

  describe('POST /api/friends/add-after-call', () => {
    it('requires targetUserId', async () => {
      const res = await request(app)
        .post('/api/friends/add-after-call')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      assert.equal(res.status, 400);
    });

    it('rejects adding yourself', async () => {
      const res = await request(app)
        .post('/api/friends/add-after-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: userId });
      assert.equal(res.status, 400);
    });

    it('rejects when there was no recent shared call', async () => {
      wereRecentCallPartnersResult = false;

      const res = await request(app)
        .post('/api/friends/add-after-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 403);
    });

    it('rejects when one user has blocked the other', async () => {
      supaMock.enqueue({ data: [{ id: 'block-row' }], error: null }); // areUsersBlocked -> true

      const res = await request(app)
        .post('/api/friends/add-after-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 403);
    });

    it('instantly befriends recent call partners', async () => {
      supaMock.enqueue({ data: [], error: null }); // not blocked
      supaMock.enqueue({ data: null, error: null }); // addFriendPairInstant: no existing row
      supaMock.enqueue({ error: null }); // upsert

      const res = await request(app)
        .post('/api/friends/add-after-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 201);
      assert.deepEqual(res.body, { ok: true, already: false });
    });

    it('returns 200 with already:true when the friendship already existed and was accepted', async () => {
      supaMock.enqueue({ data: [], error: null }); // not blocked
      supaMock.enqueue({ data: { id: 'ff111111-1111-4111-8111-111111111111', status: 'accepted' }, error: null }); // addFriendPairInstant: already accepted

      const res = await request(app)
        .post('/api/friends/add-after-call')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: otherId });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, already: true });
    });
  });
});

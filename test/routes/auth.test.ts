export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { buildTestApp } = require('../helpers/buildTestApp');

// ── Stub out Supabase + the mailer BEFORE requiring src/routes/auth.js ──────
// src/routes/auth.js (and src/services/refreshTokens.js, which it uses)
// both `require('../services/supabase')` internally. Overriding the module
// cache here means every one of those `require` calls resolves to our
// scriptable mock instead of trying to talk to a real Supabase project.
const supaMock = createSupabaseMock();
stubModule(require.resolve('../../src/services/supabase'), {
  supabaseAdmin: supaMock.supabaseAdmin,
  supabase: {},
});
stubModule(require.resolve('../../src/services/mailer'), {
  sendPasswordResetEmail: async () => {},
  sendCodeEmail: async () => {},
});
// Registration now mails a verification code via services/emailCodes (which
// pulls in the BullMQ email queue + Redis). Stub it so these tests exercise
// only the account-creation contract, not the code-delivery machinery.
stubModule(require.resolve('../../src/services/emailCodes'), {
  issueAndSendCode: async () => {},
  hashCode: (c: string) => c,
  generateCode: () => '000000',
});

const authRouter = require('../../src/routes/auth');

describe('Auth routes (/api/auth)', () => {
  let app: any;

  before(() => {
    app = buildTestApp({ '/api/auth': authRouter });
  });

  beforeEach(() => {
    supaMock.reset();
  });

  describe('POST /api/auth/register', () => {
    it('creates an account and returns a session for a valid payload', async () => {
      supaMock.enqueue({ data: null, error: null }); // existsByUsername: generated candidate is free
      supaMock.enqueue({ data: null, error: null }); // existsByEmailOrUsername: no existing user
      supaMock.enqueue({
        data: { id: 'user-1', username: 'NewPlayer', email: 'newplayer@example.com' },
        error: null,
      }); // insert().select().single()

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'newplayer@example.com', password: 'StrongPass123' });

      // Registration no longer issues a session: the account must confirm the
      // emailed verification code first (POST /verify-email).
      assert.equal(res.status, 201);
      assert.equal(res.body.pendingVerification, true);
      assert.equal(res.body.email, 'newplayer@example.com');
      assert.ok(!res.body.token, 'no session token until the email is verified');
    });

    it('rejects an invalid payload with 400 and does not touch the database', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: '123' });

      assert.equal(res.status, 400);
      assert.ok(Array.isArray(res.body.details));
      assert.ok(res.body.details.length > 0);
    });

    it('rejects a password missing uppercase/digit requirements', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'weak@example.com', password: 'alllowercase' });

      assert.equal(res.status, 400);
    });

    it('returns 409 when the email or username is already taken', async () => {
      supaMock.enqueue({ data: { id: 'existing-user' }, error: null }); // existsByEmailOrUsername

      const res = await request(app)
        .post('/api/auth/register')
        // explicit username: no generation queries, straight to the 409 check
        .send({ email: 'taken@example.com', password: 'StrongPass123', username: 'TakenName' });

      assert.equal(res.status, 409);
    });

    it('generates a username automatically when none is supplied', async () => {
      supaMock.enqueue({ data: null, error: null }); // existsByUsername: first candidate is free
      supaMock.enqueue({ data: null, error: null }); // existsByEmailOrUsername: nothing taken
      supaMock.enqueue({
        data: { id: 'user-2', username: 'SilentViper', email: 'noname@example.com' },
        error: null,
      });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'noname@example.com', password: 'StrongPass123' });

      assert.equal(res.status, 201);
      assert.equal(res.body.pendingVerification, true);
      assert.ok(res.body.identifier, 'expected the generated username as the identifier');
    });

    it('retries with a different candidate when the generated username is taken', async () => {
      supaMock.enqueue({ data: { id: 'someone-else' }, error: null }); // existsByUsername: 1st candidate taken
      supaMock.enqueue({ data: null, error: null });                   // existsByUsername: 2nd candidate free
      supaMock.enqueue({ data: null, error: null });                   // existsByEmailOrUsername
      supaMock.enqueue({
        data: { id: 'user-3', username: 'CrimsonReaper', email: 'retry@example.com' },
        error: null,
      });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'retry@example.com', password: 'StrongPass123' });

      assert.equal(res.status, 201);
      assert.equal(res.body.pendingVerification, true);
      assert.ok(res.body.identifier);
    });
  });

  describe('POST /api/auth/login', () => {
    it('logs in with correct credentials and returns a session', async () => {
      const passwordHash = await bcrypt.hash('CorrectPass123', 12);
      supaMock.enqueue({
        data: {
          id: 'user-1',
          username: 'Player',
          email: 'player@example.com',
          password_hash: passwordHash,
        },
        error: null,
      }); // select user by email
      supaMock.enqueue({ error: null }); // update status -> online
      supaMock.enqueue({ error: null }); // issueRefreshToken insert

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'player@example.com', password: 'CorrectPass123' });

      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.ok(res.body.refreshToken);
      assert.equal(res.body.user.password_hash, undefined, 'password_hash must never be returned');
    });

    it('rejects an incorrect password with 401', async () => {
      const passwordHash = await bcrypt.hash('CorrectPass123', 12);
      supaMock.enqueue({
        data: { id: 'user-1', username: 'Player', email: 'player@example.com', password_hash: passwordHash },
        error: null,
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'player@example.com', password: 'WrongPassword1' });

      assert.equal(res.status, 401);
    });

    it('rejects an unknown email with 401 (not 404 — avoids leaking which emails exist)', async () => {
      supaMock.enqueue({ data: null, error: null });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'CorrectPass123' });

      assert.equal(res.status, 401);
    });

    it('rejects a payload missing the password field with 400', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'player@example.com' });

      assert.equal(res.status, 400);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('exchanges a valid refresh token for a new session (rotation)', async () => {
      supaMock.enqueue({
        data: {
          id: 'row-1',
          user_id: 'user-1',
          family_id: 'family-1',
          revoked_at: null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      }); // lookup refresh token row
      supaMock.enqueue({ error: null }); // issueRefreshToken (new token) insert
      supaMock.enqueue({ error: null }); // mark old row revoked/replaced
      supaMock.enqueue({ data: { id: 'user-1', username: 'Player' }, error: null }); // reload user

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'some-valid-raw-refresh-token' });

      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.ok(res.body.refreshToken);
    });

    it('rejects an unknown refresh token with 401', async () => {
      supaMock.enqueue({ data: null, error: null });

      const res = await request(app).post('/api/auth/refresh').send({ refreshToken: 'unknown-token' });

      assert.equal(res.status, 401);
    });

    it('detects reuse of an already-rotated refresh token and revokes the family', async () => {
      supaMock.enqueue({
        data: {
          id: 'row-1',
          user_id: 'user-1',
          family_id: 'family-1',
          // rotated well OUTSIDE the reuse grace window (see REUSE_GRACE_MS
          // in services/refreshTokens.ts) — this is the theft/replay case
          revoked_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });
      supaMock.enqueue({ error: null }); // revokeFamily() update

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'stolen-and-replayed-token' });

      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'TOKEN_REUSE');
    });

    it('tolerates a duplicate rotation INSIDE the grace window (two tabs racing, not theft)', async () => {
      supaMock.enqueue({
        data: {
          id: 'row-1',
          user_id: 'user-1',
          family_id: 'family-1',
          revoked_at: new Date(Date.now() - 2_000).toISOString(), // rotated 2s ago by the sibling tab
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });
      supaMock.enqueue({ error: null }); // issueRefreshToken: sibling token insert
      supaMock.enqueue({ data: { id: 'user-1', username: 'Player' }, error: null }); // reload user

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'raced-but-legitimate-token' });

      assert.equal(res.status, 200);
      assert.ok(res.body.token, 'the losing tab still gets a fresh session');
      assert.ok(res.body.refreshToken);
    });

    it('rejects a request with no refreshToken in the body with 400', async () => {
      const res = await request(app).post('/api/auth/refresh').send({});

      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/auth/me (protected route)', () => {
    it('returns 401 when no Authorization header is sent', async () => {
      const res = await request(app).get('/api/auth/me');

      assert.equal(res.status, 401);
    });

    it('returns 401 for a malformed bearer token', async () => {
      const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt');

      assert.equal(res.status, 401);
    });

    it('returns the current user profile for a valid access token', async () => {
      const loginRes = await loginAndGetToken(app, supaMock, 'me@example.com', 'CorrectPass123');

      supaMock.enqueue({ data: { id: 'user-1', username: 'Player' }, error: null });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${loginRes.token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, 'user-1');
    });
  });

  describe('POST /api/auth/logout + logout-all', () => {
    it('logout blacklists the current access token — it cannot be reused afterwards', async () => {
      const { token } = await loginAndGetToken(app, supaMock, 'logout@example.com', 'CorrectPass123');

      supaMock.enqueue({ error: null }); // update status -> offline
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      assert.equal(logoutRes.status, 200);
      assert.equal(logoutRes.body.ok, true);

      const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      assert.equal(meRes.status, 401);
      assert.equal(meRes.body.details.code, 'TOKEN_REVOKED');
    });

    it('logout succeeds even with no Authorization header (best-effort client-side cleanup)', async () => {
      const res = await request(app).post('/api/auth/logout').send({});

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('logout-all requires authentication', async () => {
      const res = await request(app).post('/api/auth/logout-all').send({});

      assert.equal(res.status, 401);
    });

    it('logout-all revokes every session and blacklists the current token', async () => {
      const { token } = await loginAndGetToken(app, supaMock, 'logoutall@example.com', 'CorrectPass123');

      supaMock.enqueue({ error: null }); // revokeAllForUser update
      supaMock.enqueue({ error: null }); // status -> offline update
      const res = await request(app)
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      assert.equal(res.status, 200);

      const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      assert.equal(meRes.status, 401);
      assert.equal(meRes.body.details.code, 'TOKEN_REVOKED');
    });
  });
});

// Logs a fresh user in through the real /login endpoint and returns the
// issued token pair — used by tests that need a genuinely valid access
// token without duplicating the full login mock setup every time.
async function loginAndGetToken(app: any, mock: any, email: any, password: any) {
  const passwordHash = await bcrypt.hash(password, 12);
  mock.enqueue({
    data: { id: 'user-1', username: 'Player', email, password_hash: passwordHash },
    error: null,
  });
  mock.enqueue({ error: null }); // status -> online
  mock.enqueue({ error: null }); // issueRefreshToken insert

  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body;
}

export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('crypto');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { buildTestApp } = require('../helpers/buildTestApp');
const { FakeRedis } = require('../helpers/fakeRedis');
const { signAccessToken } = require('../../src/utils/jwt');

// ── Redis ────────────────────────────────────────────────────────────────
// Kept as a real (in-memory) store rather than a call-recording fake: the
// single-use-challenge behaviour these routes depend on IS the security
// property under test, so the tests exercise the actual set/get/del cycle.
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

// ── WebAuthn ─────────────────────────────────────────────────────────────
// @simplewebauthn/server does real attestation/assertion cryptography, which
// would need a genuine authenticator to produce fixtures for. Stub it: what
// these routes are responsible for is everything AROUND the verify call —
// challenge lifecycle, credential lookup, ban checks, counter updates — and
// that is what gets exercised here. `verifyOutcome` lets a test say "the
// crypto said no" (or "it threw") without owning a security key.
let regOutcome: any;
let authOutcome: any;
const webauthnCalls: any[] = [];
stubModule(require.resolve('@simplewebauthn/server'), {
  generateRegistrationOptions: async (opts: any) => {
    webauthnCalls.push({ fn: 'generateRegistrationOptions', opts });
    return { challenge: 'reg-challenge', rp: { id: opts.rpID } };
  },
  verifyRegistrationResponse: async (args: any) => {
    webauthnCalls.push({ fn: 'verifyRegistrationResponse', args });
    if (regOutcome instanceof Error) throw regOutcome;
    return regOutcome;
  },
  generateAuthenticationOptions: async (opts: any) => {
    webauthnCalls.push({ fn: 'generateAuthenticationOptions', opts });
    return { challenge: 'login-challenge', rpId: opts.rpID };
  },
  verifyAuthenticationResponse: async (args: any) => {
    webauthnCalls.push({ fn: 'verifyAuthenticationResponse', args });
    if (authOutcome instanceof Error) throw authOutcome;
    return authOutcome;
  },
});

// Refresh tokens are persisted by the real service via Supabase; stub it so
// issueSession() (kept real, below) doesn't consume queue slots.
stubModule(require.resolve('../../src/services/refreshTokens'), {
  issueRefreshToken: async (userId: string) => ({ raw: `refresh-for-${userId}` }),
});

const loginEvents: any[] = [];
stubModule(require.resolve('../../src/services/loginEvents'), {
  recordLoginEvent: (userId: string, method: string, success: boolean) =>
    loginEvents.push({ userId, method, success }),
  findRecentForUser: async () => ({ data: [], error: null }),
});

// ./shared exports `authLimiter`, an IP-keyed express-rate-limit (20 hits /
// 15 min). Every request supertest makes comes from the same loopback IP, so
// a file with more than 20 requests would start 429-ing on itself. Keep the
// module otherwise real (issueSession, bannedResponse, USER_FIELDS all get
// exercised) and swap only the limiter for a pass-through — rate limiting
// itself is already covered by test/routes/authRateLimit.test.ts.
const realShared = require('../../src/routes/auth/shared');
stubModule(require.resolve('../../src/routes/auth/shared'), {
  ...realShared,
  authLimiter: (_req: any, _res: any, next: any) => next(),
});

const passkeysRouter = require('../../src/routes/auth/passkeys');

const CRED_ID = 'credential-abc';

describe('Passkey routes (/api/auth)', () => {
  let app: any;
  let userId: string;
  let token: string;

  before(() => {
    app = buildTestApp({ '/api/auth': passkeysRouter });
  });

  beforeEach(async () => {
    supaMock.reset();
    fakeRedis.store.clear();
    webauthnCalls.length = 0;
    loginEvents.length = 0;
    regOutcome = { verified: true, registrationInfo: { credential: { id: CRED_ID, publicKey: Buffer.from('pk'), counter: 0, transports: ['internal'] } } };
    authOutcome = { verified: true, authenticationInfo: { newCounter: 5 } };

    userId = crypto.randomUUID();
    ({ token } = signAccessToken({ id: userId, username: 'me' }));
  });

  const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);

  describe('POST /api/auth/passkey/register-options', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(app).post('/api/auth/passkey/register-options').send({});
      assert.equal(res.status, 401);
    });

    it('returns 404 when the user no longer exists', async () => {
      supaMock.enqueue({ data: null, error: null }); // users lookup

      const res = await auth(request(app).post('/api/auth/passkey/register-options')).send({});
      assert.equal(res.status, 404);
    });

    it('stores a single-use challenge and excludes already-registered credentials', async () => {
      supaMock.enqueue({ data: { id: userId, username: 'me' }, error: null });
      supaMock.enqueue({ data: [{ id: 'existing-cred', transports: ['usb'] }], error: null });

      const res = await auth(request(app).post('/api/auth/passkey/register-options')).send({});

      assert.equal(res.status, 200);
      assert.equal(res.body.options.challenge, 'reg-challenge');

      // The challenge must be persisted server-side — otherwise register-verify
      // would have nothing to compare the authenticator's response against.
      assert.equal(await fakeRedis.get(`chalk:passkey:reg:${userId}`), 'reg-challenge');

      // A key already registered to this account must not be offered again.
      const call = webauthnCalls.find((c) => c.fn === 'generateRegistrationOptions');
      assert.deepEqual(call.opts.excludeCredentials, [{ id: 'existing-cred', transports: ['usb'] }]);
      // Usernameless login only works with a discoverable (resident) key.
      assert.equal(call.opts.authenticatorSelection.residentKey, 'required');
    });
  });

  describe('POST /api/auth/passkey/register-verify', () => {
    it('rejects a body with no credential response', async () => {
      const res = await auth(request(app).post('/api/auth/passkey/register-verify')).send({});
      assert.equal(res.status, 400);
    });

    it('rejects when no challenge was issued (or it expired)', async () => {
      const res = await auth(request(app).post('/api/auth/passkey/register-verify')).send({
        response: { id: CRED_ID },
      });

      assert.equal(res.status, 400);
      assert.match(res.body.error, /expired/i);
    });

    it('burns the challenge so it cannot be replayed', async () => {
      await fakeRedis.set(`chalk:passkey:reg:${userId}`, 'reg-challenge');
      supaMock.enqueue({ data: null, error: null }); // insert

      const first = await auth(request(app).post('/api/auth/passkey/register-verify')).send({
        response: { id: CRED_ID },
      });
      assert.equal(first.status, 200);

      // Replaying the exact same request must now fail: the challenge is gone.
      const replay = await auth(request(app).post('/api/auth/passkey/register-verify')).send({
        response: { id: CRED_ID },
      });
      assert.equal(replay.status, 400);
    });

    it('stores the credential with the device name truncated to 60 chars', async () => {
      await fakeRedis.set(`chalk:passkey:reg:${userId}`, 'reg-challenge');
      supaMock.enqueue({ data: null, error: null });

      const res = await auth(request(app).post('/api/auth/passkey/register-verify')).send({
        response: { id: CRED_ID },
        deviceName: 'x'.repeat(100),
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('rejects when the attestation does not verify', async () => {
      await fakeRedis.set(`chalk:passkey:reg:${userId}`, 'reg-challenge');
      regOutcome = { verified: false, registrationInfo: null };

      const res = await auth(request(app).post('/api/auth/passkey/register-verify')).send({
        response: { id: CRED_ID },
      });
      assert.equal(res.status, 400);
    });

    it('rejects (rather than 500s) when the verifier throws', async () => {
      await fakeRedis.set(`chalk:passkey:reg:${userId}`, 'reg-challenge');
      regOutcome = new Error('malformed attestation');

      const res = await auth(request(app).post('/api/auth/passkey/register-verify')).send({
        response: { id: CRED_ID },
      });
      assert.equal(res.status, 400);
    });

    it('returns 500 when the credential cannot be stored', async () => {
      await fakeRedis.set(`chalk:passkey:reg:${userId}`, 'reg-challenge');
      supaMock.enqueue({ data: null, error: { message: 'insert failed' } });

      const res = await auth(request(app).post('/api/auth/passkey/register-verify')).send({
        response: { id: CRED_ID },
      });
      assert.equal(res.status, 500);
    });
  });

  describe('POST /api/auth/passkey/login-options', () => {
    it('issues a challenge bound to an opaque session id, with no login required', async () => {
      const res = await request(app).post('/api/auth/passkey/login-options').send({});

      assert.equal(res.status, 200);
      assert.equal(res.body.options.challenge, 'login-challenge');
      assert.match(res.body.sessionId, /^[0-9a-f]{32}$/);
      assert.equal(await fakeRedis.get(`chalk:passkey:login:${res.body.sessionId}`), 'login-challenge');

      // Usernameless: the server must not narrow the credential list.
      const call = webauthnCalls.find((c) => c.fn === 'generateAuthenticationOptions');
      assert.deepEqual(call.opts.allowCredentials, []);
    });

    it('issues a distinct session id per call', async () => {
      const a = await request(app).post('/api/auth/passkey/login-options').send({});
      const b = await request(app).post('/api/auth/passkey/login-options').send({});
      assert.notEqual(a.body.sessionId, b.body.sessionId);
    });
  });

  describe('POST /api/auth/passkey/login-verify', () => {
    const sessionId = 'a'.repeat(32);
    const cred = {
      id: CRED_ID,
      user_id: 'will-be-overwritten',
      public_key: Buffer.from('pk').toString('base64url'),
      counter: 1,
      transports: ['internal'],
    };

    const seedChallenge = () => fakeRedis.set(`chalk:passkey:login:${sessionId}`, 'login-challenge');

    it('rejects a malformed body', async () => {
      const res = await request(app).post('/api/auth/passkey/login-verify').send({ sessionId });
      assert.equal(res.status, 400);
    });

    it('rejects an unknown or expired session challenge', async () => {
      const res = await request(app).post('/api/auth/passkey/login-verify').send({
        response: { id: CRED_ID },
        sessionId,
      });
      assert.equal(res.status, 400);
    });

    it('rejects a credential id the server has never seen', async () => {
      await seedChallenge();
      supaMock.enqueue({ data: null, error: null }); // credential lookup -> nothing

      const res = await request(app).post('/api/auth/passkey/login-verify').send({
        response: { id: 'unknown-cred' },
        sessionId,
      });
      assert.equal(res.status, 401);
    });

    it('rejects when the assertion does not verify', async () => {
      await seedChallenge();
      supaMock.enqueue({ data: { ...cred, user_id: userId }, error: null });
      authOutcome = { verified: false };

      const res = await request(app).post('/api/auth/passkey/login-verify').send({
        response: { id: CRED_ID },
        sessionId,
      });
      assert.equal(res.status, 401);
      assert.equal(loginEvents.length, 0);
    });

    it('rejects (rather than 500s) when the verifier throws', async () => {
      await seedChallenge();
      supaMock.enqueue({ data: { ...cred, user_id: userId }, error: null });
      authOutcome = new Error('bad signature');

      const res = await request(app).post('/api/auth/passkey/login-verify').send({
        response: { id: CRED_ID },
        sessionId,
      });
      assert.equal(res.status, 401);
    });

    it('refuses to sign in a banned user even with a valid passkey', async () => {
      await seedChallenge();
      supaMock.enqueue({ data: { ...cred, user_id: userId }, error: null });
      supaMock.enqueue({
        data: {
          id: userId,
          username: 'me',
          banned_until: new Date(Date.now() + 86_400_000).toISOString(),
          ban_reason: 'cheating',
        },
        error: null,
      });

      const res = await request(app).post('/api/auth/passkey/login-verify').send({
        response: { id: CRED_ID },
        sessionId,
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.banned, true);
      assert.ok(!res.body.token, 'a banned user must not receive a session token');
    });

    it('signs the user in, bumps the counter, and never leaks ban fields', async () => {
      await seedChallenge();
      supaMock.enqueue({ data: { ...cred, user_id: userId }, error: null }); // credential
      supaMock.enqueue({
        data: { id: userId, username: 'me', email: 'me@example.com', banned_until: null, ban_reason: null },
        error: null,
      }); // user
      supaMock.enqueue({ data: null, error: null }); // counter/last_used_at update

      const res = await request(app).post('/api/auth/passkey/login-verify').send({
        response: { id: CRED_ID },
        sessionId,
      });

      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.equal(res.body.refreshToken, `refresh-for-${userId}`);
      assert.equal(res.body.user.id, userId);
      // Internal moderation fields must be stripped from the response.
      assert.ok(!('banned_until' in res.body.user));
      assert.ok(!('ban_reason' in res.body.user));

      // The signature counter guards against cloned authenticators — the
      // route must feed the stored counter in and persist the new one.
      const call = webauthnCalls.find((c) => c.fn === 'verifyAuthenticationResponse');
      assert.equal(call.args.credential.counter, 1);

      assert.deepEqual(loginEvents, [{ userId, method: 'passkey', success: true }]);
    });

    it('burns the login challenge so an assertion cannot be replayed', async () => {
      await seedChallenge();
      supaMock.enqueue({ data: { ...cred, user_id: userId }, error: null });
      supaMock.enqueue({ data: { id: userId, username: 'me', banned_until: null, ban_reason: null }, error: null });
      supaMock.enqueue({ data: null, error: null });

      const first = await request(app).post('/api/auth/passkey/login-verify').send({
        response: { id: CRED_ID },
        sessionId,
      });
      assert.equal(first.status, 200);

      const replay = await request(app).post('/api/auth/passkey/login-verify').send({
        response: { id: CRED_ID },
        sessionId,
      });
      assert.equal(replay.status, 400);
      assert.ok(!replay.body.token);
    });
  });

  describe('GET /api/auth/passkey/list', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(app).get('/api/auth/passkey/list');
      assert.equal(res.status, 401);
    });

    it('lists the caller\'s passkeys without exposing key material', async () => {
      supaMock.enqueue({
        data: [{ id: CRED_ID, device_name: 'MacBook', created_at: 'T1', last_used_at: 'T2' }],
        error: null,
      });

      const res = await auth(request(app).get('/api/auth/passkey/list'));

      assert.equal(res.status, 200);
      assert.equal(res.body.passkeys.length, 1);
      assert.ok(!('public_key' in res.body.passkeys[0]));
    });

    it('returns an empty list rather than null when there are none', async () => {
      supaMock.enqueue({ data: null, error: null });

      const res = await auth(request(app).get('/api/auth/passkey/list'));

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.passkeys, []);
    });

    it('returns 500 when the list cannot be read', async () => {
      supaMock.enqueue({ data: null, error: { message: 'db down' } });

      const res = await auth(request(app).get('/api/auth/passkey/list'));
      assert.equal(res.status, 500);
    });
  });

  describe('DELETE /api/auth/passkey/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(app).delete(`/api/auth/passkey/${CRED_ID}`);
      assert.equal(res.status, 401);
    });

    it('removes the passkey', async () => {
      supaMock.enqueue({ data: null, error: null });

      const res = await auth(request(app).delete(`/api/auth/passkey/${CRED_ID}`));

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('returns 500 when the delete fails', async () => {
      supaMock.enqueue({ data: null, error: { message: 'db down' } });

      const res = await auth(request(app).delete(`/api/auth/passkey/${CRED_ID}`));
      assert.equal(res.status, 500);
    });
  });
});

export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { buildTestApp } = require('../helpers/buildTestApp');
const { FakeRedis } = require('../helpers/fakeRedis');
const { signAccessToken } = require('../../src/utils/jwt');

// routes/auth/security.ts pulls in middleware/rateLimit and (via ./shared)
// services/refreshTokens + tokenBlacklist, which transitively reach
// socket/redisClient — and that module opens three real ioredis connections
// at require time. Swap it for the in-memory fake before anything loads it,
// same as the other route tests do.
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

// ── Collaborator fakes ────────────────────────────────────────────────────
// Each one records its calls so a test can assert on the *side effects* that
// matter for security (all sessions revoked, 2FA flag flipped, ...) rather
// than only on the status code.
const PASSWORD = 'correct-horse';
// Cost 4: bcrypt is deliberately slow, and 12 rounds x ~20 assertions makes
// this file take tens of seconds. The hash format is identical.
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

let authUser: any;
let authError: any;
let updatePasswordResult: any;
let setTwofaResult: any;
const usersRepoCalls: any[] = [];
stubModule(require.resolve('../../src/repositories/usersRepository'), {
  findAuthById: async (id: string) => {
    usersRepoCalls.push({ fn: 'findAuthById', id });
    return { data: authUser, error: authError };
  },
  updatePasswordHash: async (id: string, hash: string) => {
    usersRepoCalls.push({ fn: 'updatePasswordHash', id, hash });
    return updatePasswordResult;
  },
  setTwofaEmailEnabled: async (id: string, enabled: boolean) => {
    usersRepoCalls.push({ fn: 'setTwofaEmailEnabled', id, enabled });
    return setTwofaResult;
  },
});

let issueCodeError: any;
let checkCodeResult: any;
const emailCodeCalls: any[] = [];
stubModule(require.resolve('../../src/services/emailCodes'), {
  issueAndSendCode: async (user: any, purpose: string) => {
    emailCodeCalls.push({ fn: 'issueAndSendCode', user, purpose });
    if (issueCodeError) throw issueCodeError;
  },
  checkCode: async (userId: string, purpose: string, code: string) => {
    emailCodeCalls.push({ fn: 'checkCode', userId, purpose, code });
    return checkCodeResult;
  },
});

let loginHistory: any;
const loginHistoryCalls: any[] = [];
stubModule(require.resolve('../../src/services/loginEvents'), {
  recordLoginEvent: () => {},
  findRecentForUser: async (userId: string, limit: number) => {
    loginHistoryCalls.push({ userId, limit });
    return loginHistory;
  },
});

let activeSessions: any;
let revokeSessionResult: boolean;
const refreshCalls: any[] = [];
stubModule(require.resolve('../../src/services/refreshTokens'), {
  // shared.issueSession() calls this — keep it real-shaped so the route's
  // response body is exercised end to end.
  issueRefreshToken: async (userId: string) => {
    refreshCalls.push({ fn: 'issueRefreshToken', userId });
    return { raw: `refresh-for-${userId}` };
  },
  revokeAllForUser: async (userId: string) => {
    refreshCalls.push({ fn: 'revokeAllForUser', userId });
  },
  listActiveSessionsForUser: async (userId: string) => {
    refreshCalls.push({ fn: 'listActiveSessionsForUser', userId });
    return activeSessions;
  },
  revokeSessionById: async (userId: string, sessionId: string) => {
    refreshCalls.push({ fn: 'revokeSessionById', userId, sessionId });
    return revokeSessionResult;
  },
  hashRefreshToken: (raw: string) => crypto.createHash('sha256').update(raw).digest('hex'),
});

const analyticsEvents: any[] = [];
stubModule(require.resolve('../../src/services/analytics'), {
  capture: (userId: string, event: string) => analyticsEvents.push({ userId, event }),
});

const securityRouter = require('../../src/routes/auth/security');

describe('Security routes (/api/auth)', () => {
  let app: any;
  let userId: string;
  let token: string;

  before(() => {
    app = buildTestApp({ '/api/auth': securityRouter });
  });

  beforeEach(() => {
    supaMock.reset();
    // securityWriteLimiter allows 10 writes per user per 15 min and, in the
    // test env, express-rate-limit falls back to a process-wide in-memory
    // store that nothing here can reset. A fresh user id per test means a
    // fresh rate-limit bucket, so tests can't throttle each other.
    userId = crypto.randomUUID();
    ({ token } = signAccessToken({ id: userId, username: 'me' }));

    authUser = { id: userId, email: 'me@example.com', username: 'me', password_hash: passwordHash };
    authError = null;
    updatePasswordResult = { error: null };
    setTwofaResult = { error: null };
    issueCodeError = null;
    checkCodeResult = { ok: true };
    loginHistory = { data: [], error: null };
    activeSessions = { data: [], error: null };
    revokeSessionResult = true;

    usersRepoCalls.length = 0;
    emailCodeCalls.length = 0;
    loginHistoryCalls.length = 0;
    refreshCalls.length = 0;
    analyticsEvents.length = 0;
  });

  const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);

  describe('POST /api/auth/change-password', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .send({ currentPassword: PASSWORD, newPassword: 'brand-new-pw' });
      assert.equal(res.status, 401);
    });

    it('rejects a new password shorter than 6 characters', async () => {
      const res = await auth(request(app).post('/api/auth/change-password')).send({
        currentPassword: PASSWORD,
        newPassword: 'short',
      });
      assert.equal(res.status, 400);
      // Nothing may be written when validation fails.
      assert.equal(usersRepoCalls.length, 0);
    });

    it('rejects a wrong current password with 401 and changes nothing', async () => {
      const res = await auth(request(app).post('/api/auth/change-password')).send({
        currentPassword: 'not-my-password',
        newPassword: 'brand-new-pw',
      });

      assert.equal(res.status, 401);
      assert.ok(!usersRepoCalls.some((c) => c.fn === 'updatePasswordHash'));
      assert.ok(!refreshCalls.some((c) => c.fn === 'revokeAllForUser'));
    });

    it('rotates the hash, revokes every session, and re-issues a pair for this device', async () => {
      const res = await auth(request(app).post('/api/auth/change-password')).send({
        currentPassword: PASSWORD,
        newPassword: 'brand-new-pw',
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // The stored hash must be a fresh bcrypt hash of the NEW password.
      const update = usersRepoCalls.find((c) => c.fn === 'updatePasswordHash');
      assert.ok(update, 'password hash was not updated');
      assert.notEqual(update.hash, passwordHash);
      assert.ok(bcrypt.compareSync('brand-new-pw', update.hash));

      // Stolen-laptop scenario: every other device must be signed out...
      assert.ok(refreshCalls.some((c) => c.fn === 'revokeAllForUser' && c.userId === userId));
      // ...but the caller gets a working pair back so its own tab survives.
      assert.ok(res.body.token);
      assert.equal(res.body.refreshToken, `refresh-for-${userId}`);
      assert.ok(res.body.expiresIn > 0);

      assert.deepEqual(analyticsEvents, [{ userId, event: 'password_changed' }]);
    });

    it('returns 500 when the account cannot be loaded', async () => {
      authUser = null;
      authError = { message: 'db down' };

      const res = await auth(request(app).post('/api/auth/change-password')).send({
        currentPassword: PASSWORD,
        newPassword: 'brand-new-pw',
      });
      assert.equal(res.status, 500);
    });

    it('returns 500 when the hash update fails and does not revoke sessions', async () => {
      updatePasswordResult = { error: { message: 'update failed' } };

      const res = await auth(request(app).post('/api/auth/change-password')).send({
        currentPassword: PASSWORD,
        newPassword: 'brand-new-pw',
      });

      assert.equal(res.status, 500);
      assert.ok(!refreshCalls.some((c) => c.fn === 'revokeAllForUser'));
    });

    it('throttles after 10 attempts in the window', async () => {
      const attempt = () =>
        auth(request(app).post('/api/auth/change-password')).send({
          currentPassword: 'not-my-password',
          newPassword: 'brand-new-pw',
        });

      for (let i = 0; i < 10; i++) {
        const res = await attempt();
        assert.equal(res.status, 401, `attempt ${i + 1} should still be allowed`);
      }
      const blocked = await attempt();
      assert.equal(blocked.status, 429);
    });
  });

  describe('POST /api/auth/2fa/request', () => {
    it('mails a login-purpose code to the account address', async () => {
      const res = await auth(request(app).post('/api/auth/2fa/request')).send({});

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.deepEqual(emailCodeCalls, [
        { fn: 'issueAndSendCode', user: { id: userId, email: 'me@example.com' }, purpose: 'login' },
      ]);
    });

    it('returns 500 when the mail cannot be sent', async () => {
      issueCodeError = new Error('smtp down');

      const res = await auth(request(app).post('/api/auth/2fa/request')).send({});
      assert.equal(res.status, 500);
    });

    it('returns 500 when the account cannot be loaded', async () => {
      authUser = null;
      authError = { message: 'db down' };

      const res = await auth(request(app).post('/api/auth/2fa/request')).send({});
      assert.equal(res.status, 500);
      assert.equal(emailCodeCalls.length, 0);
    });
  });

  describe('POST /api/auth/2fa/enable', () => {
    it('rejects a code that is not 6 digits', async () => {
      const res = await auth(request(app).post('/api/auth/2fa/enable')).send({ code: '12ab' });
      assert.equal(res.status, 400);
      assert.equal(emailCodeCalls.length, 0);
    });

    it('refuses to enable 2FA when the mailed code is wrong', async () => {
      checkCodeResult = { ok: false, error: 'Неверный код' };

      const res = await auth(request(app).post('/api/auth/2fa/enable')).send({ code: '123456' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Неверный код');
      assert.ok(!usersRepoCalls.some((c) => c.fn === 'setTwofaEmailEnabled'));
    });

    it('enables 2FA after a valid code', async () => {
      const res = await auth(request(app).post('/api/auth/2fa/enable')).send({ code: '123456' });

      assert.equal(res.status, 200);
      assert.equal(res.body.twofa_email_enabled, true);
      assert.deepEqual(emailCodeCalls, [{ fn: 'checkCode', userId, purpose: 'login', code: '123456' }]);
      assert.ok(usersRepoCalls.some((c) => c.fn === 'setTwofaEmailEnabled' && c.enabled === true));
      assert.deepEqual(analyticsEvents, [{ userId, event: 'twofa_enabled' }]);
    });

    it('returns 500 when the flag cannot be persisted', async () => {
      setTwofaResult = { error: { message: 'write failed' } };

      const res = await auth(request(app).post('/api/auth/2fa/enable')).send({ code: '123456' });
      assert.equal(res.status, 500);
      assert.equal(analyticsEvents.length, 0);
    });
  });

  describe('POST /api/auth/2fa/disable', () => {
    it('refuses to disable 2FA without a valid code', async () => {
      checkCodeResult = { ok: false, error: 'Код истёк' };

      const res = await auth(request(app).post('/api/auth/2fa/disable')).send({ code: '123456' });

      assert.equal(res.status, 400);
      assert.ok(!usersRepoCalls.some((c) => c.fn === 'setTwofaEmailEnabled'));
    });

    it('disables 2FA after a valid code', async () => {
      const res = await auth(request(app).post('/api/auth/2fa/disable')).send({ code: '123456' });

      assert.equal(res.status, 200);
      assert.equal(res.body.twofa_email_enabled, false);
      assert.ok(usersRepoCalls.some((c) => c.fn === 'setTwofaEmailEnabled' && c.enabled === false));
      assert.deepEqual(analyticsEvents, [{ userId, event: 'twofa_disabled' }]);
    });
  });

  describe('POST /api/auth/sessions', () => {
    it('flags the caller\'s own session and no other', async () => {
      const mine = crypto.createHash('sha256').update('my-refresh').digest('hex');
      const theirs = crypto.createHash('sha256').update('other-refresh').digest('hex');
      activeSessions = {
        data: [
          { id: 's1', user_agent: 'Firefox', ip: '1.1.1.1', created_at: 'T1', expires_at: 'T9', token_hash: mine },
          { id: 's2', user_agent: 'Safari', ip: '2.2.2.2', created_at: 'T2', expires_at: 'T9', token_hash: theirs },
        ],
        error: null,
      };

      const res = await auth(request(app).post('/api/auth/sessions')).send({ refreshToken: 'my-refresh' });

      assert.equal(res.status, 200);
      assert.equal(res.body.sessions.length, 2);
      assert.equal(res.body.sessions[0].current, true);
      assert.equal(res.body.sessions[1].current, false);
      // The token hash is an internal credential — it must not be echoed back.
      assert.ok(!('token_hash' in res.body.sessions[0]));
    });

    it('marks nothing current when the caller sends no refresh token', async () => {
      activeSessions = {
        data: [{ id: 's1', user_agent: 'Firefox', ip: '1.1.1.1', created_at: 'T1', expires_at: 'T9', token_hash: 'abc' }],
        error: null,
      };

      const res = await auth(request(app).post('/api/auth/sessions')).send({});

      assert.equal(res.status, 200);
      assert.equal(res.body.sessions[0].current, false);
    });

    it('returns 500 when the session list cannot be read', async () => {
      activeSessions = { data: null, error: { message: 'db down' } };

      const res = await auth(request(app).post('/api/auth/sessions')).send({});
      assert.equal(res.status, 500);
    });
  });

  describe('POST /api/auth/sessions/revoke', () => {
    it('rejects a session id that is not a uuid', async () => {
      const res = await auth(request(app).post('/api/auth/sessions/revoke')).send({ sessionId: 'nope' });
      assert.equal(res.status, 400);
      assert.equal(refreshCalls.length, 0);
    });

    it('returns 404 when the session is not the caller\'s', async () => {
      revokeSessionResult = false;

      const res = await auth(request(app).post('/api/auth/sessions/revoke')).send({
        sessionId: crypto.randomUUID(),
      });

      assert.equal(res.status, 404);
      assert.equal(analyticsEvents.length, 0);
    });

    it('revokes one session, scoped to the caller', async () => {
      const sessionId = crypto.randomUUID();

      const res = await auth(request(app).post('/api/auth/sessions/revoke')).send({ sessionId });

      assert.equal(res.status, 200);
      assert.deepEqual(refreshCalls, [{ fn: 'revokeSessionById', userId, sessionId }]);
      assert.deepEqual(analyticsEvents, [{ userId, event: 'session_revoked' }]);
    });
  });

  describe('GET /api/auth/login-history', () => {
    it('returns the caller\'s recent login events', async () => {
      loginHistory = { data: [{ id: 'e1', method: 'password', success: true }], error: null };

      const res = await auth(request(app).get('/api/auth/login-history'));

      assert.equal(res.status, 200);
      assert.equal(res.body.events.length, 1);
      assert.deepEqual(loginHistoryCalls, [{ userId, limit: 30 }]);
    });

    it('returns an empty list rather than null when there are no events', async () => {
      loginHistory = { data: null, error: null };

      const res = await auth(request(app).get('/api/auth/login-history'));

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.events, []);
    });

    it('returns 500 when the history cannot be read', async () => {
      loginHistory = { data: null, error: { message: 'db down' } };

      const res = await auth(request(app).get('/api/auth/login-history'));
      assert.equal(res.status, 500);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(app).get('/api/auth/login-history');
      assert.equal(res.status, 401);
    });
  });
});

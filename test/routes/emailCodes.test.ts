export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { stubModule } = require('../helpers/stubModule');
const { createSupabaseMock } = require('../helpers/mockSupabase');
const { buildTestApp } = require('../helpers/buildTestApp');
const { FakeRedis } = require('../helpers/fakeRedis');

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

// ── Collaborators ────────────────────────────────────────────────────────
let foundUser: any;
const userCalls: any[] = [];
stubModule(require.resolve('../../src/repositories/usersRepository'), {
  findForCodeAuth: async (identifier: string) => {
    userCalls.push({ fn: 'findForCodeAuth', identifier });
    return { data: foundUser, error: null };
  },
  setStatus: async (id: string, status: string) => {
    userCalls.push({ fn: 'setStatus', id, status });
    return { error: null };
  },
  setEmailVerified: async (id: string) => {
    userCalls.push({ fn: 'setEmailVerified', id });
    return { error: null };
  },
});

let checkCodeResult: any;
let issueCodeError: any;
const codeCalls: any[] = [];
stubModule(require.resolve('../../src/services/emailCodes'), {
  issueAndSendCode: async (user: any, purpose: string) => {
    codeCalls.push({ fn: 'issueAndSendCode', userId: user.id, email: user.email, purpose });
    if (issueCodeError) throw issueCodeError;
  },
  checkCode: async (userId: string, purpose: string, code: string) => {
    codeCalls.push({ fn: 'checkCode', userId, purpose, code });
    return checkCodeResult;
  },
});

const loginEvents: any[] = [];
stubModule(require.resolve('../../src/services/loginEvents'), {
  recordLoginEvent: (userId: string, method: string, success: boolean) =>
    loginEvents.push({ userId, method, success }),
  findRecentForUser: async () => ({ data: [], error: null }),
});

stubModule(require.resolve('../../src/services/refreshTokens'), {
  issueRefreshToken: async (userId: string) => ({ raw: `refresh-for-${userId}` }),
});

const analyticsEvents: any[] = [];
stubModule(require.resolve('../../src/services/analytics'), {
  capture: (userId: string, event: string, props?: any) => analyticsEvents.push({ userId, event, props }),
});

// Both limiters on these routes (IP-keyed authLimiter, identifier-keyed
// codeRequestLimiter) would trip partway through this file, since supertest
// always calls from the same loopback IP. Keep the rest of ./shared real —
// issueSession and bannedResponse are part of what's under test here — and
// swap only the limiters. Limiter behaviour itself: authRateLimit.test.ts.
const realShared = require('../../src/routes/auth/shared');
const passThrough = (_req: any, _res: any, next: any) => next();
stubModule(require.resolve('../../src/routes/auth/shared'), {
  ...realShared,
  authLimiter: passThrough,
  codeRequestLimiter: passThrough,
});

const codesRouter = require('../../src/routes/auth/emailCodes');

const userId = '11111111-1111-4111-8111-111111111111';
const GENERIC = 'Если такой аккаунт существует, мы отправили код на его почту.';

const verifiedUser = () => ({
  id: userId,
  username: 'me',
  email: 'me@example.com',
  email_verified: true,
  banned_until: null,
  ban_reason: null,
});

describe('Email code routes (/api/auth)', () => {
  let app: any;

  before(() => {
    app = buildTestApp({ '/api/auth': codesRouter });
  });

  beforeEach(() => {
    supaMock.reset();
    userCalls.length = 0;
    codeCalls.length = 0;
    loginEvents.length = 0;
    analyticsEvents.length = 0;
    foundUser = verifiedUser();
    checkCodeResult = { ok: true };
    issueCodeError = null;
  });

  describe('POST /api/auth/verify-email', () => {
    it('rejects a code that is not 6 digits', async () => {
      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ identifier: 'me@example.com', code: 'abc' });

      assert.equal(res.status, 400);
      assert.equal(codeCalls.length, 0);
    });

    it('returns a generic error for an unknown account (no enumeration)', async () => {
      foundUser = null;

      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ identifier: 'ghost@example.com', code: '123456' });

      assert.equal(res.status, 400);
      assert.match(res.body.error, /недействителен/);
    });

    it('refuses a banned account before any code is checked', async () => {
      foundUser = {
        ...verifiedUser(),
        email_verified: false,
        banned_until: new Date(Date.now() + 86_400_000).toISOString(),
        ban_reason: 'cheating',
      };

      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 403);
      assert.equal(res.body.banned, true);
      assert.ok(!res.body.token);
      assert.equal(codeCalls.length, 0);
    });

    it('verifies the email and issues the session /register withheld', async () => {
      foundUser = { ...verifiedUser(), email_verified: false };

      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.equal(res.body.refreshToken, `refresh-for-${userId}`);
      assert.deepEqual(codeCalls, [{ fn: 'checkCode', userId, purpose: 'verify_email', code: '123456' }]);
      assert.ok(userCalls.some((c) => c.fn === 'setEmailVerified' && c.id === userId));
      assert.ok(userCalls.some((c) => c.fn === 'setStatus' && c.status === 'online'));
      assert.deepEqual(analyticsEvents, [{ userId, event: 'email_verified', props: undefined }]);
    });

    it('does not mark the email verified when the code is wrong', async () => {
      foundUser = { ...verifiedUser(), email_verified: false };
      checkCodeResult = { ok: false, error: 'Код недействителен или устарел' };

      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 400);
      assert.ok(!userCalls.some((c) => c.fn === 'setEmailVerified'));
      assert.ok(!res.body.token);
    });

    it('logs an already-verified account straight in without checking a code', async () => {
      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.ok(!codeCalls.some((c) => c.fn === 'checkCode'));
    });
  });

  describe('POST /api/auth/request-login-code', () => {
    it('answers generically for an unknown account and mails nothing', async () => {
      foundUser = null;

      const res = await request(app)
        .post('/api/auth/request-login-code')
        .send({ identifier: 'ghost@example.com' });

      assert.equal(res.status, 200);
      assert.equal(res.body.message, GENERIC);
      assert.equal(codeCalls.length, 0);
    });

    it('mails a login code to a verified account', async () => {
      const res = await request(app)
        .post('/api/auth/request-login-code')
        .send({ identifier: 'me@example.com' });

      assert.equal(res.status, 200);
      assert.deepEqual(codeCalls, [
        { fn: 'issueAndSendCode', userId, email: 'me@example.com', purpose: 'login' },
      ]);
    });

    it('mails a verification code instead when the account is unverified', async () => {
      foundUser = { ...verifiedUser(), email_verified: false };

      const res = await request(app)
        .post('/api/auth/request-login-code')
        .send({ identifier: 'me@example.com' });

      assert.equal(res.status, 200);
      assert.equal(codeCalls[0].purpose, 'verify_email');
    });

    it('still answers generically when sending the mail fails', async () => {
      issueCodeError = new Error('smtp down');

      const res = await request(app)
        .post('/api/auth/request-login-code')
        .send({ identifier: 'me@example.com' });

      // A 500 here would leak that the account exists.
      assert.equal(res.status, 200);
      assert.equal(res.body.message, GENERIC);
    });

    it('answers identically whether or not the account exists', async () => {
      const known = await request(app).post('/api/auth/request-login-code').send({ identifier: 'me@example.com' });
      foundUser = null;
      const unknown = await request(app).post('/api/auth/request-login-code').send({ identifier: 'ghost@example.com' });

      assert.equal(known.status, unknown.status);
      assert.deepEqual(known.body, unknown.body);
    });
  });

  describe('POST /api/auth/login-code', () => {
    it('returns a generic error for an unknown account', async () => {
      foundUser = null;

      const res = await request(app)
        .post('/api/auth/login-code')
        .send({ identifier: 'ghost@example.com', code: '123456' });

      assert.equal(res.status, 400);
      assert.ok(!res.body.token);
    });

    it('refuses a banned account', async () => {
      foundUser = {
        ...verifiedUser(),
        banned_until: new Date(Date.now() + 86_400_000).toISOString(),
        ban_reason: 'cheating',
      };

      const res = await request(app)
        .post('/api/auth/login-code')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 403);
      assert.equal(res.body.banned, true);
      assert.ok(!res.body.token);
    });

    it('tells an unverified account to verify rather than logging it in', async () => {
      foundUser = { ...verifiedUser(), email_verified: false };

      const res = await request(app)
        .post('/api/auth/login-code')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 403);
      assert.equal(res.body.needsVerification, true);
      assert.ok(!res.body.token);
    });

    it('journals a failed attempt and issues no session on a wrong code', async () => {
      checkCodeResult = { ok: false, error: 'Код недействителен или устарел' };

      const res = await request(app)
        .post('/api/auth/login-code')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 400);
      assert.ok(!res.body.token);
      assert.deepEqual(loginEvents, [{ userId, method: 'code', success: false }]);
    });

    it('exchanges a valid code for a session and journals it as a code login', async () => {
      const res = await request(app)
        .post('/api/auth/login-code')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.equal(res.body.refreshToken, `refresh-for-${userId}`);
      assert.deepEqual(codeCalls, [{ fn: 'checkCode', userId, purpose: 'login', code: '123456' }]);
      assert.ok(userCalls.some((c) => c.fn === 'setStatus' && c.status === 'online'));
      assert.deepEqual(loginEvents, [{ userId, method: 'code', success: true }]);
    });

    it('journals the same endpoint as 2fa when the account has email 2FA on', async () => {
      foundUser = { ...verifiedUser(), twofa_email_enabled: true };

      const res = await request(app)
        .post('/api/auth/login-code')
        .send({ identifier: 'me@example.com', code: '123456' });

      assert.equal(res.status, 200);
      assert.deepEqual(loginEvents, [{ userId, method: '2fa', success: true }]);
    });
  });

  describe('POST /api/auth/resend-code', () => {
    it('rejects an unknown purpose', async () => {
      const res = await request(app)
        .post('/api/auth/resend-code')
        .send({ identifier: 'me@example.com', purpose: 'password_reset' });

      assert.equal(res.status, 400);
      assert.equal(codeCalls.length, 0);
    });

    it('answers generically for an unknown account and mails nothing', async () => {
      foundUser = null;

      const res = await request(app)
        .post('/api/auth/resend-code')
        .send({ identifier: 'ghost@example.com', purpose: 'login' });

      assert.equal(res.status, 200);
      assert.equal(res.body.message, GENERIC);
      assert.equal(codeCalls.length, 0);
    });

    it('resends a login code to a verified account', async () => {
      const res = await request(app)
        .post('/api/auth/resend-code')
        .send({ identifier: 'me@example.com', purpose: 'login' });

      assert.equal(res.status, 200);
      assert.equal(codeCalls[0].purpose, 'login');
    });

    it('downgrades a login resend to a verification code for an unverified account', async () => {
      foundUser = { ...verifiedUser(), email_verified: false };

      const res = await request(app)
        .post('/api/auth/resend-code')
        .send({ identifier: 'me@example.com', purpose: 'login' });

      assert.equal(res.status, 200);
      assert.equal(codeCalls[0].purpose, 'verify_email');
    });

    it('will not resend a verification code to an already-verified account', async () => {
      const res = await request(app)
        .post('/api/auth/resend-code')
        .send({ identifier: 'me@example.com', purpose: 'verify_email' });

      // Nothing to verify — mailing anyway would be free inbox spam.
      assert.equal(res.status, 200);
      assert.equal(res.body.message, GENERIC);
      assert.equal(codeCalls.length, 0);
    });

    it('still answers generically when sending fails', async () => {
      issueCodeError = new Error('smtp down');

      const res = await request(app)
        .post('/api/auth/resend-code')
        .send({ identifier: 'me@example.com', purpose: 'login' });

      assert.equal(res.status, 200);
      assert.equal(res.body.message, GENERIC);
    });
  });
});

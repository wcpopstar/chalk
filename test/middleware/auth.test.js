'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { requireAuth, optionalAuth } = require('../../src/middleware/auth');
const { signAccessToken } = require('../../src/utils/jwt');
const tokenBlacklist = require('../../src/services/tokenBlacklist');

// Minimal fake Express res — just enough for middleware/auth.js's
// `res.status(x).json(y)` calls, without spinning up a real server.
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

function bearerReq(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

describe('requireAuth middleware', () => {
  it('calls next() and attaches req.user for a valid token', () => {
    const { token } = signAccessToken({ id: 'user-1', username: 'valid_user' });
    const req = bearerReq(token);
    const res = fakeRes();
    let nextCalled = false;

    requireAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.user.id, 'user-1');
    assert.equal(req.user.username, 'valid_user');
    assert.equal(req.accessToken, token);
  });

  it('rejects with 401 when the Authorization header is missing', () => {
    const req = bearerReq(null);
    const res = fakeRes();
    let nextCalled = false;

    requireAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejects with 401 when the header is not a Bearer token', () => {
    const req = { headers: { authorization: 'Basic somecredentials' } };
    const res = fakeRes();
    let nextCalled = false;

    requireAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejects with 401 for a structurally invalid token', () => {
    const req = bearerReq('this-is-not-a-jwt');
    const res = fakeRes();

    requireAuth(req, res, () => {});

    assert.equal(res.statusCode, 401);
  });

  it('rejects with 401 for a token signed with the wrong secret', () => {
    const forged = jwt.sign({ id: 'user-1' }, 'not-the-real-secret', {
      issuer: 'chalk-backend',
      audience: 'chalk-app',
      expiresIn: '15m',
    });
    const req = bearerReq(forged);
    const res = fakeRes();

    requireAuth(req, res, () => {});

    assert.equal(res.statusCode, 401);
  });

  it('rejects with 401 + code TOKEN_EXPIRED for an expired token', () => {
    const expired = jwt.sign({ id: 'user-1', username: 'x' }, process.env.JWT_SECRET, {
      issuer: 'chalk-backend',
      audience: 'chalk-app',
      expiresIn: -10, // already expired
      jwtid: 'expired-jti',
    });
    const req = bearerReq(expired);
    const res = fakeRes();

    requireAuth(req, res, () => {});

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.details.code, 'TOKEN_EXPIRED');
  });

  it('rejects with 401 + code TOKEN_REVOKED for a blacklisted (logged-out) token', () => {
    const { token, jti } = signAccessToken({ id: 'user-1', username: 'x' });
    tokenBlacklist.revoke(jti, Date.now() + 60_000);

    const req = bearerReq(token);
    const res = fakeRes();

    requireAuth(req, res, () => {});

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.details.code, 'TOKEN_REVOKED');
  });

  it('rejects with 401 for a token whose issuer/audience do not match', () => {
    const wrongAudience = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET, {
      issuer: 'chalk-backend',
      audience: 'some-other-app',
      expiresIn: '15m',
    });
    const req = bearerReq(wrongAudience);
    const res = fakeRes();

    requireAuth(req, res, () => {});

    assert.equal(res.statusCode, 401);
  });
});

describe('optionalAuth middleware', () => {
  it('proceeds anonymously (no req.user) when no token is provided', () => {
    const req = bearerReq(null);
    const res = fakeRes();
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.user, undefined);
  });

  it('proceeds anonymously (never blocks) when the token is invalid', () => {
    const req = bearerReq('garbage-token');
    const res = fakeRes();
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.user, undefined);
    assert.equal(res.statusCode, 200); // never touched res — no error was sent
  });

  it('attaches req.user when a valid token is provided', () => {
    const { token } = signAccessToken({ id: 'user-2', username: 'someone' });
    const req = bearerReq(token);
    const res = fakeRes();
    let nextCalled = false;

    optionalAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.user.id, 'user-2');
  });
});

describe('requireAuth + tokenBlacklist interaction', () => {
  beforeEach(() => {
    // The blacklist is a process-wide singleton (see
    // src/services/tokenBlacklist.js) — clear it between tests in this
    // block so revocations from one test can't leak into the next.
    tokenBlacklist.store.clear();
  });

  it('a freshly issued token for a previously-revoked jti-less user is not revoked', () => {
    const { token } = signAccessToken({ id: 'user-3', username: 'fresh' });
    const req = bearerReq(token);
    const res = fakeRes();
    let nextCalled = false;

    requireAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });

  it('revoking one jti does not affect a different, still-valid token', () => {
    const revoked = signAccessToken({ id: 'user-4', username: 'a' });
    const stillValid = signAccessToken({ id: 'user-4', username: 'a' });
    tokenBlacklist.revoke(revoked.jti, Date.now() + 60_000);

    const res = fakeRes();
    let nextCalled = false;
    requireAuth(bearerReq(stillValid.token), res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });
});

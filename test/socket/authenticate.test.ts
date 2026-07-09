export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { authenticateSocket } = require('../../src/socket/authenticate');
const { signAccessToken, ISSUER, AUDIENCE } = require('../../src/utils/jwt');
const tokenBlacklist = require('../../src/services/tokenBlacklist');

const userId = '11111111-1111-4111-8111-111111111111';

// Minimal socket stand-in with just what authenticateSocket touches:
// handshake token, socket.data, and the event registration used by
// auth:refresh and the expiry-driven disconnect.
function makeSocket(token: any) {
  const handlers = new Map();
  const socket: any = {
    handshake: { auth: { token }, query: {} },
    data: {},
    emitted: [] as any[],
    disconnected: false,
    on(event: any, cb: any) { handlers.set(event, cb); return socket; },
    once(event: any, cb: any) { handlers.set(`once:${event}`, cb); return socket; },
    emit(event: any, payload: any) { socket.emitted.push({ event, payload }); },
    disconnect(_close: any) { socket.disconnected = true; },
    async trigger(event: any, ...args: any[]) {
      const cb = handlers.get(event);
      if (!cb) throw new Error(`no handler for ${event}`);
      return cb(...args);
    },
  };
  return socket;
}

function authenticate(socket: any): Promise<Error | undefined> {
  return new Promise((resolve) => {
    // authenticateSocket is async but signals only through next()
    authenticateSocket(socket, (err?: Error) => resolve(err));
  });
}

function expiredToken() {
  return jwt.sign(
    { id: userId, username: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: '-1s', issuer: ISSUER, audience: AUDIENCE, jwtid: 'expired-jti' }
  );
}

describe('socket/authenticate.ts', () => {
  beforeEach(() => {
    tokenBlacklist.store.clear();
  });

  it('rejects a handshake with no token', async () => {
    const err = await authenticate(makeSocket(undefined));
    assert.match(err!.message, /Authentication required/);
  });

  it('rejects a non-string token', async () => {
    const err = await authenticate(makeSocket(12345 as any));
    assert.match(err!.message, /Authentication required/);
  });

  it('rejects a garbage token', async () => {
    const err = await authenticate(makeSocket('not-a-jwt'));
    assert.equal(err!.message, 'Invalid token');
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const err = await authenticate(makeSocket(expiredToken()));
    assert.equal(err!.message, 'TOKEN_EXPIRED');
  });

  it('rejects a revoked token with TOKEN_REVOKED', async () => {
    const { token, jti } = signAccessToken({ id: userId, username: 'x' });
    tokenBlacklist.revoke(jti, Date.now() + 60_000);

    const err = await authenticate(makeSocket(token));
    assert.equal(err!.message, 'TOKEN_REVOKED');
  });

  it('accepts a valid token, attaches the payload, and arms the expiry timer', async () => {
    const { token } = signAccessToken({ id: userId, username: 'sock' });
    const socket = makeSocket(token);

    const err = await authenticate(socket);
    assert.equal(err, undefined);
    assert.equal(socket.data.user.id, userId);
    assert.equal(socket.data.user.username, 'sock');
    assert.ok(socket.data.tokenExpiresAt > Date.now());
    assert.ok(socket.data.tokenExpiryTimer);
    clearTimeout(socket.data.tokenExpiryTimer);
  });

  describe('auth:refresh', () => {
    async function authedSocket() {
      const { token } = signAccessToken({ id: userId, username: 'sock' });
      const socket = makeSocket(token);
      await authenticate(socket);
      return socket;
    }

    async function refresh(socket: any, newToken: any) {
      let ackResult: any;
      await socket.trigger('auth:refresh', newToken, (r: any) => { ackResult = r; });
      return ackResult;
    }

    it('rejects a missing token', async () => {
      const socket = await authedSocket();
      assert.deepEqual(await refresh(socket, undefined), { ok: false, error: 'Missing token' });
      clearTimeout(socket.data.tokenExpiryTimer);
    });

    it('rejects an invalid token', async () => {
      const socket = await authedSocket();
      assert.equal((await refresh(socket, 'garbage')).error, 'INVALID_TOKEN');
      clearTimeout(socket.data.tokenExpiryTimer);
    });

    it('rejects an expired token', async () => {
      const socket = await authedSocket();
      assert.equal((await refresh(socket, expiredToken())).error, 'TOKEN_EXPIRED');
      clearTimeout(socket.data.tokenExpiryTimer);
    });

    it('rejects a revoked token', async () => {
      const socket = await authedSocket();
      const { token: newToken, jti } = signAccessToken({ id: userId, username: 'sock' });
      tokenBlacklist.revoke(jti, Date.now() + 60_000);

      assert.equal((await refresh(socket, newToken)).error, 'TOKEN_REVOKED');
      clearTimeout(socket.data.tokenExpiryTimer);
    });

    it("rejects a token that belongs to a DIFFERENT user (no session hijack)", async () => {
      const socket = await authedSocket();
      const { token: otherToken } = signAccessToken({
        id: '22222222-2222-4222-8222-222222222222', username: 'someone-else',
      });

      assert.equal((await refresh(socket, otherToken)).error, 'USER_MISMATCH');
      clearTimeout(socket.data.tokenExpiryTimer);
    });

    it('swaps in a fresh token for the same user and re-arms the timer', async () => {
      const socket = await authedSocket();
      const previousExpiry = socket.data.tokenExpiresAt;
      const { token: newToken } = signAccessToken({ id: userId, username: 'sock' });

      const result = await refresh(socket, newToken);
      assert.equal(result.ok, true);
      assert.ok(result.expiresAt >= previousExpiry);
      clearTimeout(socket.data.tokenExpiryTimer);
    });

    it('does not throw when the client provides no ack callback', async () => {
      const socket = await authedSocket();
      await socket.trigger('auth:refresh', 'garbage', undefined);
      clearTimeout(socket.data.tokenExpiryTimer);
    });
  });
});

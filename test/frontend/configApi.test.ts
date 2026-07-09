export {};
'use strict';

// Tests the REAL public/js/config-api.js session logic by executing the
// browser script inside a node:vm sandbox with faked window/localStorage/
// fetch/document. This is the file whose broken 401 handling logged users
// out on every page load once the 15-minute access token had expired
// (the machine-readable code lives at `details.code` in the server's error
// body, but the old check read top-level `data.code` and never matched).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../public/js/config-api.js'), 'utf8');

interface FakeResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

function loadConfigApi(store: Record<string, string>, responses: Array<{ match: string; response: FakeResponse }>) {
  const fetchCalls: Array<{ url: string; body: unknown }> = [];

  const sandbox: any = {
    window: { location: { origin: 'http://app.test' } },
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
    document: { getElementById: () => null }, // forceLogout's DOM writes are all null-safe
    T: (k: string) => k,
    console,
    fetch: async (url: string, opts: any = {}) => {
      fetchCalls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      const next = responses.find((r) => url.includes(r.match) && !(r as any)._used);
      if (!next) throw new Error(`no fake response queued for ${url}`);
      (next as any)._used = true;
      return {
        ok: next.response.ok,
        status: next.response.status,
        json: async () => next.response.body,
      };
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { sandbox, fetchCalls, store };
}

describe('public/js/config-api.js — session refresh on 401', () => {
  it('refreshes and retries when the access token expired (code nested under details)', async () => {
    const { sandbox, fetchCalls, store } = loadConfigApi(
      { chalk_token: 'stale-access', chalk_refresh_token: 'valid-refresh' },
      [
        // exactly what src/utils/http.ts sendError() produces:
        { match: '/api/auth/me', response: { ok: false, status: 401, body: { error: 'Token expired', details: { code: 'TOKEN_EXPIRED' } } } },
        { match: '/api/auth/refresh', response: { ok: true, status: 200, body: { token: 'fresh-access', refreshToken: 'rotated-refresh' } } },
        { match: '/api/auth/me', response: { ok: true, status: 200, body: { user: { id: 'u1', username: 'me' } } } },
      ],
    );

    const data = await sandbox.api('/api/auth/me');

    assert.equal(data.user.username, 'me');
    assert.equal(fetchCalls.length, 3); // me -> refresh -> me (retry)
    assert.deepEqual(fetchCalls[1]!.body, { refreshToken: 'valid-refresh' });
    // rotated pair persisted — the session survives the next page load too
    assert.equal(store.chalk_token, 'fresh-access');
    assert.equal(store.chalk_refresh_token, 'rotated-refresh');
  });

  it('refreshes even on a generic 401 with no code (e.g. after a JWT_SECRET rotation)', async () => {
    const { sandbox, fetchCalls } = loadConfigApi(
      { chalk_token: 'signed-with-old-secret', chalk_refresh_token: 'valid-refresh' },
      [
        { match: '/api/auth/me', response: { ok: false, status: 401, body: { error: 'Invalid or expired token' } } },
        { match: '/api/auth/refresh', response: { ok: true, status: 200, body: { token: 'fresh-access', refreshToken: 'rotated-refresh' } } },
        { match: '/api/auth/me', response: { ok: true, status: 200, body: { user: { id: 'u1' } } } },
      ],
    );

    const data = await sandbox.api('/api/auth/me');
    assert.ok(data.user);
    assert.equal(fetchCalls.length, 3);
  });

  it('logs out (clears the stored session) when the refresh itself fails', async () => {
    const { sandbox, store } = loadConfigApi(
      { chalk_token: 'stale', chalk_refresh_token: 'revoked-refresh' },
      [
        { match: '/api/auth/me', response: { ok: false, status: 401, body: { error: 'Token expired', details: { code: 'TOKEN_EXPIRED' } } } },
        { match: '/api/auth/refresh', response: { ok: false, status: 401, body: { error: 'Invalid refresh token' } } },
      ],
    );

    await assert.rejects(() => sandbox.api('/api/auth/me'));
    assert.equal(store.chalk_token, undefined);
    assert.equal(store.chalk_refresh_token, undefined);
  });

  it('does not attempt a refresh without a stored refresh token (e.g. a failed login)', async () => {
    const { sandbox, fetchCalls } = loadConfigApi(
      {},
      [
        { match: '/api/auth/login', response: { ok: false, status: 401, body: { error: 'Invalid credentials' } } },
      ],
    );

    await assert.rejects(() => sandbox.api('/api/auth/login', { method: 'POST', body: JSON.stringify({}) }), /Invalid credentials/);
    assert.equal(fetchCalls.length, 1); // no refresh round trip
  });

  it('retries at most once — a 401 on the retried request does not loop', async () => {
    const { sandbox, fetchCalls } = loadConfigApi(
      { chalk_token: 'stale', chalk_refresh_token: 'valid-refresh' },
      [
        { match: '/api/auth/me', response: { ok: false, status: 401, body: { error: 'Token expired', details: { code: 'TOKEN_EXPIRED' } } } },
        { match: '/api/auth/refresh', response: { ok: true, status: 200, body: { token: 'fresh', refreshToken: 'rotated' } } },
        { match: '/api/auth/me', response: { ok: false, status: 401, body: { error: 'still unauthorized' } } },
      ],
    );

    await assert.rejects(() => sandbox.api('/api/auth/me'), /still unauthorized/);
    assert.equal(fetchCalls.length, 3); // me -> refresh -> me, then STOP
  });
});

export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { stubModule } = require('../helpers/stubModule');
const { buildTestApp } = require('../helpers/buildTestApp');
const { signAccessToken } = require('../../src/utils/jwt');

// The flags router pulls listFlags/setOverride from the feature-flags
// service, which talks to Redis — stub the service so these tests only
// exercise the ROUTE layer (auth, admin key, validation, error mapping).
// The service itself is unit-tested in test/services/featureFlags.test.ts.
let listFlagsResult: any = [];
let setOverrideCalls: any[] = [];
let setOverrideError: any = null;
stubModule(require.resolve('../../src/services/featureFlags'), {
  // validation/featureFlagSchemas.ts derives the allowed :key values from
  // REGISTRY at require time — the stub must ship a realistic one.
  REGISTRY: {
    'discovery.enabled': { default: true, description: 'test flag' },
    'games.tetris.enabled': { default: true, description: 'test flag' },
  },
  listFlags: async (opts: any) => {
    listFlagsResult.lastOpts = opts;
    return listFlagsResult;
  },
  setOverride: async (key: any, override: any) => {
    if (setOverrideError) throw setOverrideError;
    setOverrideCalls.push({ key, override });
  },
});

const userId = '11111111-1111-4111-8111-111111111111';
const ADMIN_KEY = 'test-admin-key-123';

describe('Feature flag routes (/api/flags)', () => {
  let token: any;

  before(() => {
    ({ token } = signAccessToken({ id: userId, username: 'flaguser' }));
  });

  describe('admin endpoints DISABLED (no ADMIN_API_KEY)', () => {
    let app: any;

    before(() => {
      delete process.env.ADMIN_API_KEY;
      delete require.cache[require.resolve('../../src/config/env')];
      delete require.cache[require.resolve('../../src/middleware/requireAdminKey')];
      delete require.cache[require.resolve('../../src/routes/featureFlags')];
      app = buildTestApp({ '/api/flags': require('../../src/routes/featureFlags') });
    });

    it('GET /api/flags requires auth', async () => {
      const res = await request(app).get('/api/flags');
      assert.equal(res.status, 401);
    });

    it('GET /api/flags returns resolved flags for the caller', async () => {
      listFlagsResult = [
        { key: 'discovery.enabled', enabled: true },
        { key: 'games.tetris.enabled', enabled: false },
      ];

      const res = await request(app)
        .get('/api/flags')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.flags, {
        'discovery.enabled': true,
        'games.tetris.enabled': false,
        // Derived from config.stt (no STT_API_KEY in the test env), not a
        // stored flag — see routes/featureFlags.ts.
        'transcription.enabled': false,
      });
      // Resolved per-user, not globally.
      assert.equal(listFlagsResult.lastOpts.userId, userId);
    });

    it('admin endpoints fail closed with 503 when ADMIN_API_KEY is unset', async () => {
      const res = await request(app).get('/api/flags/admin').set('x-admin-key', 'anything');
      assert.equal(res.status, 503);
    });
  });

  describe('admin endpoints ENABLED (ADMIN_API_KEY set)', () => {
    let app: any;

    before(() => {
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      delete require.cache[require.resolve('../../src/config/env')];
      delete require.cache[require.resolve('../../src/middleware/requireAdminKey')];
      delete require.cache[require.resolve('../../src/routes/featureFlags')];
      app = buildTestApp({ '/api/flags': require('../../src/routes/featureFlags') });
      setOverrideCalls = [];
      setOverrideError = null;
    });

    after(() => {
      delete process.env.ADMIN_API_KEY;
    });

    it('rejects a missing admin key with 401', async () => {
      const res = await request(app).get('/api/flags/admin');
      assert.equal(res.status, 401);
    });

    it('rejects a wrong admin key with 401', async () => {
      const res = await request(app).get('/api/flags/admin').set('x-admin-key', 'wrong');
      assert.equal(res.status, 401);
    });

    it('GET /api/flags/admin returns full flag detail with the right key', async () => {
      listFlagsResult = [{ key: 'discovery.enabled', enabled: true, default: true, override: null }];

      const res = await request(app).get('/api/flags/admin').set('x-admin-key', ADMIN_KEY);

      assert.equal(res.status, 200);
      assert.equal(res.body.flags.length, 1);
    });

    it('PATCH /api/flags/admin/:key sets an override', async () => {
      const res = await request(app)
        .patch('/api/flags/admin/discovery.enabled')
        .set('x-admin-key', ADMIN_KEY)
        .send({ enabled: false });

      assert.equal(res.status, 200);
      assert.deepEqual(setOverrideCalls.at(-1), {
        key: 'discovery.enabled',
        override: { enabled: false },
      });
    });

    it('PATCH surfaces service errors as 500', async () => {
      setOverrideError = new Error('Unknown feature flag: nope');
      const res = await request(app)
        .patch('/api/flags/admin/discovery.enabled')
        .set('x-admin-key', ADMIN_KEY)
        .send({ enabled: true });
      setOverrideError = null;

      assert.equal(res.status, 500);
      assert.match(res.body.error, /Unknown feature flag/);
    });

    it('DELETE /api/flags/admin/:key clears the override (null)', async () => {
      const res = await request(app)
        .delete('/api/flags/admin/discovery.enabled')
        .set('x-admin-key', ADMIN_KEY);

      assert.equal(res.status, 200);
      assert.deepEqual(setOverrideCalls.at(-1), { key: 'discovery.enabled', override: null });
    });

    it('DELETE surfaces service errors as 500', async () => {
      setOverrideError = new Error('redis exploded');
      const res = await request(app)
        .delete('/api/flags/admin/discovery.enabled')
        .set('x-admin-key', ADMIN_KEY);
      setOverrideError = null;

      assert.equal(res.status, 500);
    });
  });
});

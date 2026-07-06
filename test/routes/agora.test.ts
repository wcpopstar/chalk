export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { stubModule } = require('../helpers/stubModule');
const { buildTestApp } = require('../helpers/buildTestApp');
const { signAccessToken } = require('../../src/utils/jwt');

// src/routes/agora.js does `require('../socket/state')` for
// getUserCurrentRoom() — and socket/state.js opens a real ioredis
// connection at require time (src/socket/redisClient.js). Stub it out with
// a controllable fake, same approach as test/routes/friends.test.js.
let currentRoomResult = null;
stubModule(require.resolve('../../src/socket/state'), {
  getUserCurrentRoom: async () => currentRoomResult,
});

const userId = '11111111-1111-1111-1111-111111111111';

describe('Agora routes (/api/agora)', () => {
  let token;
  let restoreEnv;

  before(() => {
    // Isolate AGORA_* env vars per test (dev-fallback vs configured mode)
    // without leaking into other test files, since agora.js reads them at
    // *require time*, not per-request.
    const saved = { APP_ID: process.env.AGORA_APP_ID, CERT: process.env.AGORA_APP_CERTIFICATE };
    restoreEnv = () => {
      if (saved.APP_ID === undefined) delete process.env.AGORA_APP_ID; else process.env.AGORA_APP_ID = saved.APP_ID;
      if (saved.CERT === undefined) delete process.env.AGORA_APP_CERTIFICATE; else process.env.AGORA_APP_CERTIFICATE = saved.CERT;
    };

    ({ token } = signAccessToken({ id: userId, username: 'caller' }));
  });

  after(() => restoreEnv());

  beforeEach(() => {
    currentRoomResult = null;
  });

  describe('dev fallback mode (no APP_ID configured)', () => {
    let devApp;

    before(() => {
      delete process.env.AGORA_APP_ID;
      delete process.env.AGORA_APP_CERTIFICATE;
      delete require.cache[require.resolve('../../src/routes/agora')];
      const agoraRouter = require('../../src/routes/agora');
      devApp = buildTestApp({ '/api/agora': agoraRouter });
    });

    it('rejects requests with no access token', async () => {
      const res = await request(devApp).get('/api/agora/token');
      assert.equal(res.status, 401);
    });

    it("returns 403 when the channel does not match the caller's current call room", async () => {
      currentRoomResult = 'room-42';

      const res = await request(devApp)
        .get('/api/agora/token?channel=voice-someone-elses-room')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 403);
    });

    it('returns 503 when AGORA_APP_ID is not configured, even for a valid channel', async () => {
      currentRoomResult = 'room-42';

      const res = await request(devApp)
        .get('/api/agora/token?channel=voice-room-42')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 503);
    });
  });

  describe('configured mode (APP_ID + certificate set)', () => {
    let configuredApp;

    before(() => {
      process.env.AGORA_APP_ID = 'a'.repeat(32);
      process.env.AGORA_APP_CERTIFICATE = 'b'.repeat(32);
      delete require.cache[require.resolve('../../src/routes/agora')];
      const agoraRouter = require('../../src/routes/agora');
      configuredApp = buildTestApp({ '/api/agora': agoraRouter });
    });

    it("issues a real token for the caller's own current call channel", async () => {
      currentRoomResult = 'room-42';

      const res = await request(configuredApp)
        .get('/api/agora/token?channel=voice-room-42')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.appId, 'a'.repeat(32));
      assert.equal(res.body.channel, 'voice-room-42');
      assert.ok(res.body.token, 'expected a real (non-null) token in configured mode');
      assert.ok(Number.isInteger(res.body.uid) && res.body.uid > 0);
    });

    it('derives the same numeric uid for the same user id every time (deterministic hash)', async () => {
      currentRoomResult = 'room-42';

      const res1 = await request(configuredApp)
        .get('/api/agora/token?channel=voice-room-42')
        .set('Authorization', `Bearer ${token}`);
      const res2 = await request(configuredApp)
        .get('/api/agora/token?channel=voice-room-42')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res1.body.uid, res2.body.uid);
    });

    it('still enforces the current-room check in configured mode', async () => {
      currentRoomResult = 'room-42';

      const res = await request(configuredApp)
        .get('/api/agora/token?channel=voice-not-my-room')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 403);
    });
  });
});

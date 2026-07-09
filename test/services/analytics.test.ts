export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const analytics = require('../../src/services/analytics');

describe('analytics service', () => {
  describe('disabled mode (no POSTHOG_API_KEY / test env)', () => {
    it('capture/identify/shutdown are safe no-ops', async () => {
      // Under NODE_ENV=test the client is never created — these must not
      // throw and must not try to reach the network.
      analytics.capture('u1', 'user_registered');
      analytics.identify('u1', { country: 'DE' });
      await analytics.shutdownAnalytics();
    });
  });

  describe('enabled mode (fake client injected)', () => {
    const captured: any[] = [];
    const identified: any[] = [];
    let shutdownCalled = false;
    let failNext: any = null;

    const fakeClient = {
      capture(payload: any) {
        if (failNext) { const e = failNext; failNext = null; throw e; }
        captured.push(payload);
      },
      identify(payload: any) { identified.push(payload); },
      async shutdown() { shutdownCalled = true; },
      on() { return fakeClient; },
    };

    beforeEach(() => {
      captured.length = 0;
      identified.length = 0;
      failNext = null;
      analytics._setClientForTests(fakeClient);
    });

    it('capture() forwards distinctId, event name, and properties', () => {
      analytics.capture('user-1', 'match_found', { mode: 'solo', gameId: 'valorant' });

      assert.deepEqual(captured, [{
        distinctId: 'user-1',
        event: 'match_found',
        properties: { mode: 'solo', gameId: 'valorant' },
      }]);
    });

    it('capture() without a userId is dropped, not sent', () => {
      analytics.capture(undefined, 'user_registered');
      analytics.capture(null, 'user_registered');
      assert.equal(captured.length, 0);
    });

    it('capture() swallows SDK errors instead of breaking the caller', () => {
      failNext = new Error('posthog exploded');
      analytics.capture('user-1', 'swipe', { direction: 'right' }); // must not throw
      assert.equal(captured.length, 0);
    });

    it('identify() forwards profile properties', () => {
      analytics.identify('user-1', { country: 'DE' });
      assert.deepEqual(identified, [{ distinctId: 'user-1', properties: { country: 'DE' } }]);
    });

    it('shutdownAnalytics() flushes the client', async () => {
      await analytics.shutdownAnalytics();
      assert.equal(shutdownCalled, true);
    });
  });
});

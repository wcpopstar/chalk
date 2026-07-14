export {};
'use strict';

require('../helpers/testEnv');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('../helpers/stubModule');

// Build a fake socket handshake. The connection rate limiter and any IP keying
// derive the client IP from this — behind Cloudflare it must be the real user,
// not the CDN edge, or one abuser exhausts the limit for everyone on that edge.
function fakeSocket({ address, headers }: { address?: string; headers?: any } = {}) {
  return { handshake: { address: address ?? '10.0.0.1', headers: headers || {} }, conn: {} };
}

describe('clientIpFromHandshake — with a trusted proxy (default TRUST_PROXY=1)', () => {
  const { clientIpFromHandshake } = require('../../src/socket/validation');

  it('prefers Cloudflare CF-Connecting-IP over everything else', () => {
    const ip = clientIpFromHandshake(fakeSocket({
      address: '172.71.0.5', // a Cloudflare edge
      headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9, 172.71.0.5' },
    }));
    assert.equal(ip, '203.0.113.9');
  });

  it('falls back to the left-most X-Forwarded-For entry when no CF header', () => {
    const ip = clientIpFromHandshake(fakeSocket({
      address: '10.0.0.7',
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.7' },
    }));
    assert.equal(ip, '203.0.113.9');
  });

  it('falls back to the TCP peer when there are no forwarded headers', () => {
    const ip = clientIpFromHandshake(fakeSocket({ address: '198.51.100.4', headers: {} }));
    assert.equal(ip, '198.51.100.4');
  });
});

describe('clientIpFromHandshake — with NO trusted proxy (TRUST_PROXY=0)', () => {
  // With trustProxy 0, forwarded headers are attacker-controlled and must be
  // ignored entirely — otherwise anyone could forge X-Forwarded-For to dodge
  // the connection rate limit or frame another IP. Stub config to prove it.
  const restore = stubModule(require.resolve('../../src/config/env'), {
    config: { server: { trustProxy: 0 } },
    validateEnv: () => {},
  });
  const path = require('path');
  delete require.cache[path.resolve(__dirname, '../../src/socket/validation.ts')];
  const { clientIpFromHandshake } = require('../../src/socket/validation');
  restore();

  it('ignores a spoofed CF-Connecting-IP and uses the TCP peer', () => {
    const ip = clientIpFromHandshake(fakeSocket({
      address: '198.51.100.4',
      headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' },
    }));
    assert.equal(ip, '198.51.100.4');
  });
});

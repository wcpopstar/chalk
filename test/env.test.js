const test = require('node:test');
const assert = require('node:assert/strict');

const { getServerConfig, validateEnv } = require('../src/config/env');

test('getServerConfig uses defaults when env is missing', () => {
  const original = { ...process.env };

  delete process.env.PORT;
  delete process.env.NODE_ENV;
  delete process.env.CLIENT_URL;

  try {
    const config = getServerConfig();
    assert.equal(config.port, 3000);
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.clientOrigin, '*');
  } finally {
    process.env = original;
  }
});

test('validateEnv rejects missing required keys', () => {
  const original = { ...process.env };

  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.JWT_SECRET;

  try {
    assert.throws(() => validateEnv(), /SUPABASE_URL/);
  } finally {
    process.env = original;
  }
});

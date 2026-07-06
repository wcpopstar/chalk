export {};
require('./helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');

// config/env.ts computes `config` ONCE, when first require()'d, and
// freezes it — see that file's header comment. To test it against
// different env var combinations (rather than just whatever testEnv.ts set
// up before any test file ran), we have to bust the require cache and
// re-require it fresh each time; mutating process.env after the fact would
// have no effect on an already-loaded `config`.
function freshEnvModule() {
  const resolved = require.resolve('../src/config/env');
  delete require.cache[resolved];
  return require('../src/config/env');
}

test('config.server falls back to defaults when env is missing', () => {
  const original = { ...process.env };

  delete process.env.PORT;
  delete process.env.NODE_ENV;
  delete process.env.CLIENT_URL;

  try {
    const { config } = freshEnvModule();
    assert.equal(config.server.port, 3000);
    assert.equal(config.server.nodeEnv, 'development');
    assert.equal(config.server.isProduction, false);
    assert.equal(config.server.clientOrigin, '*');
  } finally {
    process.env = original;
    freshEnvModule(); // restore the module cache to the real test env
  }
});

test('config.server reflects an explicitly-set PORT/NODE_ENV/CLIENT_URL', () => {
  const original = { ...process.env };

  process.env.PORT = '4321';
  process.env.NODE_ENV = 'production';
  process.env.CLIENT_URL = 'https://chalk.example.com';

  try {
    const { config } = freshEnvModule();
    assert.equal(config.server.port, 4321);
    assert.equal(config.server.nodeEnv, 'production');
    assert.equal(config.server.isProduction, true);
    assert.equal(config.server.clientOrigin, 'https://chalk.example.com');
  } finally {
    process.env = original;
    freshEnvModule();
  }
});

test('validateEnv rejects missing required keys', () => {
  const original = { ...process.env };

  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.JWT_SECRET;

  try {
    const { validateEnv } = freshEnvModule();
    assert.throws(() => validateEnv(), /SUPABASE_URL/);
  } finally {
    process.env = original;
    freshEnvModule();
  }
});

test('validateEnv does not throw when all required keys are present', () => {
  // testEnv.ts (loaded before any test file, see test/helpers/testEnv.ts)
  // already sets dummy values for all four required keys — this exercises
  // that baseline directly, with no env mutation of its own.
  const { validateEnv } = freshEnvModule();
  assert.doesNotThrow(() => validateEnv());
});

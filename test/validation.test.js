const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSchema, loginSchema } = require('../src/validation/schemas');

test('registerSchema rejects short passwords and invalid emails', () => {
  assert.throws(() => registerSchema.parse({
    username: 'ab',
    email: 'not-an-email',
    password: '123',
  }), /password|email/i);
});

test('registerSchema allows empty username and leaves generation to backend', () => {
  const result = registerSchema.parse({
    email: 'user@example.com',
    password: 'StrongPass123',
  });
  assert.equal(result.username, undefined);
});

test('loginSchema requires email and password', () => {
  assert.throws(() => loginSchema.parse({ email: '' }), /email|password/i);
});

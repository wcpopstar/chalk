export {};
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { registerSchema, loginSchema, passwordSchema } = require('../src/validation/schemas');

describe('passwordSchema', () => {
  it('accepts a password with lowercase, uppercase, a digit and 8+ chars', () => {
    const result = passwordSchema.parse('StrongPass123');
    assert.equal(result, 'StrongPass123');
  });

  it('rejects passwords shorter than 8 characters', () => {
    assert.throws(() => passwordSchema.parse('Ab1'), /8|password/i);
  });

  it('rejects passwords with no uppercase letter', () => {
    assert.throws(() => passwordSchema.parse('alllower123'));
  });

  it('rejects passwords with no lowercase letter', () => {
    assert.throws(() => passwordSchema.parse('ALLUPPER123'));
  });

  it('rejects passwords with no digit', () => {
    assert.throws(() => passwordSchema.parse('NoDigitsHere'));
  });

  it('trims surrounding whitespace before validating', () => {
    const result = passwordSchema.parse('  StrongPass123  ');
    assert.equal(result, 'StrongPass123');
  });
});

describe('registerSchema', () => {
  it('accepts a fully valid payload', () => {
    const result = registerSchema.parse({
      username: 'cool_player-1',
      email: 'user@example.com',
      password: 'StrongPass123',
      country: 'Netherlands',
      languages: ['en', 'ru'],
    });

    assert.equal(result.username, 'cool_player-1');
    assert.equal(result.email, 'user@example.com');
  });

  it('rejects short passwords and invalid emails together', () => {
    assert.throws(
      () => registerSchema.parse({ username: 'ab', email: 'not-an-email', password: '123' }),
      /password|email/i,
    );
  });

  it('allows an omitted username and leaves generation to the backend', () => {
    const result = registerSchema.parse({
      email: 'user@example.com',
      password: 'StrongPass123',
    });

    assert.equal(result.username, undefined);
  });

  it('rejects a username shorter than 3 characters', () => {
    assert.throws(() =>
      registerSchema.parse({ username: 'ab', email: 'user@example.com', password: 'StrongPass123' }));
  });

  it('rejects a username longer than 24 characters', () => {
    assert.throws(() =>
      registerSchema.parse({
        username: 'a'.repeat(25),
        email: 'user@example.com',
        password: 'StrongPass123',
      }));
  });

  it('rejects a username with disallowed characters', () => {
    assert.throws(() =>
      registerSchema.parse({
        username: 'not@allowed!',
        email: 'user@example.com',
        password: 'StrongPass123',
      }));
  });

  it('accepts a username with spaces, underscores and hyphens', () => {
    const result = registerSchema.parse({
      username: 'cool name_1-2',
      email: 'user@example.com',
      password: 'StrongPass123',
    });

    assert.equal(result.username, 'cool name_1-2');
  });

  it('rejects a missing email', () => {
    assert.throws(() => registerSchema.parse({ password: 'StrongPass123' }));
  });

  it('rejects a missing password', () => {
    assert.throws(() => registerSchema.parse({ email: 'user@example.com' }));
  });

  it('trims a leading/trailing-whitespace email', () => {
    const result = registerSchema.parse({
      email: '  user@example.com  ',
      password: 'StrongPass123',
    });

    assert.equal(result.email, 'user@example.com');
  });

  it('accepts an optional languages array', () => {
    const result = registerSchema.parse({
      email: 'user@example.com',
      password: 'StrongPass123',
      languages: ['en'],
    });

    assert.deepEqual(result.languages, ['en']);
  });

  it('rejects a country name longer than 100 characters', () => {
    assert.throws(() =>
      registerSchema.parse({
        email: 'user@example.com',
        password: 'StrongPass123',
        country: 'a'.repeat(101),
      }));
  });
});

describe('loginSchema', () => {
  it('accepts a valid email/password pair', () => {
    const result = loginSchema.parse({ email: 'user@example.com', password: 'anything' });

    assert.equal(result.email, 'user@example.com');
  });

  it('requires both email and password', () => {
    assert.throws(() => loginSchema.parse({ email: '' }), /email|password/i);
  });

  it('rejects a malformed email', () => {
    assert.throws(() => loginSchema.parse({ email: 'not-an-email', password: 'anything' }));
  });

  it('rejects an empty password (unlike registerSchema, no complexity check here)', () => {
    assert.throws(() => loginSchema.parse({ email: 'user@example.com', password: '' }));
  });

  it('does not enforce password complexity on login (a pre-complexity-rule password must still work)', () => {
    // loginSchema intentionally only checks `min(1)` on password — it must
    // never reject a real, existing user's password just because that
    // password predates the current registerSchema complexity rules.
    const result = loginSchema.parse({ email: 'user@example.com', password: 'oldsimplepassword' });

    assert.equal(result.password, 'oldsimplepassword');
  });
});

// ── E2EE fields on PATCH /api/users/me ──────────────────────────────────────
describe('updateProfileSchema (E2EE fields)', () => {
  const { updateProfileSchema } = require('../src/validation/userSchemas');

  // Realistic shapes: 32-byte X25519 public key -> 44 b64 chars; backup blob
  // 48 bytes -> 64 chars; nonce 24 bytes -> 32 chars; salt 16 bytes -> 24 chars.
  const publicKey = 'A'.repeat(43) + '=';
  const backup = {
    e2ee_backup_secret: 'B'.repeat(64),
    e2ee_backup_nonce: 'C'.repeat(32),
    e2ee_backup_salt: 'D'.repeat(22) + '==',
    e2ee_backup_iters: 310000,
  };

  it('accepts a public key alone', () => {
    const result = updateProfileSchema.parse({ public_key: publicKey });
    assert.equal(result.public_key, publicKey);
  });

  it('accepts the full backup bundle (all four fields together)', () => {
    const result = updateProfileSchema.parse({ public_key: publicKey, ...backup });
    assert.equal(result.e2ee_backup_iters, 310000);
    assert.equal(result.e2ee_backup_nonce.length, 32);
  });

  it('rejects a partial backup (fields are useless apart)', () => {
    assert.throws(
      () => updateProfileSchema.parse({ e2ee_backup_secret: backup.e2ee_backup_secret }),
      /all together/
    );
  });

  it('rejects a non-base64 public key', () => {
    assert.throws(() => updateProfileSchema.parse({ public_key: '<script>' + 'A'.repeat(40) }));
  });

  it('rejects an out-of-range PBKDF2 iteration count', () => {
    assert.throws(() => updateProfileSchema.parse({ ...backup, e2ee_backup_iters: 1000 }));
  });
});

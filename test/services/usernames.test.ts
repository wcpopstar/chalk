export {};
'use strict';

require('../helpers/testEnv');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { generateUsername } = require('../../src/utils/usernames');

// Must satisfy validation/schemas.ts: 3-24 chars, [a-zA-Z0-9 _-].
const SCHEMA_RE = /^[a-zA-Z0-9 _-]{3,24}$/;

describe('generateUsername', () => {
  it('always produces schema-valid names', () => {
    for (let i = 0; i < 500; i++) {
      const name = generateUsername();
      assert.match(name, SCHEMA_RE, `invalid: ${name}`);
    }
  });

  it('clean names read like names: CamelCase words, NO digits', () => {
    for (let i = 0; i < 500; i++) {
      const name = generateUsername();
      assert.match(name, /^[A-Z][a-z]+[A-Z][a-zA-Z]+$/, `not AdjNoun-shaped: ${name}`);
      assert.doesNotMatch(name, /\d/, `clean name contains digits: ${name}`);
    }
  });

  it('suffix mode appends exactly two digits and stays schema-valid', () => {
    for (let i = 0; i < 200; i++) {
      const name = generateUsername({ suffix: true });
      assert.match(name, /^[A-Za-z]+\d{2}$/, `bad suffix shape: ${name}`);
      assert.match(name, SCHEMA_RE, `invalid: ${name}`);
    }
  });

  it('draws from a large space (no lazy "Player123" monoculture)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(generateUsername());
    // 72x88 = 6336 combos; 400 draws colliding down to <200 uniques would
    // mean the word lists silently shrank.
    assert.ok(seen.size > 200, `only ${seen.size} unique names in 400 draws`);
    for (const name of seen) {
      assert.doesNotMatch(name, /player/i, `generic "player" name slipped in: ${name}`);
    }
  });
});

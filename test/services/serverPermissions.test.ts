export {};
'use strict';

require('../helpers/testEnv');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  ALL_PERMISSIONS,
  combineRoleMasks,
  can,
  effectiveMask,
} = require('../../src/services/serverPermissions');

// This module is the authorization model for servers/guilds — every write path
// in routes/servers.ts and socket/servers.ts gates on `can()`. It's pure, so it
// can be pinned down exhaustively; a regression here is a privilege escalation,
// not a cosmetic bug.
describe('services/serverPermissions', () => {
  describe('PERMISSIONS', () => {
    it('assigns every permission a distinct single bit', () => {
      const bits = Object.values(PERMISSIONS) as number[];
      assert.equal(new Set(bits).size, bits.length, 'two permissions share a bit');
      for (const b of bits) {
        assert.equal(b & (b - 1), 0, `${b} is not a single bit`);
      }
    });

    it('is frozen, so a caller cannot redefine a bit at runtime', () => {
      const original = PERMISSIONS.VIEW_CHANNELS;
      // Whether the write throws or is silently dropped depends on the caller's
      // strictness; what must hold either way is that the bit does not move.
      try {
        (PERMISSIONS as any).VIEW_CHANNELS = 999;
      } catch {
        /* strict-mode callers get a TypeError — also fine */
      }
      assert.equal(PERMISSIONS.VIEW_CHANNELS, original);
      assert.ok(Object.isFrozen(PERMISSIONS));
    });
  });

  describe('DEFAULT_EVERYONE_PERMISSIONS', () => {
    it('grants view, send and invite — and nothing moderator-shaped', () => {
      const m = DEFAULT_EVERYONE_PERMISSIONS;
      assert.ok(can(m, PERMISSIONS.VIEW_CHANNELS));
      assert.ok(can(m, PERMISSIONS.SEND_MESSAGES));
      assert.ok(can(m, PERMISSIONS.CREATE_INVITE));

      // The default role must never hand out moderation powers.
      for (const perm of ['MANAGE_MESSAGES', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_SERVER', 'ADMINISTRATOR'] as const) {
        assert.equal(can(m, PERMISSIONS[perm]), false, `@everyone must not grant ${perm}`);
      }
    });
  });

  describe('combineRoleMasks', () => {
    it('ORs the masks of every role held', () => {
      const combined = combineRoleMasks([PERMISSIONS.VIEW_CHANNELS, PERMISSIONS.BAN_MEMBERS]);
      assert.ok(can(combined, PERMISSIONS.VIEW_CHANNELS));
      assert.ok(can(combined, PERMISSIONS.BAN_MEMBERS));
      assert.equal(can(combined, PERMISSIONS.MANAGE_ROLES), false);
    });

    it('treats null/undefined/absent masks as granting nothing', () => {
      assert.equal(combineRoleMasks([]), 0);
      assert.equal(combineRoleMasks([null, undefined]), 0);
    });

    it('accepts the string masks Postgres bigints come back as', () => {
      // server_roles.permissions arrives from supabase-js as a string for
      // bigint columns — coercing it wrong would silently grant nothing.
      const combined = combineRoleMasks(['1', '4']);
      assert.ok(can(combined, PERMISSIONS.VIEW_CHANNELS));
      assert.ok(can(combined, PERMISSIONS.MANAGE_MESSAGES));
    });
  });

  describe('can', () => {
    it('grants a permission the mask contains, and denies one it does not', () => {
      const mask = PERMISSIONS.VIEW_CHANNELS | PERMISSIONS.SEND_MESSAGES;
      assert.ok(can(mask, PERMISSIONS.SEND_MESSAGES));
      assert.equal(can(mask, PERMISSIONS.KICK_MEMBERS), false);
    });

    it('denies everything on an empty mask', () => {
      for (const perm of Object.values(PERMISSIONS) as number[]) {
        assert.equal(can(0, perm), false);
      }
    });

    it('lets ADMINISTRATOR imply every other permission', () => {
      for (const perm of Object.values(PERMISSIONS) as number[]) {
        assert.ok(can(PERMISSIONS.ADMINISTRATOR, perm), 'ADMINISTRATOR must imply everything');
      }
    });

    it('lets the owner do everything even with no roles at all', () => {
      for (const perm of Object.values(PERMISSIONS) as number[]) {
        assert.ok(can(0, perm, true), 'the owner must not be gated by roles');
      }
    });

    it('does not grant a permission from an unrelated bit', () => {
      // Guards against a `mask & perm !== 0` style bug: KICK_MEMBERS must not
      // fall out of holding BAN_MEMBERS.
      assert.equal(can(PERMISSIONS.BAN_MEMBERS, PERMISSIONS.KICK_MEMBERS), false);
    });
  });

  describe('effectiveMask', () => {
    it('gives the owner every bit regardless of roles', () => {
      assert.equal(effectiveMask([], true), ALL_PERMISSIONS);
      assert.equal(effectiveMask([PERMISSIONS.VIEW_CHANNELS], true), ALL_PERMISSIONS);
    });

    it('expands an ADMINISTRATOR role to every bit', () => {
      assert.equal(effectiveMask([PERMISSIONS.ADMINISTRATOR]), ALL_PERMISSIONS);
    });

    it('is the plain OR of roles for an ordinary member', () => {
      const mask = effectiveMask([PERMISSIONS.VIEW_CHANNELS, PERMISSIONS.CREATE_INVITE]);
      assert.equal(mask, PERMISSIONS.VIEW_CHANNELS | PERMISSIONS.CREATE_INVITE);
      assert.notEqual(mask, ALL_PERMISSIONS);
    });

    it('grants nothing to a member with no roles', () => {
      assert.equal(effectiveMask([]), 0);
    });
  });

  describe('ALL_PERMISSIONS', () => {
    it('contains every declared permission', () => {
      for (const perm of Object.values(PERMISSIONS) as number[]) {
        assert.ok(can(ALL_PERMISSIONS, perm));
      }
    });
  });
});

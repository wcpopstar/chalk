export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { stubModule } = require('../helpers/stubModule');

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// ── Repository ───────────────────────────────────────────────────────────
// Recorded rather than backed by a store: what matters here is the exact
// sequence of writes the service performs (invalidate → create → mark used /
// increment attempts), which is the anti-brute-force contract.
let latestRow: any;
let createError: any;
const repoCalls: any[] = [];
stubModule(require.resolve('../../src/repositories/emailCodesRepository'), {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  invalidateOutstanding: async (userId: string, purpose: string) => {
    repoCalls.push({ fn: 'invalidateOutstanding', userId, purpose });
    return { error: null };
  },
  create: async (args: any) => {
    repoCalls.push({ fn: 'create', ...args });
    return { error: createError };
  },
  findLatestValid: async (userId: string, purpose: string) => {
    repoCalls.push({ fn: 'findLatestValid', userId, purpose });
    return { data: latestRow, error: null };
  },
  markUsed: async (id: string) => {
    repoCalls.push({ fn: 'markUsed', id });
    return { error: null };
  },
  incrementAttempts: async (id: string, current: number) => {
    repoCalls.push({ fn: 'incrementAttempts', id, current });
    return { error: null };
  },
});

let enqueueError: any;
const enqueued: any[] = [];
stubModule(require.resolve('../../src/queues'), {
  enqueueEmailCode: async (to: string, code: string, purpose: string) => {
    if (enqueueError) throw enqueueError;
    enqueued.push({ to, code, purpose });
  },
  closeQueues: async () => {},
});

const sentInline: any[] = [];
stubModule(require.resolve('../../src/services/mailer'), {
  sendCodeEmail: async (to: string, code: string, purpose: string) => {
    sentInline.push({ to, code, purpose });
  },
});

const { issueAndSendCode, checkCode, generateCode, hashCode } = require('../../src/services/emailCodes');

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const userId = '11111111-1111-4111-8111-111111111111';
const user = { id: userId, email: 'me@example.com' };
const future = () => new Date(Date.now() + 60_000).toISOString();

describe('services/emailCodes', () => {
  beforeEach(() => {
    repoCalls.length = 0;
    enqueued.length = 0;
    sentInline.length = 0;
    latestRow = null;
    createError = null;
    enqueueError = null;
  });

  describe('generateCode', () => {
    it('always produces exactly 6 digits, zero-padded', () => {
      for (let i = 0; i < 200; i++) {
        assert.match(generateCode(), /^\d{6}$/);
      }
    });
  });

  describe('issueAndSendCode', () => {
    it('supersedes outstanding codes before creating the new one', async () => {
      await issueAndSendCode(user, 'login');

      // Order matters: if create ran first, a racing request could consume the
      // brand-new code's predecessor. Invalidate must come first.
      assert.equal(repoCalls[0].fn, 'invalidateOutstanding');
      assert.equal(repoCalls[1].fn, 'create');
      assert.equal(repoCalls[0].purpose, 'login');
    });

    it('stores only a hash of the code, never the code itself', async () => {
      await issueAndSendCode(user, 'login');

      const created = repoCalls.find((c) => c.fn === 'create');
      const mailed = enqueued[0].code;

      assert.match(mailed, /^\d{6}$/);
      assert.equal(created.codeHash, sha256(mailed));
      // The plaintext code must appear nowhere in what we persist.
      assert.ok(!JSON.stringify(created).includes(mailed));
    });

    it('sets the expiry from the repository TTL', async () => {
      const before = Date.now();
      await issueAndSendCode(user, 'verify_email');
      const created = repoCalls.find((c) => c.fn === 'create');

      const expiry = new Date(created.expiresAt).getTime();
      assert.ok(expiry >= before + CODE_TTL_MS);
      assert.ok(expiry <= Date.now() + CODE_TTL_MS);
    });

    it('mails the code through the queue', async () => {
      await issueAndSendCode(user, 'verify_email');

      assert.equal(enqueued.length, 1);
      assert.equal(enqueued[0].to, 'me@example.com');
      assert.equal(enqueued[0].purpose, 'verify_email');
      assert.equal(sentInline.length, 0);
    });

    it('falls back to sending inline when the queue is unavailable', async () => {
      enqueueError = new Error('redis down');

      await issueAndSendCode(user, 'login');

      // The user must still get their code even with Redis down.
      assert.equal(sentInline.length, 1);
      assert.equal(sentInline[0].to, 'me@example.com');
      assert.match(sentInline[0].code, /^\d{6}$/);
    });

    it('throws (and mails nothing) when the code cannot be persisted', async () => {
      createError = { message: 'insert failed' };

      await assert.rejects(() => issueAndSendCode(user, 'login'), /could not create email code/);

      // Mailing a code we never stored would guarantee a failed check later.
      assert.equal(enqueued.length, 0);
      assert.equal(sentInline.length, 0);
    });
  });

  describe('checkCode', () => {
    it('rejects when there is no outstanding code', async () => {
      latestRow = null;

      const result = await checkCode(userId, 'login', '123456');

      assert.equal(result.ok, false);
      assert.match(result.error, /недействителен/);
    });

    it('rejects an expired code without counting an attempt', async () => {
      latestRow = {
        id: 'c1',
        code_hash: sha256('123456'),
        attempts: 0,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      };

      const result = await checkCode(userId, 'login', '123456');

      assert.equal(result.ok, false);
      assert.ok(!repoCalls.some((c) => c.fn === 'markUsed'));
      assert.ok(!repoCalls.some((c) => c.fn === 'incrementAttempts'));
    });

    it('counts a failed attempt on a wrong code and does not consume it', async () => {
      latestRow = { id: 'c1', code_hash: sha256('123456'), attempts: 2, expires_at: future() };

      const result = await checkCode(userId, 'login', '999999');

      assert.equal(result.ok, false);
      assert.deepEqual(
        repoCalls.filter((c) => c.fn === 'incrementAttempts'),
        [{ fn: 'incrementAttempts', id: 'c1', current: 2 }],
      );
      assert.ok(!repoCalls.some((c) => c.fn === 'markUsed'));
    });

    it('locks out after MAX_ATTEMPTS, even if the code is finally correct', async () => {
      latestRow = { id: 'c1', code_hash: sha256('123456'), attempts: MAX_ATTEMPTS, expires_at: future() };

      const result = await checkCode(userId, 'login', '123456');

      assert.equal(result.ok, false);
      assert.match(result.error, /Слишком много попыток/);
      // The brute-force cap must win over a correct guess — otherwise the
      // limit could be walked past by an attacker who lands the right code.
      assert.ok(!repoCalls.some((c) => c.fn === 'markUsed'));
    });

    it('accepts the right code and consumes it so it is single-use', async () => {
      latestRow = { id: 'c1', code_hash: sha256('123456'), attempts: 1, expires_at: future() };

      const result = await checkCode(userId, 'login', '123456');

      assert.equal(result.ok, true);
      assert.ok(repoCalls.some((c) => c.fn === 'markUsed' && c.id === 'c1'));
    });

    it('looks the code up scoped to the requested purpose', async () => {
      latestRow = { id: 'c1', code_hash: sha256('123456'), attempts: 0, expires_at: future() };

      await checkCode(userId, 'verify_email', '123456');

      // A verify_email code must never satisfy a login check, and vice versa.
      const lookup = repoCalls.find((c) => c.fn === 'findLatestValid');
      assert.equal(lookup.purpose, 'verify_email');
      assert.equal(lookup.userId, userId);
    });

    it('gives the same generic error for a wrong code and a missing one', async () => {
      latestRow = null;
      const missing = await checkCode(userId, 'login', '123456');

      latestRow = { id: 'c1', code_hash: sha256('123456'), attempts: 0, expires_at: future() };
      const wrong = await checkCode(userId, 'login', '000000');

      // Distinguishable errors would tell an attacker whether a code is live.
      assert.equal(missing.error, wrong.error);
    });
  });

  describe('hashCode', () => {
    it('is a stable sha256 of the code', () => {
      assert.equal(hashCode('123456'), sha256('123456'));
      assert.equal(hashCode('123456'), hashCode('123456'));
      assert.notEqual(hashCode('123456'), hashCode('123457'));
    });
  });
});

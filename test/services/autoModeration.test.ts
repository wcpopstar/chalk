export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');
const { FakeRedis } = require('../helpers/fakeRedis');

const fakeRedis = new FakeRedis();
stubModule(require.resolve('../../src/socket/redisClient'), {
  redis: fakeRedis,
  pubClient: fakeRedis,
  subClient: fakeRedis,
  waitForRedisReady: async () => {},
  REDIS_URL: 'redis://fake',
});

const { checkMessage, containsProfanity, isLinkSpam } = require('../../src/services/autoModeration');

let userSeq = 0;
const freshUser = () => `am-user-${++userSeq}`;

describe('autoModeration', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
  });

  describe('containsProfanity', () => {
    it('detects common RU profanity', () => {
      assert.equal(containsProfanity('да пиздец какой-то'), true);
      assert.equal(containsProfanity('иди на хуй'), true);
      assert.equal(containsProfanity('ну ты и мудак'), true);
    });

    it('detects RU profanity behind lookalike/leet substitutions', () => {
      assert.equal(containsProfanity('пи3дец'), true);   // digit 3 → е
      assert.equal(containsProfanity('xуй'), true);       // latin x
      assert.equal(containsProfanity('б л я т ь'), true); // spaced out
      assert.equal(containsProfanity('бляяяяять'), true); // letter repeats
    });

    it('detects EN profanity with word boundaries', () => {
      assert.equal(containsProfanity('fuck you'), true);
      assert.equal(containsProfanity('what the shit'), true);
    });

    it('does not fire inside innocent words', () => {
      assert.equal(containsProfanity('я себя хорошо чувствую'), false);
      assert.equal(containsProfanity('употребил новое слово'), false);
      assert.equal(containsProfanity('class assignment is done'), false);
      assert.equal(containsProfanity('обляпался краской'), false);
      assert.equal(containsProfanity('привет, как дела?'), false);
    });
  });

  describe('isLinkSpam', () => {
    it('allows a few links but rejects a wall of them', () => {
      assert.equal(isLinkSpam('смотри https://a.com и https://b.com'), false);
      assert.equal(isLinkSpam('https://a.com https://b.com https://c.com https://d.com'), true);
    });
  });

  describe('checkMessage', () => {
    it('passes a clean message through', async () => {
      const v = await checkMessage(freshUser(), 'привет, поиграем вечером?');
      assert.equal(v.ok, true);
    });

    it('rejects profanity with a reason', async () => {
      const v = await checkMessage(freshUser(), 'да пошёл ты на хуй');
      assert.equal(v.ok, false);
      assert.equal(v.reason, 'profanity');
      assert.match(v.error, /лексик/i);
    });

    it('auto-mutes after 3 violations — a clean message is then rejected too', async () => {
      const uid = freshUser();
      await checkMessage(uid, 'хуй 1');
      await checkMessage(uid, 'хуй 2');
      const third = await checkMessage(uid, 'хуй 3');
      assert.equal(third.ok, false);
      assert.match(third.error, /ограничена/i); // mute notice appended on the 3rd strike

      const clean = await checkMessage(uid, 'а теперь нормальное сообщение');
      assert.equal(clean.ok, false);
      assert.equal(clean.reason, 'muted');
      assert.ok(clean.mutedForSec > 0);
    });

    it('rejects the same message repeated 3 times (flood), but allows varied ones', async () => {
      const uid = freshUser();
      assert.equal((await checkMessage(uid, 'купи слона')).ok, true);
      assert.equal((await checkMessage(uid, 'купи слона')).ok, true);
      const third = await checkMessage(uid, 'купи слона');
      assert.equal(third.ok, false);
      assert.equal(third.reason, 'flood');

      const varied = await checkMessage(freshUser(), 'другое сообщение');
      assert.equal(varied.ok, true);
    });

    it('is a no-op when the moderation.auto.enabled flag is off', async () => {
      process.env.FEATURE_MODERATION_AUTO_ENABLED = 'false';
      try {
        const v = await checkMessage(freshUser(), 'да пиздец какой-то');
        assert.equal(v.ok, true);
      } finally {
        delete process.env.FEATURE_MODERATION_AUTO_ENABLED;
      }
    });
  });
});

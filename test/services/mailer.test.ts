export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');

// Swap nodemailer for a capturing fake BEFORE the mailer is required, so
// the SMTP branch can be exercised without a real mail server.
const sentMail: any[] = [];
let createTransportOpts: any = null;
stubModule(require.resolve('nodemailer'), {
  createTransport: (opts: any) => {
    createTransportOpts = opts;
    return { sendMail: async (mail: any) => { sentMail.push(mail); return { messageId: 'fake-smtp' }; } };
  },
});

describe('mailer service', () => {
  describe('dev fallback (no SMTP_HOST)', () => {
    let mailer: any;

    before(() => {
      delete process.env.SMTP_HOST;
      delete require.cache[require.resolve('../../src/config/env')];
      delete require.cache[require.resolve('../../src/services/mailer')];
      mailer = require('../../src/services/mailer');
    });

    it('logs the email instead of sending (and does not throw)', async () => {
      await mailer.sendPasswordResetEmail('dev@example.com', 'https://app/?reset=tok');
      assert.equal(sentMail.length, 0); // nodemailer never used
    });
  });

  describe('SMTP configured', () => {
    let mailer: any;

    before(() => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '465';
      process.env.SMTP_USER = 'mailer';
      process.env.SMTP_PASS = 'secret';
      delete require.cache[require.resolve('../../src/config/env')];
      delete require.cache[require.resolve('../../src/services/mailer')];
      mailer = require('../../src/services/mailer');
    });

    it('sends the reset email through nodemailer with the reset link', async () => {
      await mailer.sendPasswordResetEmail('user@example.com', 'https://app/?reset=raw-token');

      assert.equal(sentMail.length, 1);
      const mail = sentMail[0];
      assert.equal(mail.to, 'user@example.com');
      assert.match(mail.subject, /Сброс пароля/);
      assert.match(mail.text, /https:\/\/app\/\?reset=raw-token/);
      assert.match(mail.html, /https:\/\/app\/\?reset=raw-token/);

      // port 465 -> implicit TLS; auth passed through
      assert.equal(createTransportOpts.host, 'smtp.example.com');
      assert.equal(createTransportOpts.port, 465);
      assert.equal(createTransportOpts.secure, true);
      assert.deepEqual(createTransportOpts.auth, { user: 'mailer', pass: 'secret' });
    });

    it('reuses the transporter on subsequent sends', async () => {
      const before = createTransportOpts;
      await mailer.sendPasswordResetEmail('user2@example.com', 'https://app/?reset=tok2');
      assert.equal(createTransportOpts, before); // createTransport not called again
      assert.equal(sentMail.length, 2);
    });
  });
});

const nodemailer = require('nodemailer');
const logger = require('../utils/logger').child({ module: 'mailer' });
const { config } = require('../config/env');

let transporter: any = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!config.smtp.host) {
    // No SMTP configured — fall back to logging the email to the console.
    // Useful for local development so the reset link is still visible.
    transporter = {
      sendMail: async (opts: any) => {
        // Intentionally logged in full (not redacted) — this dev-only
        // fallback exists specifically so the reset link is visible when
        // no SMTP server is configured locally.
        logger.info(
          { to: opts.to, subject: opts.subject, text: opts.text },
          '📧 DEV MAIL — no SMTP configured, printing instead'
        );
        return { messageId: 'dev-console' };
      },
    };
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
  });

  return transporter;
}

async function sendPasswordResetEmail(to: any, resetUrl: any) {
  const t = getTransporter();
  await t.sendMail({
    from: config.smtp.from,
    to,
    subject: 'Сброс пароля — Chalk',
    text:
      'Мы получили запрос на сброс пароля для твоего аккаунта Chalk.\n\n' +
      `Перейди по ссылке, чтобы задать новый пароль (ссылка действует 30 минут):\n${resetUrl}\n\n` +
      'Если это был не ты — просто проигнорируй это письмо, пароль останется прежним.',
    html:
      `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#111">` +
      `<p>Мы получили запрос на сброс пароля для твоего аккаунта <b>Chalk</b>.</p>` +
      `<p><a href="${resetUrl}" style="background:#c8ff00;color:#000;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Сбросить пароль</a></p>` +
      `<p style="color:#888;font-size:12px">Ссылка действует 30 минут. Если это был не ты — просто проигнорируй это письмо.</p>` +
      `</div>`,
  });
}

export { sendPasswordResetEmail };

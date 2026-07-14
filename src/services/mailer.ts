import nodemailer from 'nodemailer';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'mailer' });
import { config } from '../config/env';

let transporter: any = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!config.smtp.host) {
    // No SMTP configured — fall back to logging the email to the console.
    // Useful for local development so the reset link is still visible.
    transporter = {
      sendMail: async (opts: { to: string; subject: string; text: string }) => {
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
      // pass is `string | null` in config; nodemailer's auth takes an optional
      // string, and null is not the same thing as absent to its type.
      ? { user: config.smtp.user, pass: config.smtp.pass ?? undefined }
      : undefined,
  });

  return transporter;
}

async function sendPasswordResetEmail(to: string, resetUrl: string) {
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

// Subjects/intro lines differ by what the code is for, but the layout (a big
// monospace code the user types back in) is shared.
const CODE_COPY: Record<string, { subject: string; intro: string }> = {
  verify_email: {
    subject: 'Подтверждение почты — Chalk',
    intro: 'Спасибо за регистрацию в Chalk! Введи этот код, чтобы подтвердить свою почту:',
  },
  login: {
    subject: 'Код для входа — Chalk',
    intro: 'Кто-то (надеемся, ты) запросил вход в Chalk. Введи этот код, чтобы войти:',
  },
};

async function sendCodeEmail(to: string, code: string, purpose: string) {
  const copy = CODE_COPY[purpose] ?? CODE_COPY.login!;
  const t = getTransporter();
  await t.sendMail({
    from: config.smtp.from,
    to,
    subject: copy.subject,
    text:
      `${copy.intro}\n\n` +
      `    ${code}\n\n` +
      'Код действует 15 минут. Если это был не ты — просто проигнорируй это письмо.',
    html:
      `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#111">` +
      `<p>${copy.intro}</p>` +
      `<p style="font-size:32px;font-weight:700;letter-spacing:8px;font-family:monospace;background:#f4f4f4;padding:14px 20px;border-radius:10px;display:inline-block">${code}</p>` +
      `<p style="color:#888;font-size:12px">Код действует 15 минут. Если это был не ты — просто проигнорируй это письмо.</p>` +
      `</div>`,
  });
}

export { sendPasswordResetEmail, sendCodeEmail };

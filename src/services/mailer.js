const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST) {
    // No SMTP configured — fall back to logging the email to the console.
    // Useful for local development so the reset link is still visible.
    transporter = {
      sendMail: async (opts) => {
        console.log('\n📧 [DEV MAIL — no SMTP configured, printing instead]');
        console.log('To:', opts.to);
        console.log('Subject:', opts.subject);
        console.log('Text:', opts.text);
        console.log('');
        return { messageId: 'dev-console' };
      },
    };
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  return transporter;
}

async function sendPasswordResetEmail(to, resetUrl) {
  const t = getTransporter();
  await t.sendMail({
    from: process.env.SMTP_FROM || 'Chalk <no-reply@chalk.gg>',
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

module.exports = { sendPasswordResetEmail };

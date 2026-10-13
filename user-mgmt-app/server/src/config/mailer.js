const nodemailer = require('nodemailer');
const env = require('./env');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
});

async function sendMail({ to, subject, html }) {
  return transporter.sendMail({ from: env.MAIL_FROM, to, subject, html });
}

// Fire-and-forget wrapper: an email failure should never break the request.
function sendMailSafe(options) {
  sendMail(options).catch((err) => console.error('Email failed:', err.message));
}

module.exports = { sendMail, sendMailSafe };

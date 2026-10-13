const env = require('../config/env');

// Verifies a reCAPTCHA token with Google. Needs Node 18+ (global fetch).
async function verifyCaptcha(token, ip) {
  const params = new URLSearchParams({ secret: env.RECAPTCHA_SECRET, response: token });
  if (ip) params.append('remoteip', ip);
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'POST', body: params });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('Captcha verification failed:', err.message);
    return false;
  }
}

module.exports = { verifyCaptcha };

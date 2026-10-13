const bcrypt = require('bcryptjs');
const prisma = require('../../config/db');
const env = require('../../config/env');
const { sendMailSafe } = require('../../config/mailer');
const { setAuthCookie, clearAuthCookie } = require('../../middleware/auth');
const { sha256, randomToken, randomOtp } = require('../../utils/crypto');
const tpl = require('../../utils/emailTemplates');
const { OAuth2Client } = require('google-auth-library');
const { verifyCaptcha } = require('../../utils/captcha');

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

// Creates a fresh OTP (invalidating older ones) and returns the plain code.
async function issueOtp(userId, purpose) {
  const code = randomOtp();
  await prisma.$transaction([
    prisma.otp.updateMany({ where: { userId, purpose, used: false }, data: { used: true } }),
    prisma.otp.create({
      data: { userId, purpose, codeHash: sha256(code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    }),
  ]);
  return code;
}

async function sendVerificationOtp(user) {
  const code = await issueOtp(user.id, 'VERIFY_EMAIL');
  sendMailSafe({ to: user.email, subject: 'Verify your email', html: tpl.verifyEmail(user.name, code) });
}

async function sentRecently(userId, purpose) {
  const last = await prisma.otp.findFirst({ where: { userId, purpose }, orderBy: { createdAt: 'desc' } });
  return !!last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS;
}

const safeUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  profilePicture: u.profilePicture,
  role: u.role,
  createdAt: u.createdAt,
});

exports.register = async (req, res) => {
  const { name, email, password } = req.body;
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) {
    return res.status(409).json({ message: 'An account with this email already exists.', errors: { email: ['Email already in use'] } });
  }
  const user = await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash(password, 12) },
  });
  // No session yet: the account must be verified first.
  await sendVerificationOtp(user);
  res.status(201).json({ email: user.email, message: 'Account created. Enter the code we emailed you to verify your email.' });
};

exports.verifyEmail = async (req, res) => {
  const { email, otp } = req.body;
  const invalid = () =>
    res.status(400).json({ message: 'That code is incorrect or has expired.', errors: { otp: ['Incorrect or expired code'] } });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return invalid();
  if (user.isVerified) return res.status(400).json({ message: 'This email is already verified. Sign in instead.' });

  const record = await findActiveOtp(user.id, 'VERIFY_EMAIL');
  if (!record) return invalid();
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
  }
  if (record.codeHash !== sha256(otp)) {
    await prisma.otp.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    return invalid();
  }

  const [verified] = await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { isVerified: true } }),
    prisma.otp.update({ where: { id: record.id }, data: { used: true } }),
  ]);
  sendMailSafe({ to: verified.email, subject: 'Welcome aboard', html: tpl.welcome(verified.name) });
  setAuthCookie(res, verified.id); // verified users are signed in right away
  res.json({ user: safeUser(verified) });
};

exports.resendVerification = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (user && !user.isVerified) {
    if (await sentRecently(user.id, 'VERIFY_EMAIL')) {
      return res.status(429).json({ message: 'Please wait a minute before requesting another code.' });
    }
    await sendVerificationOtp(user);
  }
  res.json({ message: 'If that account still needs verifying, a new code is on its way.' });
};

exports.login = async (req, res) => {
  const { email, password, captchaToken } = req.body;
  if (!env.RECAPTCHA_SECRET) {
    return res.status(500).json({ message: 'Captcha is not configured on the server.' });
  }
  if (!(await verifyCaptcha(captchaToken, req.ip))) {
    return res.status(400).json({ code: 'CAPTCHA_FAILED', message: 'Captcha check failed. Please try again.' });
  }
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user?.passwordHash && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) return res.status(401).json({ message: 'Email or password is incorrect.' });
  if (!user.isVerified) {
    if (!(await sentRecently(user.id, 'VERIFY_EMAIL'))) await sendVerificationOtp(user);
    return res.status(403).json({
      code: 'EMAIL_NOT_VERIFIED',
      email: user.email,
      message: 'Verify your email to sign in. We sent you a code.',
    });
  }
  setAuthCookie(res, user.id);
  res.json({ user: safeUser(user) });
};

exports.googleLogin = async (req, res) => {
  if (!env.GOOGLE_CLIENT_ID) {
    return res.status(500).json({ message: 'Google sign-in is not configured on the server.' });
  }
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ message: 'Google sign-in failed. Please try again.' });
  }
  if (!payload?.email || !payload.email_verified) {
    return res.status(401).json({ message: 'Your Google email address is not verified.' });
  }

  const email = payload.email.toLowerCase();
  let user = await prisma.user.findFirst({ where: { OR: [{ googleId: payload.sub }, { email }] } });

  if (!user) {
    user = await prisma.user.create({
      data: {
        name: payload.name || email.split('@')[0],
        email,
        googleId: payload.sub,
        isVerified: true, // Google already verified this address
        profilePicture: payload.picture || null,
      },
    });
    sendMailSafe({ to: email, subject: 'Welcome aboard', html: tpl.welcome(user.name) });
  } else {
    // Existing account: link Google to it and fill in anything missing.
    const data = {};
    if (!user.googleId) data.googleId = payload.sub;
    if (!user.isVerified) data.isVerified = true;
    if (!user.profilePicture && payload.picture) data.profilePicture = payload.picture;
    if (Object.keys(data).length) user = await prisma.user.update({ where: { id: user.id }, data });
  }

  setAuthCookie(res, user.id);
  res.json({ user: safeUser(user) });
};

exports.logout = (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Signed out' });
};

exports.me = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(401).json({ message: 'Not authenticated' });
  res.json({ user: safeUser(user) });
};

// ---- Forgot / reset password ----
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const token = randomToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    const link = `${env.CLIENT_URL}/reset-password?token=${token}`;
    sendMailSafe({ to: email, subject: 'Reset your password', html: tpl.resetPassword(user.name, link) });
  }
  // Same response either way so emails can't be probed.
  res.json({ message: 'If that email is registered, a reset link is on its way.' });
};

exports.resetPassword = async (req, res) => {
  const { token, password } = req.body;
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!record || record.used || record.expiresAt < new Date()) {
    return res.status(400).json({ message: 'This reset link is invalid or has expired. Request a new one.' });
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await bcrypt.hash(password, 12), isVerified: true } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { used: true } }),
  ]);
  sendMailSafe({ to: record.user.email, subject: 'Your password was changed', html: tpl.passwordChanged(record.user.name) });
  res.json({ message: 'Password updated. You can sign in now.' });
};

// ---- Change password (3 steps: request OTP -> verify OTP -> set new password) ----
exports.requestPasswordOtp = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (user && !user.passwordHash) {
    return res.status(400).json({
      message: 'Your account signs in with Google and has no password yet. Use "Forgot password" on the sign-in page to create one.',
    });
  }
  if (!user?.passwordHash || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
    return res.status(400).json({ message: 'Current password is incorrect.', errors: { currentPassword: ['Incorrect password'] } });
  }
  const code = randomOtp();
  await prisma.$transaction([
    prisma.otp.updateMany({ where: { userId: user.id, purpose: 'CHANGE_PASSWORD', used: false }, data: { used: true } }),
    prisma.otp.create({
      data: { userId: user.id, purpose: 'CHANGE_PASSWORD', codeHash: sha256(code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    }),
  ]);
  sendMailSafe({ to: user.email, subject: 'Your verification code', html: tpl.otp(user.name, code) });
  res.json({ message: 'We emailed you a 6-digit code.' });
};

function findActiveOtp(userId, purpose = 'CHANGE_PASSWORD') {
  return prisma.otp.findFirst({
    where: { userId, purpose, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
}

exports.verifyOtp = async (req, res) => {
  const otp = await findActiveOtp(req.userId);
  if (!otp) return res.status(400).json({ message: 'Code expired. Request a new one.' });
  if (otp.attempts >= MAX_OTP_ATTEMPTS) {
    return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
  }
  if (otp.codeHash !== sha256(req.body.otp)) {
    await prisma.otp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return res.status(400).json({ message: 'That code is incorrect.', errors: { otp: ['Incorrect code'] } });
  }
  await prisma.otp.update({ where: { id: otp.id }, data: { verified: true } });
  res.json({ message: 'Code verified.' });
};

exports.changePassword = async (req, res) => {
  const otp = await findActiveOtp(req.userId);
  if (!otp || !otp.verified) {
    return res.status(400).json({ message: 'Verify the code we emailed you first.' });
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(req.body.newPassword, 12) } }),
    prisma.otp.update({ where: { id: otp.id }, data: { used: true } }),
  ]);
  sendMailSafe({ to: user.email, subject: 'Your password was changed', html: tpl.passwordChanged(user.name) });
  res.json({ message: 'Password changed.' });
};

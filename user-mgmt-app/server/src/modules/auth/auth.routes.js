const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const s = require('./auth.schemas');
const c = require('./auth.controller');

// Wrap async handlers so thrown errors reach the error middleware (Express 4).
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const limiter = (max) =>
  rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
    message: { message: 'Too many attempts. Try again in a few minutes.' } });

router.post('/register', limiter(20), validate(s.register), h(c.register));
router.post('/verify-email', limiter(15), validate(s.verifyEmail), h(c.verifyEmail));
router.post('/resend-verification', limiter(8), validate(s.resendVerification), h(c.resendVerification));
router.post('/login', limiter(10), validate(s.login), h(c.login));
router.post('/google', limiter(20), validate(s.googleLogin), h(c.googleLogin));
router.post('/logout', c.logout);
router.get('/me', requireAuth, h(c.me));

router.post('/forgot-password', limiter(5), validate(s.forgotPassword), h(c.forgotPassword));
router.post('/reset-password', limiter(10), validate(s.resetPassword), h(c.resetPassword));

router.post('/change-password/request-otp', requireAuth, limiter(5), validate(s.requestOtp), h(c.requestPasswordOtp));
router.post('/change-password/verify-otp', requireAuth, limiter(15), validate(s.verifyOtp), h(c.verifyOtp));
router.post('/change-password', requireAuth, validate(s.changePassword), h(c.changePassword));

module.exports = router;

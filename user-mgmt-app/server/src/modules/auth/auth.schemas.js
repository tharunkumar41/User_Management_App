const { z } = require('zod');

const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

const email = z.string().trim().toLowerCase().email('Enter a valid email address');

exports.register = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(80),
  email,
  password,
});

exports.login = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
  captchaToken: z.string().min(1, 'Please complete the captcha'),
});
exports.googleLogin = z.object({ credential: z.string().min(20) });
exports.forgotPassword = z.object({ email });
exports.resetPassword = z.object({ token: z.string().min(10), password });
exports.requestOtp = z.object({ currentPassword: z.string().min(1, 'Enter your current password') });
exports.verifyOtp = z.object({ otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });
exports.changePassword = z.object({ newPassword: password });
exports.verifyEmail = z.object({ email, otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });
exports.resendVerification = z.object({ email });

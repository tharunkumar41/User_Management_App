const jwt = require('jsonwebtoken');
const env = require('../config/env');
const prisma = require('../config/db');

const COOKIE_NAME = 'token';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.isProd,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function setAuthCookie(res, userId) {
  const token = jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
  res.cookie(COOKIE_NAME, token, cookieOptions);
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: env.isProd });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ message: 'Not authenticated' });
  try {
    req.userId = jwt.verify(token, env.JWT_SECRET).sub;
    next();
  } catch {
    return res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }
}

// Used from Features List 2 onward (admin-only user management).
const requireRole = (...roles) => async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } });
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ message: 'You don\'t have permission to do that.' });
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { setAuthCookie, clearAuthCookie, requireAuth, requireRole };

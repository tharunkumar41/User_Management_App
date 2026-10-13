const prisma = require('../../config/db');

exports.list = async (req, res) => {
  const [data, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: { userId: req.userId, readAt: null } }),
  ]);
  res.json({ data, unread });
};

exports.markAllRead = async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.userId, readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
};

// Upsert: if someone else used this browser before, the token moves to the current user.
exports.saveToken = async (req, res) => {
  const { token } = req.body;
  await prisma.deviceToken.upsert({
    where: { token },
    update: { userId: req.userId },
    create: { token, userId: req.userId },
  });
  res.json({ ok: true });
};

exports.removeToken = async (req, res) => {
  await prisma.deviceToken.deleteMany({ where: { token: req.body.token, userId: req.userId } });
  res.json({ ok: true });
};

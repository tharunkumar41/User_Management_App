const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const prisma = require('../../config/db');
const { AVATAR_DIR } = require('../../middleware/upload');

const pick = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone,
  profilePicture: u.profilePicture, role: u.role, createdAt: u.createdAt,
});

exports.updateSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(80),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number')
    .or(z.literal(''))
    .optional(),
});

exports.get = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  res.json({ user: pick(user) });
};

exports.update = async (req, res) => {
  const { name, phone } = req.body;
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { name, phone: phone || null },
  });
  res.json({ user: pick(user) });
};

exports.uploadPicture = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Choose an image to upload.' });
  const current = await prisma.user.findUnique({ where: { id: req.userId } });
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { profilePicture: `/uploads/avatars/${req.file.filename}` },
  });
  // Remove the previous file so uploads don't pile up.
  if (current.profilePicture?.startsWith('/uploads/avatars/')) {
    fs.unlink(path.join(AVATAR_DIR, path.basename(current.profilePicture)), () => {});
  }
  res.json({ user: pick(user) });
};

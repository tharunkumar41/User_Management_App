const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { parse } = require('csv-parse/sync');
const PDFDocument = require('pdfkit');
const prisma = require('../../config/db');
const env = require('../../config/env');
const { sendMailSafe } = require('../../config/mailer');
const { sha256, randomToken } = require('../../utils/crypto');
const tpl = require('../../utils/emailTemplates');
const { AVATAR_DIR } = require('../../middleware/upload');
const { importRow } = require('./users.schemas');

const SELECT = {
  id: true, name: true, email: true, phone: true, role: true,
  isVerified: true, profilePicture: true, createdAt: true, updatedAt: true,
};
const INVITE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_IMPORT_ROWS = 500;
const MAX_EXPORT_ROWS = 50000;

function buildWhere({ search, role }) {
  const where = {};
  const q = String(search || '').trim();
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
    ];
  }
  if (role === 'USER' || role === 'ADMIN') where.role = role;
  return where;
}

// Emails a link (the existing reset-password page) so the new user picks their own password.
async function sendInvite(user) {
  const token = randomToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });
  const link = `${env.CLIENT_URL}/reset-password?token=${token}`;
  sendMailSafe({ to: user.email, subject: 'Set up your account', html: tpl.invite(user.name, link) });
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'user';

// ---------------- list ----------------
exports.list = async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  const where = buildWhere(req.query);

  const [total, data] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where, select: SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * limit, take: limit,
    }),
  ]);
  res.json({ data, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) });
};

exports.getOne = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: SELECT });
  if (!user) return res.status(404).json({ message: 'User not found.' });
  res.json({ user });
};

// ---------------- add / edit ----------------
exports.create = async (req, res) => {
  const { name, email, phone, role, password } = req.body;
  if (await prisma.user.findUnique({ where: { email } })) {
    return res.status(409).json({ message: 'A user with this email already exists.', errors: { email: ['Email already in use'] } });
  }
  const user = await prisma.user.create({
    data: {
      name, email, phone: phone || null, role,
      isVerified: true, // added by an admin, so no email verification step
      passwordHash: password ? await bcrypt.hash(password, 12) : null,
    },
    select: SELECT,
  });
  if (password) sendMailSafe({ to: email, subject: 'Your account is ready', html: tpl.accountCreated(name, env.CLIENT_URL) });
  else await sendInvite(user);
  res.status(201).json({ user });
};

exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, role } = req.body;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ message: 'User not found.' });

  if (id === req.userId && role !== target.role) {
    return res.status(400).json({ message: 'You can\'t change your own role.', errors: { role: ['You can\'t change your own role'] } });
  }
  if (email !== target.email && (await prisma.user.findUnique({ where: { email } }))) {
    return res.status(409).json({ message: 'A user with this email already exists.', errors: { email: ['Email already in use'] } });
  }
  const user = await prisma.user.update({
    where: { id }, data: { name, email, phone: phone || null, role }, select: SELECT,
  });
  res.json({ user });
};

// ---------------- CSV export ----------------
const NUMERIC_LIKE = /^[+-]?[0-9][0-9\s().-]*$/;
function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Stop spreadsheets from running cells that start like formulas (but keep phone numbers like +91...).
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC_LIKE.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

exports.exportCsv = async (req, res) => {
  const users = await prisma.user.findMany({
    where: buildWhere(req.query), select: SELECT, orderBy: { createdAt: 'desc' }, take: MAX_EXPORT_ROWS,
  });
  const header = ['name', 'email', 'phone', 'role', 'verified', 'created_at'];
  const lines = [header.join(',')];
  for (const u of users) {
    lines.push([u.name, u.email, u.phone, u.role, u.isVerified ? 'yes' : 'no', u.createdAt.toISOString()].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n') + '\r\n'); // BOM so Excel reads UTF-8 names correctly
};

// ---------------- CSV import ----------------
const clean = (v) => String(v ?? '').trim().replace(/^'(?=[=+\-@])/, ''); // undo export's formula guard

exports.importCsv = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Choose a CSV file to import.' });

  let rows;
  try {
    rows = parse(req.file.buffer, {
      columns: (header) => header.map((h) => String(h).trim().toLowerCase()),
      skip_empty_lines: true, trim: true, bom: true, relax_column_count: true,
    });
  } catch {
    return res.status(400).json({ message: 'We couldn\'t read that file. Make sure it is a valid CSV.' });
  }
  if (!rows.length) return res.status(400).json({ message: 'The file has no rows to import.' });
  if (!('name' in rows[0]) || !('email' in rows[0])) {
    return res.status(400).json({ message: 'The CSV needs "name" and "email" columns. Download the template to see the format.' });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(400).json({ message: `Import up to ${MAX_IMPORT_ROWS} users at a time. This file has ${rows.length}.` });
  }

  const failed = [];
  const valid = [];
  const seen = new Set();
  rows.forEach((raw, i) => {
    const rowNumber = i + 2; // row 1 is the header
    const parsed = importRow.safeParse({
      name: clean(raw.name), email: clean(raw.email), phone: clean(raw.phone),
      role: (clean(raw.role) || 'USER').toUpperCase(), password: clean(raw.password),
    });
    if (!parsed.success) {
      return failed.push({ row: rowNumber, email: clean(raw.email), reason: parsed.error.issues[0].message });
    }
    if (seen.has(parsed.data.email)) {
      return failed.push({ row: rowNumber, email: parsed.data.email, reason: 'Duplicate email in this file' });
    }
    seen.add(parsed.data.email);
    valid.push({ row: rowNumber, ...parsed.data });
  });

  const existing = await prisma.user.findMany({
    where: { email: { in: valid.map((v) => v.email) } }, select: { email: true },
  });
  const existingSet = new Set(existing.map((e) => e.email));
  const skipped = valid.filter((v) => existingSet.has(v.email)).map((v) => ({ row: v.row, email: v.email }));
  const toCreate = valid.filter((v) => !existingSet.has(v.email));

  // Only rows that include a password need hashing (bcrypt is slow on purpose).
  const data = await Promise.all(
    toCreate.map(async (v) => ({
      name: v.name, email: v.email, phone: v.phone || null, role: v.role, isVerified: true,
      passwordHash: v.password ? await bcrypt.hash(v.password, 10) : null,
    }))
  );
  const result = data.length ? await prisma.user.createMany({ data, skipDuplicates: true }) : { count: 0 };

  res.json({ total: rows.length, created: result.count, skipped, failed });
};

// ---------------- PDF export ----------------
function localAvatar(profilePicture) {
  if (!profilePicture?.startsWith('/uploads/avatars/')) return null;
  const file = path.join(AVATAR_DIR, path.basename(profilePicture));
  // PDFKit can embed JPG and PNG, not WEBP.
  return /\.(jpe?g|png)$/i.test(file) && fs.existsSync(file) ? file : null;
}

exports.exportPdf = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: SELECT });
  if (!user) return res.status(404).json({ message: 'User not found.' });

  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Profile - ${user.name}` } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="profile-${slug(user.name)}.pdf"`);
  doc.pipe(res);

  // Header band
  doc.rect(0, 0, doc.page.width, 96).fill('#123530');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text('User profile', 50, 34);

  // Avatar (photo if we have one, initials otherwise)
  const imgPath = localAvatar(user.profilePicture);
  let drawn = false;
  if (imgPath) {
    try {
      doc.save();
      doc.circle(95, 175, 45).clip();
      doc.image(imgPath, 50, 130, { cover: [90, 90], align: 'center', valign: 'center' });
      doc.restore();
      drawn = true;
    } catch {
      doc.restore();
    }
  }
  if (!drawn) {
    const initials = user.name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    doc.circle(95, 175, 45).fill('#0f766e');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(30).text(initials, 50, 161, { width: 90, align: 'center' });
  }

  doc.fillColor('#14201f').font('Helvetica-Bold').fontSize(22).text(user.name, 160, 148, { width: 385 });
  doc.fillColor('#5d6c6a').font('Helvetica').fontSize(12)
    .text(user.role === 'ADMIN' ? 'Administrator' : 'Member', 160, 178, { width: 385 });

  // Detail rows
  const fmt = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const rows = [
    ['Full name', user.name],
    ['Email', user.email],
    ['Phone', user.phone || 'Not added'],
    ['Role', user.role === 'ADMIN' ? 'Administrator' : 'Member'],
    ['Email status', user.isVerified ? 'Verified' : 'Not verified'],
    ['Member since', fmt(user.createdAt)],
    ['Last updated', fmt(user.updatedAt)],
    ['User ID', user.id],
  ];
  let y = 262;
  for (const [label, value] of rows) {
    doc.fillColor('#5d6c6a').font('Helvetica').fontSize(10).text(label, 50, y + 3, { width: 120 });
    doc.fillColor('#14201f').font('Helvetica').fontSize(12).text(value, 180, y, { width: 365 });
    y += 34;
    doc.moveTo(50, y - 10).lineTo(545, y - 10).lineWidth(0.5).strokeColor('#d8dfdb').stroke();
  }

  doc.fillColor('#5d6c6a').fontSize(9).text(`Generated on ${fmt(new Date())}`, 50, doc.page.height - 80, { width: 495 });
  doc.end();
};

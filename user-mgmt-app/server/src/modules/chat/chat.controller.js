const fs = require('fs');
const path = require('path');
const prisma = require('../../config/db');
const { getIO, room } = require('../../realtime/socket');
const { notify } = require('../notifications/notifications.service');
const { CHAT_DIR } = require('../../middleware/upload');

const MAX_IMAGE = 5 * 1024 * 1024;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const pick = (u) => ({ id: u.id, name: u.name, profilePicture: u.profilePicture });
const memberKey = (conversationId, userId) => ({ conversationId_userId: { conversationId, userId } });

async function assertMember(conversationId, userId) {
  const member = await prisma.conversationMember.findUnique({ where: memberKey(conversationId, userId) });
  if (!member) throw httpError(404, 'Conversation not found.');
  return member;
}

// People you can start a chat with (the admin-only /api/users isn't available to regular users).
exports.searchUsers = async (req, res) => {
  const q = String(req.query.search || '').trim();
  const users = await prisma.user.findMany({
    where: {
      id: { not: req.userId },
      isVerified: true,
      ...(q && { name: { contains: q, mode: 'insensitive' } }),
    },
    select: { id: true, name: true, profilePicture: true },
    orderBy: { name: 'asc' },
    take: 20,
  });
  res.json({ data: users });
};

// Open (or create) the 1-to-1 conversation with another user.
exports.start = async (req, res) => {
  const otherId = req.body.userId;
  if (otherId === req.userId) throw httpError(400, "You can't chat with yourself.");
  const other = await prisma.user.findUnique({ where: { id: otherId } });
  if (!other || !other.isVerified) throw httpError(404, 'User not found.');

  const directKey = [req.userId, otherId].sort().join(':');
  const conversation = await prisma.conversation.upsert({
    where: { directKey },
    update: {},
    create: { directKey, members: { create: [{ userId: req.userId }, { userId: otherId }] } },
  });
  res.json({ conversation });
};

// Inbox: every conversation with the other person, last message and unread count.
exports.list = async (req, res) => {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId: req.userId },
    orderBy: { conversation: { updatedAt: 'desc' } },
    include: {
      conversation: {
        include: {
          members: { include: { user: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });

  const data = await Promise.all(
    memberships.map(async (m) => {
      const c = m.conversation;
      const other = c.members.find((x) => x.userId !== req.userId);
      const unread = await prisma.message.count({
        where: { conversationId: c.id, senderId: { not: req.userId }, createdAt: { gt: m.lastReadAt } },
      });
      return {
        id: c.id,
        other: pick(other.user),
        otherLastReadAt: other.lastReadAt,
        lastMessage: c.messages[0] || null,
        unread,
      };
    })
  );
  res.json({ data });
};

// History, newest page first. Pass ?before=<messageId> to get older messages.
exports.messages = async (req, res) => {
  const { id } = req.params;
  await assertMember(id, req.userId);

  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const rows = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(req.query.before && { cursor: { id: String(req.query.before) }, skip: 1 }),
  });
  res.json({ data: rows.slice(0, limit).reverse(), hasMore: rows.length > limit });
};

// Send text and/or one image/video. Multipart form: `content` (text) and `media` (file).
exports.send = async (req, res) => {
  const { id } = req.params;
  const file = req.file;
  const discard = () => file && fs.unlink(path.join(CHAT_DIR, file.filename), () => {});

  try {
    await assertMember(id, req.userId);

    const content = String(req.body.content || '').trim().slice(0, 4000);
    if (!content && !file) throw httpError(400, 'Write a message or attach a file.');
    if (file?.mimetype.startsWith('image/') && file.size > MAX_IMAGE) {
      throw httpError(400, 'Images must be 5 MB or smaller.');
    }

    const type = !file ? 'TEXT' : file.mimetype.startsWith('video/') ? 'VIDEO' : 'IMAGE';
    const message = await prisma.message.create({
      data: {
        conversationId: id,
        senderId: req.userId,
        type,
        content: content || null,
        mediaUrl: file ? `/uploads/chat/${file.filename}` : null,
        mediaMime: file ? file.mimetype : null,
      },
    });
    await prisma.conversation.update({ where: { id }, data: { updatedAt: new Date() } });

    // Deliver in realtime to both people (this also syncs the sender's other tabs).
    const members = await prisma.conversationMember.findMany({ where: { conversationId: id }, select: { userId: true } });
    const io = getIO();
    members.forEach((m) => io.to(room(m.userId)).emit('message:new', message));

    // Notify the recipient (in-app over the socket if online, FCM push if offline).
    const recipient = members.find((m) => m.userId !== req.userId);
    const sender = await prisma.user.findUnique({ where: { id: req.userId }, select: { name: true } });
    const preview = type === 'TEXT' ? content : type === 'IMAGE' ? '📷 Photo' : '🎥 Video';
    notify(recipient.userId, {
      type: 'chat_message',
      title: sender.name,
      body: preview.length > 120 ? `${preview.slice(0, 117)}...` : preview,
      data: { conversationId: id, url: `/chat/${id}` },
    }).catch((err) => console.error('[notify]', err.message));

    res.status(201).json({ message });
  } catch (err) {
    discard(); // don't leave orphaned uploads behind when the message was rejected
    throw err;
  }
};

// Mark the conversation as read; the other person sees "Seen".
exports.markRead = async (req, res) => {
  const { id } = req.params;
  await assertMember(id, req.userId);

  await prisma.conversationMember.update({ where: memberKey(id, req.userId), data: { lastReadAt: new Date() } });

  // Clear the bell entries for this chat too.
  await prisma.notification.updateMany({
    where: { userId: req.userId, type: 'chat_message', readAt: null, data: { path: ['conversationId'], equals: id } },
    data: { readAt: new Date() },
  });

  const io = getIO();
  const other = await prisma.conversationMember.findFirst({ where: { conversationId: id, userId: { not: req.userId } } });
  if (other) io.to(room(other.userId)).emit('message:read', { conversationId: id, userId: req.userId });
  io.to(room(req.userId)).emit('notification:sync');

  res.json({ ok: true });
};

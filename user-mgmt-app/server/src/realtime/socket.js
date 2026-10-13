const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const redis = require('../config/redis');
const prisma = require('../config/db');

let io = null;

// Every user joins a personal room, so one emit reaches all of their tabs and devices.
const room = (userId) => `user:${userId}`;

function getIO() {
  if (!io) throw new Error('Socket.IO has not been initialised');
  return io;
}

// Redis-backed: the adapter answers fetchSockets() across every server instance.
async function isOnline(userId) {
  const sockets = await getIO().in(room(userId)).fetchSockets();
  return sockets.length > 0;
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.CLIENT_URL, credentials: true },
  });

  // Redis pub/sub adapter: events emitted on one server reach sockets connected to any other.
  io.adapter(createAdapter(redis, redis.duplicate()));

  // Authenticate with the same httpOnly JWT cookie the REST API uses.
  io.use((socket, next) => {
    try {
      const { token } = cookie.parse(socket.handshake.headers.cookie || '');
      if (!token) throw new Error('no token');
      socket.userId = jwt.verify(token, env.JWT_SECRET).sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const uid = socket.userId;
    socket.join(room(uid));

    // Announce "online" only for the user's first connection (not every extra tab).
    const sockets = await io.in(room(uid)).fetchSockets();
    if (sockets.length === 1) io.emit('presence:update', { userId: uid, online: true });

    // Client asks which of these users are online right now.
    socket.on('presence:get', async (ids, cb) => {
      if (typeof cb !== 'function' || !Array.isArray(ids)) return;
      const result = {};
      for (const id of ids.slice(0, 100)) {
        if (typeof id === 'string') result[id] = await isOnline(id);
      }
      cb(result);
    });

    // Typing indicator: only relayed to the other member of a conversation you belong to.
    socket.on('typing', async ({ conversationId, isTyping } = {}) => {
      try {
        if (typeof conversationId !== 'string') return;
        const other = await prisma.conversationMember.findFirst({
          where: {
            conversationId,
            userId: { not: uid },
            conversation: { members: { some: { userId: uid } } },
          },
          select: { userId: true },
        });
        if (other) io.to(room(other.userId)).emit('typing', { conversationId, userId: uid, isTyping: !!isTyping });
      } catch (err) {
        console.error('[socket] typing', err.message);
      }
    });

    socket.on('disconnect', async () => {
      try {
        if (!(await isOnline(uid))) io.emit('presence:update', { userId: uid, online: false });
      } catch (err) {
        console.error('[socket] disconnect', err.message);
      }
    });
  });

  return io;
}

module.exports = { initSocket, getIO, isOnline, room };

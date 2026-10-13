const prisma = require('../../config/db');
const { messaging, enabled } = require('../../config/firebase');
const { getIO, isOnline, room } = require('../../realtime/socket');

// FCM error codes that mean "this token will never work again".
const DEAD_TOKEN_CODES = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

async function pushToUser(userId, n) {
  if (!enabled) return;
  const rows = await prisma.deviceToken.findMany({ where: { userId } });
  if (!rows.length) return;

  // Data-only message: the service worker builds the notification, so we control the click behaviour.
  const data = { title: n.title, body: n.body, notificationId: n.id };
  for (const [k, v] of Object.entries(n.data || {})) data[k] = String(v);

  const res = await messaging().sendEachForMulticast({
    tokens: rows.map((r) => r.token),
    data,
    android: { priority: 'high' },
    webpush: { headers: { Urgency: 'high' } },
  });

  const dead = res.responses.flatMap((r, i) =>
    !r.success && DEAD_TOKEN_CODES.includes(r.error?.code) ? [rows[i].token] : []
  );
  if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
}

/**
 * The one entry point for notifying a user, from anywhere in the app:
 *   await notify(userId, { type: 'role_changed', title: 'Role updated', body: 'You are now an admin.', data: { url: '/' } })
 *
 * 1. Saved to the database (powers the bell list and unread count).
 * 2. Sent over the socket if the user is online.
 * 3. Sent as an FCM push if the user has no open connection.
 */
exports.notify = async (userId, { type, title, body, data }) => {
  const n = await prisma.notification.create({ data: { userId, type, title, body, data } });

  getIO().to(room(userId)).emit('notification:new', n);

  if (!(await isOnline(userId))) {
    try {
      await pushToUser(userId, n);
    } catch (err) {
      console.error('[push]', err.message);
    }
  }
  return n;
};

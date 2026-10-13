/* Service worker for web push (Firebase Cloud Messaging).
 *
 * FCM delivers a standard Web Push event. The server sends data-only messages, so this worker
 * decides what to show and what happens on click, with no dependency on a Firebase SDK build.
 * Served from the site root so it controls the whole app.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { data: { body: event.data && event.data.text() } };
  }
  // FCM puts our fields in `data` (and in `notification` if a notification payload was sent).
  const d = Object.assign({}, payload.notification, payload.data);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // The app is open and visible: let the page show an in-app toast instead of an OS notification.
    if (windows.some((w) => w.visibilityState === 'visible')) {
      windows.forEach((w) => w.postMessage({ type: 'push', data: d }));
      return;
    }

    await self.registration.showNotification(d.title || 'New notification', {
      body: d.body || '',
      tag: d.conversationId ? `chat-${d.conversationId}` : d.notificationId, // newer messages replace older ones per chat
      renotify: true,
      data: { url: d.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'navigate', url }); // the app navigates client-side, no reload
    } else {
      await self.clients.openWindow(url);
    }
  })());
});

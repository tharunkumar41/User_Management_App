import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import api from './api/client';

const env = import.meta.env;

// Push is optional: without the VITE_FIREBASE_* values the "Enable notifications" button is simply hidden.
export const pushConfigured = Boolean(
  env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID &&
  env.VITE_FIREBASE_SENDER_ID && env.VITE_FIREBASE_APP_ID && env.VITE_FIREBASE_VAPID_KEY
);

let app;
const firebaseApp = () =>
  (app ??= initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    messagingSenderId: env.VITE_FIREBASE_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  }));

export async function pushSupported() {
  return pushConfigured && 'serviceWorker' in navigator && 'Notification' in window && (await isSupported());
}

// Asks for permission (call it from a click), registers the worker, and saves this browser's FCM token on the server.
export async function enablePush() {
  if (!(await pushSupported())) throw new Error('Push notifications are not supported in this browser.');
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notifications are blocked. Allow them in your browser settings to turn this on.');
  }
  await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(firebaseApp()), {
    vapidKey: env.VITE_FIREBASE_VAPID_KEY,
    serviceWorkerRegistration: registration,
  });
  if (!token) throw new Error('Could not get a push token. Please try again.');
  await api.post('/notifications/token', { token });
  localStorage.setItem('fcmToken', token);
  return token;
}

// Called on logout so a signed-out browser stops receiving the previous user's pushes.
export async function disablePush() {
  const token = localStorage.getItem('fcmToken');
  localStorage.removeItem('fcmToken');
  if (token) await api.delete('/notifications/token', { data: { token } }).catch(() => {});
}

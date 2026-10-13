const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const env = require('./env');

// Firebase is optional: without valid credentials the app still runs, it just never sends push notifications.
let enabled = false;

if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
  try {
    initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        // .env files store the key with literal "\n" sequences.
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    enabled = true;
    console.log('[firebase] push notifications enabled');
  } catch (err) {
    console.error(`[firebase] could not initialise (${err.message}). Check FIREBASE_PRIVATE_KEY: push notifications are disabled.`);
  }
} else {
  console.warn('[firebase] credentials not set: push notifications are disabled');
}

module.exports = { messaging: () => getMessaging(), enabled };

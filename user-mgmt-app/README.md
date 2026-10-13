# User Management App

React (Vite) + Node/Express + PostgreSQL + Prisma, with **realtime chat (Socket.IO + Redis)** and
**push notifications (Firebase Cloud Messaging)**.

## What's included
- **Phase 1:** register, login, logout (httpOnly JWT cookie), forgot/reset password, change password with emailed OTP, profile + photo, Gmail SMTP emails.
- **Phase 2:** captcha, Google sign-in, admin users list (pagination/search/export/import), add/edit user, profile PDF.
- **Realtime chat:** 1-to-1 conversations with text, images and videos, typing indicator, online/offline presence, unread badges, "Seen" receipts, history with "load earlier".
- **Notifications:** in-app bell + toasts in realtime, and web push (Firebase) when the user has no open tab.

## Setup

### 1. Infrastructure (PostgreSQL + Redis)
```bash
docker compose up -d        # starts Postgres on :5432 and Redis on :6379
```
Already have your own Postgres/Redis? Skip this and point `DATABASE_URL` / `REDIS_URL` at them.

### 2. Server
```bash
cd server
cp .env.example .env        # fill in JWT_SECRET, SMTP_USER, SMTP_PASS (Firebase is optional, see below)
npm install
npx prisma migrate dev      # applies all migrations, including add_chat_notifications
npm run dev                 # http://localhost:5000
```
Gmail SMTP: turn on 2-Step Verification, create an **App Password** (Google Account > Security > App passwords) and use it as `SMTP_PASS`.

### 3. Client
```bash
cd client
cp .env.example .env        # note: .env lives in client/, not client/src/
npm install
npm run dev                 # http://localhost:5173
```
Vite proxies `/api`, `/uploads` and `/socket.io` (WebSocket) to the server, so there's no CORS or cookie setup in dev.

### 4. Firebase push notifications (optional)
Chat and the in-app bell work without it. Add Firebase to also get push when the tab is closed.

1. [Firebase console](https://console.firebase.google.com) > **Add project**.
2. Project home > **`</>` Web app** > register (skip Hosting) > copy `apiKey`, `projectId`, `messagingSenderId`, `appId` into `client/.env` (`VITE_FIREBASE_*`).
3. Project settings > **Cloud Messaging** > *Web Push certificates* > **Generate key pair** > copy it to `VITE_FIREBASE_VAPID_KEY`.
4. Project settings > **Service accounts** > **Generate new private key**. From the downloaded JSON, copy `project_id`, `client_email`, `private_key` into `server/.env` as `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (keep the quotes and the literal `\n`). Never commit that file.
5. Restart both dev servers. Click the bell > **Enable**.

Web push needs HTTPS (localhost is exempt). On iOS it only works for sites added to the Home Screen.

## Try it
1. Register and verify two users. Sign in with one in a normal window and one in an **incognito** window (separate cookies).
2. **Chat > New chat**, pick the other person, send text, a photo and a video. They appear instantly on the other side.
3. Close the second window's tab (with push enabled) and send another message: an OS notification arrives. Click it to jump to the chat.

## How it works
- **Postgres is the source of truth** for conversations and messages. Redis is the realtime backbone: the Socket.IO Redis adapter fans events out across server instances, and presence ("online") is computed through it.
- **Auth:** the socket handshake carries the same httpOnly JWT cookie as the REST API (`server/src/realtime/socket.js`).
- **Sending:** text and media go through one multipart REST call, `POST /api/chat/conversations/:id/messages`. After saving, the server emits `message:new` to both users' personal socket rooms (so other tabs sync too).
- **Notifications:** `notify(userId, {...})` in `server/src/modules/notifications/notifications.service.js` saves a row (bell list), emits `notification:new` over the socket, and, if the user has no open connection, sends an FCM push. Call it from anywhere, e.g. after an admin changes someone's role.
- **Push worker:** `client/public/firebase-messaging-sw.js` shows the notification and focuses/navigates the app on click. It has no external dependencies.
- **Logout** removes this browser's push token so a signed-out device stops receiving that user's notifications.

## API (all under /api)
| Method | Path | Auth |
|---|---|---|
| POST | /auth/register, /auth/login, /auth/logout, /auth/google | no |
| GET | /auth/me | yes |
| POST | /auth/forgot-password, /auth/reset-password | no |
| POST | /auth/change-password/request-otp, /verify-otp, then /auth/change-password | yes |
| GET / PUT | /profile | yes |
| POST | /profile/picture (multipart field `picture`) | yes |
| GET / POST / PUT | /users (admin only: list, create, update, import, export, pdf) | admin |
| GET | /chat/users?search= | yes |
| GET / POST | /chat/conversations | yes |
| GET | /chat/conversations/:id/messages?before=&limit= | yes |
| POST | /chat/conversations/:id/messages (multipart: `content`, `media`) | yes |
| POST | /chat/conversations/:id/read | yes |
| GET | /notifications | yes |
| POST | /notifications/read | yes |
| POST / DELETE | /notifications/token | yes |

Socket events: `message:new`, `message:read`, `typing`, `presence:update`, `presence:get` (ack), `notification:new`, `notification:sync`.

## Limits
Images 5 MB (JPG, PNG, WEBP, GIF), videos 50 MB (MP4, WEBM, MOV), messages 4000 characters, 60 messages/minute per IP.

## Before going to production
- **Media storage:** chat uploads are saved on the server's disk (`server/uploads/chat`). Move them to S3/Cloudinary/etc. if you run more than one server or a platform with an ephemeral disk. File URLs are unguessable but public; use signed URLs if the content is sensitive.
- **Multiple server instances:** Redis already syncs events between them. Either enable sticky sessions on your load balancer or force `transports: ['websocket']` on both the Socket.IO server and client.
- **Set** `CLIENT_URL` to your real origin and serve everything over HTTPS (needed for push).
- Rotate the example Google client ID / reCAPTCHA keys in the `.env.example` files for your own.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| `ECONNREFUSED 6379` or `[redis]` errors | Redis isn't running (`docker compose up -d`, then `redis-cli ping`). |
| Socket keeps reconnecting / `unauthorized` | Not signed in, or the dev server wasn't restarted after the `vite.config.js` proxy change. |
| `[firebase] could not initialise` | `FIREBASE_PRIVATE_KEY` lost its quotes or `\n` sequences. |
| No "Enable" button in the bell | `VITE_FIREBASE_*` values missing, or the browser doesn't support push. |
| Push doesn't arrive | The user still has a tab open (they count as online and get the in-app event instead), notifications are blocked for the site, or the page isn't served over HTTPS. |

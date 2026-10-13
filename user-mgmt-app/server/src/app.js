const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const env = require('./config/env');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./modules/auth/auth.routes'));
app.use('/api/profile', require('./modules/profile/profile.routes'));
app.use('/api/users', require('./modules/users/users.routes'));
app.use('/api/chat', require('./modules/chat/chat.routes'));
app.use('/api/notifications', require('./modules/notifications/notifications.routes'));
app.use('/api/vision', require('./modules/vision/vision.routes'));
app.use('/api/mock', require('./modules/mock/mock.routes'));

app.use((req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler);

module.exports = app;

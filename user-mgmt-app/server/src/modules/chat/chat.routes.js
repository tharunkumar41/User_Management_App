const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { uploadChatMedia } = require('../../middleware/upload');
const s = require('./chat.schemas');
const c = require('./chat.controller');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Max 60 messages a minute per IP: plenty for people, a brake on scripts.
const sendLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { message: 'You are sending messages too fast. Slow down a little.' },
});

router.use(requireAuth);

router.get('/users', h(c.searchUsers));                     // anyone signed in can find people to chat with
router.get('/conversations', h(c.list));
router.post('/conversations', validate(s.start), h(c.start));
router.get('/conversations/:id/messages', h(c.messages));
router.post('/conversations/:id/messages', sendLimiter, uploadChatMedia, h(c.send));
router.post('/conversations/:id/read', h(c.markRead));

module.exports = router;

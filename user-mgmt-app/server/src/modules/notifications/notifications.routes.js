const router = require('express').Router();
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const s = require('./notifications.schemas');
const c = require('./notifications.controller');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAuth);

router.get('/', h(c.list));
router.post('/read', h(c.markAllRead));
router.post('/token', validate(s.token), h(c.saveToken));
router.delete('/token', validate(s.token), h(c.removeToken));

module.exports = router;

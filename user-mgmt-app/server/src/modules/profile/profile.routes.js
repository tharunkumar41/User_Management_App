const router = require('express').Router();
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { uploadAvatar } = require('../../middleware/upload');
const c = require('./profile.controller');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAuth);
router.get('/', h(c.get));
router.put('/', validate(c.updateSchema), h(c.update));
router.post('/picture', uploadAvatar, h(c.uploadPicture));

module.exports = router;

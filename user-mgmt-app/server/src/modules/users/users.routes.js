const router = require('express').Router();
const validate = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { uploadCsv } = require('../../middleware/upload');
const s = require('./users.schemas');
const c = require('./users.controller');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Everything here is admin-only.
router.use(requireAuth, requireRole('ADMIN'));

router.get('/', h(c.list));
router.get('/export', h(c.exportCsv));          // keep before '/:id'
router.post('/import', uploadCsv, h(c.importCsv));
router.post('/', validate(s.createSchema), h(c.create));
router.get('/:id/pdf', h(c.exportPdf));
router.get('/:id', h(c.getOne));
router.put('/:id', validate(s.updateSchema), h(c.update));

module.exports = router;

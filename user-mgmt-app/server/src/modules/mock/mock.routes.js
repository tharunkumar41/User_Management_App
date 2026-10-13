const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { uploadMockDoc } = require('../../middleware/upload');
const ctrl = require('./mock.controller');

const router = express.Router();
router.use(requireAuth);

// Sources (upload PYQ / textbook / answer key)
router.post('/sources', uploadMockDoc, ctrl.uploadSource);
router.post('/sources/paste', ctrl.pasteSource);
router.post('/sources/:id/reparse', ctrl.reparseSource);
router.get('/sources', ctrl.listSources);
router.get('/sources/:id/questions', ctrl.getSourceQuestions);
router.patch('/sources/:id', ctrl.updateSource);
router.delete('/sources/:id', ctrl.deleteSource);
router.patch('/questions/:id', ctrl.updateQuestion);

// Papers
router.post('/papers/generate', ctrl.generatePaper);
router.get('/papers', ctrl.listPapers);
router.get('/papers/:id', ctrl.getPaper);

// Attempts
router.post('/papers/:paperId/attempts', ctrl.startAttempt);
router.post('/attempts', ctrl.startAttempt); // body.paperId
router.post('/attempts/:id/answers', ctrl.saveAnswer);
router.post('/attempts/:id/submit', ctrl.submitAttempt);
router.get('/attempts', ctrl.listAttempts);
router.get('/attempts/:id', ctrl.getAttempt);

module.exports = router;

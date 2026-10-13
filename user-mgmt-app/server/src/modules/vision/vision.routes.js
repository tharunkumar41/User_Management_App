const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { uploadVisionImage, uploadVisionVideo, uploadVehicle, uploadVisionSearch } = require('../../middleware/upload');
const ctrl = require('./vision.controller');

const router = express.Router();

router.use(requireAuth);

router.post('/visiting-card', uploadVisionImage, ctrl.visitingCard);
router.post('/face-detection', uploadVisionSearch, ctrl.faceDetection);
router.post('/object-detection', uploadVisionSearch, ctrl.objectDetection);
router.post('/vehicle-identification', uploadVehicle, ctrl.vehicleIdentification);
router.get('/jobs/:id', ctrl.getJob);

module.exports = router;

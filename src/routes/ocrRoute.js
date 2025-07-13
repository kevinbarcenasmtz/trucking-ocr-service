// src/routes/ocrRoutes.js
const express = require('express');
const {
  createUploadSession,
  uploadChunk,
  startProcessing,
  getJobStatus,
  cancelJob,
} = require('../controllers/ocrController');

const router = express.Router();

// Upload endpoints
router.post('/upload', createUploadSession);
router.post('/chunk', uploadChunk);
router.post('/process', startProcessing);

// Status endpoints
router.get('/status/:jobId', getJobStatus);
router.delete('/job/:jobId', cancelJob);

module.exports = router;
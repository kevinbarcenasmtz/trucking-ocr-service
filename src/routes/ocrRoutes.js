// src/routes/ocrRoutes.js
const express = require('express');
const { ocrValidation } = require('../middleware/requestValidation');
const {
  createUploadSession,
  uploadChunk,
  startProcessing,
  getJobStatus,
  cancelJob,
} = require('../controllers/ocrController');

const router = express.Router();

/**
 * OCR Upload and Processing Routes
 */

// POST /api/ocr/upload - Create upload session for chunked upload
router.post('/upload', 
  ...ocrValidation.createUploadSession,
  createUploadSession
);

// POST /api/ocr/chunk - Upload file chunk
router.post('/chunk', 
  ...ocrValidation.uploadChunk,
  uploadChunk
);

// POST /api/ocr/process - Start OCR processing on uploaded file
router.post('/process', 
  ...ocrValidation.startProcessing,
  startProcessing
);

/**
 * OCR Status and Management Routes
 */

// GET /api/ocr/status/:jobId - Get OCR job status
router.get('/status/:jobId', 
  ...ocrValidation.getJobStatus,
  getJobStatus
);

// DELETE /api/ocr/job/:jobId - Cancel OCR job (optional)
router.delete('/job/:jobId', cancelJob);

/**
 * OCR Service Health and Info Routes
 */

// GET /api/ocr/health - OCR service health check
router.get('/health', (req, res) => {
  res.json({
    service: 'OCR',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    correlationId: req.correlationId,
    endpoints: [
      'POST /api/ocr/upload',
      'POST /api/ocr/chunk', 
      'POST /api/ocr/process',
      'GET /api/ocr/status/:jobId',
      'DELETE /api/ocr/job/:jobId',
    ],
  });
});

// GET /api/ocr/stats - OCR service statistics (optional, for monitoring)
router.get('/stats', async (req, res) => {
  try {
    const OCRService = require('../services/ocrService');
    const FileService = require('../services/fileService');
    
    const ocrStats = await OCRService.getStats();
    const fileStats = FileService.getStats();
    
    res.json({
      ocr: ocrStats,
      files: fileStats,
      timestamp: new Date().toISOString(),
      correlationId: req.correlationId,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get stats',
      correlationId: req.correlationId,
    });
  }
});

/**
 * Legacy/Compatibility Routes (Optional)
 */

// POST /api/ocr/base64 - Legacy base64 upload endpoint (for backward compatibility)
router.post('/base64', async (req, res) => {
  res.status(410).json({
    error: 'Legacy endpoint deprecated',
    message: 'Please use the new chunked upload workflow: /upload -> /chunk -> /process',
    migration: {
      oldFlow: 'POST /api/ocr/base64',
      newFlow: [
        '1. POST /api/ocr/upload (create session)',
        '2. POST /api/ocr/chunk (upload chunks)', 
        '3. POST /api/ocr/process (start processing)',
        '4. GET /api/ocr/status/:jobId (check status)',
      ],
    },
    correlationId: req.correlationId,
  });
});

module.exports = router;
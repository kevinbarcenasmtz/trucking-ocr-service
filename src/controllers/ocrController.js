// src/controllers/ocrController.js
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const asyncHandler = require('express-async-handler');
const path = require('path');
const fs = require('fs').promises;
const ocrService = require('../services/ocrService');
const fileService = require('../services/fileService');
const logger = require('../utils/logger');

// Configure multer for chunk uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'temp/');
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}-chunk`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB per chunk
  },
});

/**
 * Create upload session
 * POST /api/ocr/upload
 */
const createUploadSession = asyncHandler(async (req, res) => {
  const { filename, fileSize, chunkSize } = req.body;
  const correlationId = req.correlationId;
  const uploadId = uuidv4();

  // Validate input
  if (!filename || !fileSize) {
    res.status(400);
    throw new Error('Filename and fileSize are required');
  }

  // Calculate expected chunks
  const maxChunks = Math.ceil(fileSize / (chunkSize || 1048576)); // Default 1MB chunks

  logger.info({ 
    correlationId, 
    uploadId, 
    filename, 
    fileSize, 
    maxChunks,
    message: 'Creating upload session' 
  });

  // Create upload session
  await fileService.createUploadSession(uploadId, {
    correlationId,
    filename,
    fileSize,
    chunkSize: chunkSize || 1048576,
    maxChunks,
    receivedChunks: 0,
    status: 'uploading',
    createdAt: new Date().toISOString(),
  });

  res.json({
    uploadId,
    chunkSize: chunkSize || 1048576,
    maxChunks,
  });
});

/**
 * Upload file chunk
 * POST /api/ocr/chunk
 */
const uploadChunk = [
  upload.single('chunk'),
  asyncHandler(async (req, res) => {
    const { uploadId, chunkIndex, totalChunks } = req.body;
    const correlationId = req.correlationId;

    // Validate input
    if (!uploadId || chunkIndex === undefined || !totalChunks) {
      res.status(400);
      throw new Error('uploadId, chunkIndex, and totalChunks are required');
    }

    if (!req.file) {
      res.status(400);
      throw new Error('No chunk data received');
    }

    const chunkIndexNum = parseInt(chunkIndex);
    const totalChunksNum = parseInt(totalChunks);

    logger.info({
      correlationId,
      uploadId,
      chunkIndex: chunkIndexNum,
      totalChunks: totalChunksNum,
      chunkSize: req.file.size,
      message: 'Received chunk',
    });

    // Get upload session
    const session = await fileService.getUploadSession(uploadId);
    if (!session) {
      res.status(404);
      throw new Error('Upload session not found');
    }

    if (session.status !== 'uploading') {
      res.status(400);
      throw new Error(`Invalid session status: ${session.status}`);
    }

    // Store chunk with proper naming
    const chunkPath = path.join('temp', `${uploadId}-chunk-${chunkIndex}`);
    await fs.rename(req.file.path, chunkPath);
    
    // Update session with received chunk
    await fileService.addChunk(uploadId, {
      index: chunkIndexNum,
      path: chunkPath,
      size: req.file.size,
    });

    // Check if all chunks received
    const receivedChunks = await fileService.getChunkCount(uploadId);
    
    if (receivedChunks === totalChunksNum) {
      // All chunks received - combine them
      const combinedPath = await fileService.combineChunks(uploadId);
      
      // Update session status
      await fileService.updateUploadSession(uploadId, {
        status: 'completed',
        combinedPath,
        completedAt: new Date().toISOString(),
      });

      logger.info({
        correlationId,
        uploadId,
        message: 'All chunks received and combined',
      });
    }

    res.json({
      success: true,
      receivedChunks,
      totalChunks: totalChunksNum,
      complete: receivedChunks === totalChunksNum,
    });
  }),
];

/**
 * Start OCR processing
 * POST /api/ocr/process
 */
const startProcessing = asyncHandler(async (req, res) => {
  const { uploadId } = req.body;
  const correlationId = req.correlationId;

  if (!uploadId) {
    res.status(400);
    throw new Error('Upload ID is required');
  }

  // Get upload session
  const session = await fileService.getUploadSession(uploadId);
  if (!session) {
    res.status(404);
    throw new Error('Upload session not found');
  }

  if (session.status !== 'completed') {
    res.status(400);
    throw new Error(`Upload not complete. Status: ${session.status}`);
  }

  logger.info({ 
    correlationId, 
    uploadId, 
    message: 'Starting OCR processing' 
  });

  // Start OCR processing job
  const jobId = await ocrService.startProcessing(uploadId, correlationId);

  res.json({
    jobId,
    message: 'OCR processing started',
  });
});

/**
 * Get processing status
 * GET /api/ocr/status/:jobId
 */
const getJobStatus = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const correlationId = req.correlationId;
  
  if (!jobId) {
    res.status(400);
    throw new Error('Job ID is required');
  }

  const status = await ocrService.getJobStatus(jobId);
  
  if (!status) {
    res.status(404);
    throw new Error('Job not found');
  }

  logger.debug({
    correlationId,
    jobId,
    status: status.status,
    progress: status.progress,
    message: 'Status check',
  });

  res.json(status);
});

/**
 * Cancel OCR job
 * DELETE /api/ocr/job/:jobId
 */
const cancelJob = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const correlationId = req.correlationId;

  if (!jobId) {
    res.status(400);
    throw new Error('Job ID is required');
  }

  const result = await ocrService.cancelJob(jobId);

  logger.info({
    correlationId,
    jobId,
    message: 'Job cancellation requested',
  });

  res.json({
    success: true,
    message: 'Job cancelled',
    ...result,
  });
});

module.exports = {
  createUploadSession,
  uploadChunk,
  startProcessing,
  getJobStatus,
  cancelJob,
};
// src/services/ocrService.js (No Redis Version - Fixed)
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const fileService = require('./fileService');
const classificationService = require('./classificationService');
const logger = require('../utils/logger');

// In-memory job storage (replace with Redis later)
const jobStatuses = new Map();
let tesseractWorker = null;

class OCRService {
  /**
   * Initialize the service (no Redis required)
   */
  static async initialize() {
    try {
      // Initialize Tesseract worker
      tesseractWorker = await createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') {
            logger.debug({ 
              progress: m.progress,
              message: 'Tesseract progress' 
            });
          }
        }
      });

      logger.info({ message: 'OCR service initialized (in-memory mode)' });
    } catch (error) {
      logger.error({ 
        error: error.message, 
        message: 'Failed to initialize OCR service' 
      });
      throw error;
    }
  }

  /**
   * Start OCR processing (immediate processing, no queue)
   */
  static async startProcessing(uploadId, correlationId) {
    try {
      const session = await fileService.getUploadSession(uploadId);
      if (!session) {
        throw new Error('Upload session not found');
      }

      if (!session.combinedPath) {
        throw new Error('No combined file found for upload session');
      }

      const jobId = uuidv4();
      
      // Create initial job status
      const jobStatus = {
        jobId,
        uploadId,
        correlationId,
        status: 'pending',
        progress: 0,
        stage: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
      };

      jobStatuses.set(jobId, jobStatus);

      // Start processing immediately (no queue)
      setImmediate(() => {
        this.processImageJob({
          jobId,
          uploadId,
          correlationId,
          imagePath: session.combinedPath,
          filename: session.filename,
        });
      });

      logger.info({ 
        jobId, 
        uploadId, 
        correlationId,
        message: 'OCR job started' 
      });

      return jobId;
    } catch (error) {
      logger.error({ 
        uploadId, 
        correlationId,
        error: error.message, 
        message: 'Failed to start OCR processing' 
      });
      throw error;
    }
  }

  /**
   * Process image job (direct processing)
   */
  static async processImageJob({ jobId, uploadId, correlationId, imagePath, filename }) {
    logger.info({ 
      jobId, 
      uploadId, 
      correlationId,
      message: 'Starting OCR job processing' 
    });

    try {
      // Update job status
      await this.updateJobStatus(jobId, {
        status: 'active',
        startedAt: new Date().toISOString(),
      });

      // Step 1: Optimize image (0-20%)
      await this.updateJobStatus(jobId, {
        stage: 'optimizing',
        progress: 0.1,
      });

      const optimizedPath = await this.optimizeImageForOCR(imagePath, correlationId);
      
      await this.updateJobStatus(jobId, {
        progress: 0.2,
      });

      // Step 2: Extract text with OCR (20-70%)
      await this.updateJobStatus(jobId, {
        stage: 'extracting',
        progress: 0.3,
      });

      const extractedText = await this.extractTextFromImage(optimizedPath, correlationId, (progress) => {
        const ocrProgress = 0.3 + (progress * 0.4);
        this.updateJobStatus(jobId, { progress: ocrProgress });
      });

      await this.updateJobStatus(jobId, {
        progress: 0.7,
      });

      // Step 3: Classify receipt (70-90%)
      await this.updateJobStatus(jobId, {
        stage: 'classifying',
        progress: 0.75,
      });

      const classification = await classificationService.classifyReceipt(extractedText, correlationId);

      await this.updateJobStatus(jobId, {
        progress: 0.9,
      });

      // Step 4: Finalize (90-100%)
      const result = {
        extractedText,
        confidence: classification.confidence || 0.8,
        classification: classification.data,
        processedAt: new Date().toISOString(),
        filename,
      };

      await this.updateJobStatus(jobId, {
        status: 'completed',
        progress: 1.0,
        completedAt: new Date().toISOString(),
        result,
      });

      // Cleanup temporary files
      await this.cleanupFiles([imagePath, optimizedPath]);

      logger.info({ 
        jobId, 
        uploadId, 
        correlationId,
        confidence: result.confidence,
        message: 'OCR job completed successfully' 
      });

    } catch (error) {
      logger.error({ 
        jobId, 
        uploadId, 
        correlationId,
        error: error.message,
        message: 'OCR job failed' 
      });

      await this.updateJobStatus(jobId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: {
          code: this.getErrorCode(error),
          message: error.message,
        },
      });
    }
  }

  /**
   * Get job status
   */
  static async getJobStatus(jobId) {
    return jobStatuses.get(jobId) || null;
  }

  /**
   * Cancel job (in-memory version)
   */
  static async cancelJob(jobId) {
    try {
      const status = jobStatuses.get(jobId);
      if (!status) {
        throw new Error('Job not found');
      }

      if (status.status === 'completed' || status.status === 'failed') {
        throw new Error(`Cannot cancel ${status.status} job`);
      }

      // Update status (no Bull queue to cancel from)
      await this.updateJobStatus(jobId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        error: {
          code: 'CANCELLED',
          message: 'Job cancelled by user',
        },
      });

      logger.info({ jobId, message: 'Job cancelled' });

      return { cancelled: true };
    } catch (error) {
      logger.error({ 
        jobId, 
        error: error.message, 
        message: 'Failed to cancel job' 
      });
      throw error;
    }
  }

  /**
   * Optimize image for OCR processing
   */
  static async optimizeImageForOCR(imagePath, correlationId) {
    try {
      const outputPath = imagePath.replace(/\.[^.]+$/, '-ocr-optimized.jpg');

      await sharp(imagePath)
        .resize(2048, 2048, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .grayscale() // Convert to grayscale for better OCR
        .normalize() // Normalize contrast
        .sharpen({ sigma: 1 }) // Slight sharpening
        .jpeg({ 
          quality: 90,
          progressive: false 
        })
        .toFile(outputPath);

      logger.info({ 
        correlationId,
        inputPath: imagePath,
        outputPath,
        message: 'Image optimized for OCR' 
      });

      return outputPath;
    } catch (error) {
      logger.error({ 
        correlationId,
        imagePath,
        error: error.message, 
        message: 'Failed to optimize image for OCR' 
      });
      throw error;
    }
  }

  /**
   * Extract text from image using Tesseract
   */
  static async extractTextFromImage(imagePath, correlationId, onProgress) {
    try {
      if (!tesseractWorker) {
        throw new Error('Tesseract worker not initialized');
      }

      logger.info({ 
        correlationId,
        imagePath,
        message: 'Starting text extraction' 
      });

      // Configure Tesseract for receipt processing
      await tesseractWorker.setParameters({
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,!@#$%^&*()-_=+[]{}|;:,.<>?/~` ',
        tessedit_pageseg_mode: '6', // Assume uniform block of text
      });

      const { data: { text, confidence } } = await tesseractWorker.recognize(imagePath, {
        logger: (m) => {
          if (m.status === 'recognizing text' && onProgress) {
            onProgress(m.progress);
          }
        }
      });

      logger.info({ 
        correlationId,
        textLength: text.length,
        confidence,
        message: 'Text extraction completed' 
      });

      if (!text || text.trim().length === 0) {
        throw new Error('No text could be extracted from the image');
      }

      return text.trim();
    } catch (error) {
      logger.error({ 
        correlationId,
        imagePath,
        error: error.message, 
        message: 'Failed to extract text from image' 
      });
      throw error;
    }
  }

  /**
   * Update job status
   */
  static async updateJobStatus(jobId, updates) {
    const currentStatus = jobStatuses.get(jobId);
    if (currentStatus) {
      const updatedStatus = {
        ...currentStatus,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      jobStatuses.set(jobId, updatedStatus);
    }
  }

  /**
   * Get error code from error
   */
  static getErrorCode(error) {
    if (error.message.includes('No text could be extracted')) {
      return 'OCR_FAILED';
    }
    if (error.message.includes('Invalid file') || error.message.includes('Cannot read')) {
      return 'INVALID_FILE';
    }
    if (error.message.includes('timeout')) {
      return 'TIMEOUT';
    }
    return 'PROCESSING_ERROR';
  }

  /**
   * Cleanup temporary files
   */
  static async cleanupFiles(filePaths) {
    for (const filePath of filePaths) {
      try {
        await fs.unlink(filePath);
      } catch (err) {
        logger.warn({ 
          filePath, 
          error: err.message,
          message: 'Failed to cleanup file' 
        });
      }
    }
  }

  /**
   * Get service statistics (in-memory version)
   */
  static async getStats() {
    return {
      jobs: {
        total: jobStatuses.size,
        active: Array.from(jobStatuses.values()).filter(j => j.status === 'active').length,
        completed: Array.from(jobStatuses.values()).filter(j => j.status === 'completed').length,
        failed: Array.from(jobStatuses.values()).filter(j => j.status === 'failed').length,
        cancelled: Array.from(jobStatuses.values()).filter(j => j.status === 'cancelled').length,
      },
    };
  }

  /**
   * Shutdown service gracefully
   */
  static async shutdown() {
    logger.info({ message: 'Shutting down OCR service' });
    
    if (tesseractWorker) {
      await tesseractWorker.terminate();
    }
  }
}

module.exports = OCRService;
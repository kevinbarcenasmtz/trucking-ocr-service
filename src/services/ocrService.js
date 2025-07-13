// src/services/ocrService.js
const Queue = require('bull');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fileService = require('./fileService');
const classificationService = require('./classificationService');
const logger = require('../utils/logger');

// Create OCR processing queue
const ocrQueue = new Queue('OCR processing', {
  redis: {
    port: process.env.REDIS_PORT || 6379,
    host: process.env.REDIS_HOST || 'localhost',
    password: process.env.REDIS_PASSWORD,
  },
  defaultJobOptions: {
    removeOnComplete: 10, // Keep 10 completed jobs
    removeOnFail: 25,     // Keep 25 failed jobs
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});

// Job status storage (use Redis in production)
const jobStatuses = new Map();
let tesseractWorker = null;

class OCRService {
  /**
   * Initialize the service
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

      logger.info({ message: 'Tesseract worker initialized' });

      // Set up queue processing
      ocrQueue.process('processImage', 3, this.processImageJob.bind(this));

      // Set up queue event handlers
      this.setupQueueEventHandlers();

      logger.info({ message: 'OCR service initialized' });
    } catch (error) {
      logger.error({ 
        error: error.message, 
        message: 'Failed to initialize OCR service' 
      });
      throw error;
    }
  }

  /**
   * Start OCR processing job
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

      // Add job to queue
      const job = await ocrQueue.add('processImage', {
        jobId,
        uploadId,
        correlationId,
        imagePath: session.combinedPath,
        filename: session.filename,
      }, {
        jobId, // Use our jobId as Bull job ID
      });

      logger.info({ 
        jobId, 
        uploadId, 
        correlationId,
        message: 'OCR job queued' 
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
   * Process image job (Bull queue processor)
   */
  static async processImageJob(job) {
    const { jobId, uploadId, correlationId, imagePath, filename } = job.data;

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
        // Update progress during OCR
        const ocrProgress = 0.3 + (progress * 0.4); // 30% to 70%
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

      return result;
    } catch (error) {
      logger.error({ 
        jobId, 
        uploadId, 
        correlationId,
        error: error.message,
        stack: error.stack,
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

      throw error;
    }
  }

  /**
   * Get job status
   */
  static async getJobStatus(jobId) {
    const status = jobStatuses.get(jobId);
    if (!status) {
      return null;
    }

    // Also check Bull queue status for additional info
    try {
      const bullJob = await ocrQueue.getJob(jobId);
      if (bullJob) {
        // Merge Bull job info if available
        return {
          ...status,
          queuePosition: await bullJob.getPosition(),
          attempts: bullJob.attemptsMade,
          maxAttempts: bullJob.opts.attempts,
        };
      }
    } catch (err) {
      // Bull job might not exist, that's ok
    }

    return status;
  }

  /**
   * Cancel job
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

      // Cancel in Bull queue
      const bullJob = await ocrQueue.getJob(jobId);
      if (bullJob) {
        await bullJob.remove();
      }

      // Update status
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
   * Setup queue event handlers
   */
  static setupQueueEventHandlers() {
    ocrQueue.on('completed', (job, result) => {
      logger.info({ 
        jobId: job.id,
        processingTime: Date.now() - job.timestamp,
        message: 'Job completed' 
      });
    });

    ocrQueue.on('failed', (job, err) => {
      logger.error({ 
        jobId: job.id,
        error: err.message,
        attempts: job.attemptsMade,
        message: 'Job failed' 
      });
    });

    ocrQueue.on('stalled', (job) => {
      logger.warn({ 
        jobId: job.id,
        message: 'Job stalled' 
      });
    });
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
   * Get service statistics
   */
  static async getStats() {
    const waiting = await ocrQueue.getWaiting();
    const active = await ocrQueue.getActive();
    const completed = await ocrQueue.getCompleted();
    const failed = await ocrQueue.getFailed();

    return {
      queue: {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
      },
      jobs: {
        total: jobStatuses.size,
        active: Array.from(jobStatuses.values()).filter(j => j.status === 'active').length,
        completed: Array.from(jobStatuses.values()).filter(j => j.status === 'completed').length,
        failed: Array.from(jobStatuses.values()).filter(j => j.status === 'failed').length,
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
    
    await ocrQueue.close();
  }
}

module.exports = OCRService;
// src/__tests__/ocr.test.js
const request = require('supertest');
const app = require('../app');
const OCRService = require('../services/ocrService');
const FileService = require('../services/fileService');
const fs = require('fs').promises;
const path = require('path');

// Mock services
jest.mock('../services/ocrService');
jest.mock('../services/fileService');
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('OCR API Endpoints', () => {
  let mockUploadId;
  let mockJobId;
  let testImageBuffer;

  beforeAll(async () => {
    // Initialize test data
    mockUploadId = 'test-upload-123';
    mockJobId = 'test-job-456';
    
    // Create a small test image buffer (1x1 pixel JPEG)
    testImageBuffer = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
      0x00, 0xFF, 0xD9
    ]);

    // Ensure test directories exist
    await fs.mkdir('temp', { recursive: true });
    await fs.mkdir('uploads', { recursive: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default successful mocks
    FileService.createUploadSession.mockResolvedValue({
      uploadId: mockUploadId,
      status: 'uploading',
    });
    
    FileService.getUploadSession.mockResolvedValue({
      uploadId: mockUploadId,
      status: 'completed',
      combinedPath: '/tmp/test-combined.jpg',
      filename: 'test.jpg',
    });
    
    FileService.addChunk.mockResolvedValue();
    FileService.getChunkCount.mockResolvedValue(1);
    FileService.combineChunks.mockResolvedValue('/tmp/test-combined.jpg');
    FileService.updateUploadSession.mockResolvedValue();
    
    OCRService.startProcessing.mockResolvedValue(mockJobId);
    OCRService.getJobStatus.mockResolvedValue({
      jobId: mockJobId,
      status: 'completed',
      progress: 1.0,
      result: {
        extractedText: 'Test receipt text',
        classification: {
          date: '2024-01-15',
          type: 'Fuel',
          amount: '$45.99',
          vehicle: 'Truck-001',
          vendorName: 'Shell',
          location: 'Main St',
        },
        confidence: 0.95,
      },
    });
  });

  afterAll(async () => {
    // Fix deprecation warning - use fs.rm instead of fs.rmdir
    try {
      await fs.rm('temp', { recursive: true, force: true });
      await fs.rm('uploads', { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Health Check', () => {
    it('should return service health status', async () => {
      const response = await request(app)
        .get('/api/ocr/health')
        .expect(200);

      expect(response.body).toMatchObject({
        service: 'OCR',
        status: 'healthy',
        endpoints: expect.arrayContaining([
          'POST /api/ocr/upload',
          'POST /api/ocr/chunk',
          'POST /api/ocr/process',
          'GET /api/ocr/status/:jobId',
        ]),
      });

      expect(response.body.correlationId).toBeDefined();
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('POST /api/ocr/upload - Create Upload Session', () => {
    it('should create upload session with valid data', async () => {
      const uploadData = {
        filename: 'test-receipt.jpg',
        fileSize: 1024000, // 1MB
        chunkSize: 512000,  // 512KB
      };

      const response = await request(app)
        .post('/api/ocr/upload')
        .send(uploadData)
        .expect(200);

      expect(response.body).toMatchObject({
        uploadId: mockUploadId,
        chunkSize: 512000,
        maxChunks: expect.any(Number),
      });

      expect(FileService.createUploadSession).toHaveBeenCalledWith(
        mockUploadId,
        expect.objectContaining({
          filename: 'test-receipt.jpg',
          fileSize: 1024000,
          chunkSize: 512000,
        })
      );
    });

    it('should reject invalid filename', async () => {
      const uploadData = {
        filename: 'invalid-file.txt', // Not an image
        fileSize: 1024000,
      };

      const response = await request(app)
        .post('/api/ocr/upload')
        .send(uploadData)
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'filename',
            message: expect.stringContaining('valid image file'),
          }),
        ])
      );
    });

    it('should reject file too large', async () => {
      const uploadData = {
        filename: 'huge-file.jpg',
        fileSize: 100 * 1024 * 1024, // 100MB - too large
      };

      const response = await request(app)
        .post('/api/ocr/upload')
        .send(uploadData)
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should include correlation ID in response', async () => {
      const uploadData = {
        filename: 'test.jpg',
        fileSize: 1024000,
      };

      const response = await request(app)
        .post('/api/ocr/upload')
        .set('X-Correlation-ID', 'test-correlation-123')
        .send(uploadData)
        .expect(200);

      expect(response.headers['x-correlation-id']).toBe('test-correlation-123');
    });
  });

  describe('POST /api/ocr/chunk - Upload File Chunk', () => {
    it('should upload chunk successfully', async () => {
      const response = await request(app)
        .post('/api/ocr/chunk')
        .field('uploadId', mockUploadId)
        .field('chunkIndex', '0')
        .field('totalChunks', '1')
        .attach('chunk', testImageBuffer, 'test-chunk.jpg')
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        receivedChunks: 1,
        totalChunks: 1,
        complete: true,
      });

      expect(FileService.addChunk).toHaveBeenCalledWith(
        mockUploadId,
        expect.objectContaining({
          index: 0,
          path: expect.stringContaining(`${mockUploadId}-chunk-0`),
        })
      );
    });

    it('should handle multiple chunks', async () => {
      FileService.getChunkCount
        .mockResolvedValueOnce(1) // First chunk
        .mockResolvedValueOnce(2); // Second chunk

      // Upload first chunk
      await request(app)
        .post('/api/ocr/chunk')
        .field('uploadId', mockUploadId)
        .field('chunkIndex', '0')
        .field('totalChunks', '2')
        .attach('chunk', testImageBuffer, 'chunk-0.jpg')
        .expect(200);

      // Upload second chunk
      const response = await request(app)
        .post('/api/ocr/chunk')
        .field('uploadId', mockUploadId)
        .field('chunkIndex', '1')
        .field('totalChunks', '2')
        .attach('chunk', testImageBuffer, 'chunk-1.jpg')
        .expect(200);

      expect(response.body.complete).toBe(true);
      expect(FileService.combineChunks).toHaveBeenCalledWith(mockUploadId);
    });

    it('should reject missing upload ID', async () => {
      const response = await request(app)
        .post('/api/ocr/chunk')
        .field('chunkIndex', '0')
        .field('totalChunks', '1')
        .attach('chunk', testImageBuffer, 'test.jpg')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject upload for non-existent session', async () => {
      FileService.getUploadSession.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/ocr/chunk')
        .field('uploadId', 'non-existent-id')
        .field('chunkIndex', '0')
        .field('totalChunks', '1')
        .attach('chunk', testImageBuffer, 'test.jpg')
        .expect(404);

      expect(response.body.error).toMatch(/Upload session not found/);
    });
  });

  describe('POST /api/ocr/process - Start OCR Processing', () => {
    it('should start OCR processing successfully', async () => {
      const response = await request(app)
        .post('/api/ocr/process')
        .send({ uploadId: mockUploadId })
        .expect(200);

      expect(response.body).toMatchObject({
        jobId: mockJobId,
        message: 'OCR processing started',
      });

      expect(OCRService.startProcessing).toHaveBeenCalledWith(
        mockUploadId,
        expect.any(String) // correlation ID
      );
    });

    it('should reject processing for incomplete upload', async () => {
      FileService.getUploadSession.mockResolvedValue({
        uploadId: mockUploadId,
        status: 'uploading', // Not completed
      });

      const response = await request(app)
        .post('/api/ocr/process')
        .send({ uploadId: mockUploadId })
        .expect(400);

      expect(response.body.error).toMatch(/Upload not complete/);
    });

    it('should reject missing upload ID', async () => {
      const response = await request(app)
        .post('/api/ocr/process')
        .send({})
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/ocr/status/:jobId - Get Job Status', () => {
    it('should return job status for valid job ID', async () => {
      const response = await request(app)
        .get(`/api/ocr/status/${mockJobId}`)
        .expect(200);

      expect(response.body).toMatchObject({
        jobId: mockJobId,
        status: 'completed',
        progress: 1.0,
        result: expect.objectContaining({
          extractedText: 'Test receipt text',
          classification: expect.objectContaining({
            type: 'Fuel',
            amount: '$45.99',
          }),
        }),
      });

      expect(OCRService.getJobStatus).toHaveBeenCalledWith(mockJobId);
    });

    it('should return 404 for non-existent job', async () => {
      OCRService.getJobStatus.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/ocr/status/non-existent-job')
        .expect(404);

      expect(response.body.error).toMatch(/Job not found/);
    });

    it('should reject invalid job ID format', async () => {
      const response = await request(app)
        .get('/api/ocr/status/invalid-job-id')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /api/ocr/job/:jobId - Cancel Job', () => {
    it('should cancel job successfully', async () => {
      OCRService.cancelJob.mockResolvedValue({ cancelled: true });

      const response = await request(app)
        .delete(`/api/ocr/job/${mockJobId}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: 'Job cancelled',
        cancelled: true,
      });

      expect(OCRService.cancelJob).toHaveBeenCalledWith(mockJobId);
    });
  });

  describe('Rate Limiting', () => {
    it('should apply rate limiting to OCR endpoints', async () => {
      // Make requests up to the limit
      const promises = [];
      for (let i = 0; i < 11; i++) { // Limit is 10
        promises.push(
          request(app)
            .get('/api/ocr/health')
            .expect(i < 10 ? 200 : 429)
        );
      }

      const responses = await Promise.all(promises);
      const rateLimitedResponse = responses[10];

      if (rateLimitedResponse.status === 429) {
        expect(rateLimitedResponse.body.error.code).toBe('RATE_LIMITED');
        expect(rateLimitedResponse.headers['retry-after']).toBeDefined();
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle service errors gracefully', async () => {
      OCRService.startProcessing.mockRejectedValue(new Error('Service unavailable'));

      const response = await request(app)
        .post('/api/ocr/process')
        .send({ uploadId: mockUploadId })
        .expect(500);

      expect(response.body.error).toBeDefined();
      expect(response.body.error.correlationId).toBeDefined();
    });

    it('should return proper error format', async () => {
      const response = await request(app)
        .post('/api/ocr/upload')
        .send({ filename: 'invalid' }) // Missing required fields
        .expect(400);

      expect(response.body).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.any(String),
          retryable: false,
          timestamp: expect.any(String),
          correlationId: expect.any(String),
        },
      });
    });
  });

  describe('Full Workflow Integration', () => {
    it('should complete full OCR workflow', async () => {
      // Step 1: Create upload session
      const uploadResponse = await request(app)
        .post('/api/ocr/upload')
        .send({
          filename: 'receipt.jpg',
          fileSize: testImageBuffer.length,
        })
        .expect(200);

      const { uploadId } = uploadResponse.body;

      // Step 2: Upload chunk
      await request(app)
        .post('/api/ocr/chunk')
        .field('uploadId', uploadId)
        .field('chunkIndex', '0')
        .field('totalChunks', '1')
        .attach('chunk', testImageBuffer, 'receipt.jpg')
        .expect(200);

      // Step 3: Start processing
      const processResponse = await request(app)
        .post('/api/ocr/process')
        .send({ uploadId })
        .expect(200);

      const { jobId } = processResponse.body;

      // Step 4: Check status
      const statusResponse = await request(app)
        .get(`/api/ocr/status/${jobId}`)
        .expect(200);

      expect(statusResponse.body.status).toBe('completed');
      expect(statusResponse.body.result).toBeDefined();
    });
  });

  describe('Legacy Endpoint', () => {
    it('should return deprecation message for base64 endpoint', async () => {
      const response = await request(app)
        .post('/api/ocr/base64')
        .send({ image: 'data:image/jpeg;base64,test' })
        .expect(410);

      expect(response.body.error).toBe('Legacy endpoint deprecated');
      expect(response.body.migration).toBeDefined();
    });
  });
});
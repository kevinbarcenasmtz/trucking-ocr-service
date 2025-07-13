// src/config/index.js
const path = require('path');

const config = {
  // Environment
  environment: process.env.NODE_ENV || 'development',
  
  // Server configuration
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: process.env.HOST || 'localhost',
  },

  // CORS configuration
  cors: {
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
    credentials: true,
  },

  // OCR service configuration
  ocr: {
    tesseract: {
      language: process.env.TESSERACT_LANG || 'eng',
      workerCount: parseInt(process.env.TESSERACT_WORKERS) || 1,
    },
    processing: {
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024, // 50MB
      chunkSize: parseInt(process.env.CHUNK_SIZE) || 1024 * 1024, // 1MB
      timeout: parseInt(process.env.OCR_TIMEOUT) || 60000, // 60 seconds
    },
  },

  // AI Classification (Anthropic)
  ai: {
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-3-7-sonnet-20250219',
      maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS) || 1000,
    },
  },

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 60 * 1000, // 1 minute
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX) || 10,
  },

  // File storage paths
  storage: {
    tempDir: process.env.TEMP_DIR || path.join(process.cwd(), 'temp'),
    uploadsDir: process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'),
    logsDir: process.env.LOGS_DIR || path.join(process.cwd(), 'logs'),
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    maxFileSize: parseInt(process.env.LOG_MAX_SIZE) || 5 * 1024 * 1024, // 5MB
    maxFiles: parseInt(process.env.LOG_MAX_FILES) || 5,
  },
};

module.exports = config;
// src/app.js
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const { correlationIdMiddleware } = require('./middleware/correlationId');
const { errorHandler } = require('./middleware/errorHandler');
const { createRateLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID'],
}));

// Compression
app.use(compression());

// Request parsing - support large files for chunked uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Correlation ID middleware
app.use(correlationIdMiddleware);

// Request logging
app.use((req, res, next) => {
  logger.info({
    method: req.method,
    url: req.url,
    correlationId: req.correlationId,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });
  next();
});

// Rate limiting for OCR endpoints
app.use('/api/ocr', createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute for OCR
  message: {
    error: 'Too many OCR requests',
    retryAfter: 60,
    code: 'RATE_LIMITED'
  },
}));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    correlationId: req.correlationId,
  });
});

// Routes
app.use('/api/ocr', require('./routes/ocrRoutes'));

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    method: req.method,
    path: req.originalUrl,
    correlationId: req.correlationId,
  });
});

// Error handling (must be last)
app.use(errorHandler);

module.exports = app;
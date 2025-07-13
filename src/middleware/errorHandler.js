// src/middleware/errorHandler.js
const { logError, logSecurityEvent } = require('../utils/logger');

/**
 * Custom error class for application-specific errors
 */
class AppError extends Error {
  constructor(message, statusCode, code = null, isOperational = true, details = null) {
    super(message);
    
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;
    this.timestamp = new Date().toISOString();
    
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation error class
 */
class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR', true, details);
  }
}

/**
 * OCR processing error class
 */
class OCRError extends AppError {
  constructor(message, code = 'OCR_FAILED', details = null) {
    super(message, 422, code, true, details);
  }
}

/**
 * Rate limiting error class
 */
class RateLimitError extends AppError {
  constructor(message = 'Too many requests', retryAfter = 60) {
    super(message, 429, 'RATE_LIMITED', true, { retryAfter });
  }
}

/**
 * File processing error class
 */
class FileError extends AppError {
  constructor(message, code = 'FILE_ERROR') {
    super(message, 400, code, true);
  }
}

/**
 * Error code mappings to HTTP status codes and user messages
 */
const ERROR_MAPPINGS = {
  // Network errors
  NETWORK_ERROR: {
    statusCode: 503,
    userMessage: 'Connection error. Please check your internet and try again.',
    retryable: true,
  },
  TIMEOUT: {
    statusCode: 408,
    userMessage: 'Request timed out. Please try again.',
    retryable: true,
  },
  CANCELLED: {
    statusCode: 499,
    userMessage: 'Operation cancelled.',
    retryable: false,
  },

  // Validation errors
  VALIDATION_ERROR: {
    statusCode: 400,
    userMessage: 'Invalid data provided.',
    retryable: false,
  },
  FILE_TOO_LARGE: {
    statusCode: 413,
    userMessage: 'Image file is too large. Maximum size is 10MB.',
    retryable: false,
  },
  INVALID_FILE_TYPE: {
    statusCode: 400,
    userMessage: 'Invalid image format. Please use JPEG or PNG.',
    retryable: false,
  },

  // Processing errors
  OCR_FAILED: {
    statusCode: 422,
    userMessage: 'Failed to read receipt. Please try with a clearer image.',
    retryable: true,
  },
  CLASSIFICATION_FAILED: {
    statusCode: 422,
    userMessage: 'Failed to understand receipt content.',
    retryable: true,
  },
  OPTIMIZATION_FAILED: {
    statusCode: 422,
    userMessage: 'Failed to process image.',
    retryable: true,
  },
  IMAGE_QUALITY: {
    statusCode: 400,
    userMessage: 'Image quality issues detected. Please try with a clearer image.',
    retryable: false,
  },

  // Server errors
  RATE_LIMITED: {
    statusCode: 429,
    userMessage: 'Too many requests. Please wait a moment and try again.',
    retryable: true,
  },
  SERVER_ERROR: {
    statusCode: 500,
    userMessage: 'Server error. Please try again later.',
    retryable: true,
  },
  RESOURCE_NOT_FOUND: {
    statusCode: 404,
    userMessage: 'Resource not found.',
    retryable: false,
  },

  // Client errors
  UNKNOWN: {
    statusCode: 500,
    userMessage: 'An unexpected error occurred.',
    retryable: true,
  },
};

/**
 * Determine error type and code from error object
 */
function determineErrorInfo(error) {
  // Check if it's already a custom app error
  if (error instanceof AppError) {
    return {
      code: error.code,
      statusCode: error.statusCode,
      isOperational: error.isOperational,
      details: error.details,
    };
  }

  // Map common error types
  if (error.name === 'ValidationError' || error.name === 'CastError') {
    return { code: 'VALIDATION_ERROR', statusCode: 400, isOperational: true };
  }

  if (error.name === 'MulterError') {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return { code: 'FILE_TOO_LARGE', statusCode: 413, isOperational: true };
    }
    return { code: 'INVALID_FILE_TYPE', statusCode: 400, isOperational: true };
  }

  if (error.code === 'ENOENT' || error.code === 'ENOTFOUND') {
    return { code: 'RESOURCE_NOT_FOUND', statusCode: 404, isOperational: true };
  }

  if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
    return { code: 'TIMEOUT', statusCode: 408, isOperational: true };
  }

  if (error.message && error.message.includes('OCR')) {
    return { code: 'OCR_FAILED', statusCode: 422, isOperational: true };
  }

  if (error.message && error.message.includes('classification')) {
    return { code: 'CLASSIFICATION_FAILED', statusCode: 422, isOperational: true };
  }

  // Default to server error
  return { code: 'SERVER_ERROR', statusCode: 500, isOperational: false };
}

/**
 * Create error response object
 */
function createErrorResponse(error, req, isDevelopment = false) {
  const { code, statusCode, isOperational, details } = determineErrorInfo(error);
  const mapping = ERROR_MAPPINGS[code] || ERROR_MAPPINGS.UNKNOWN;

  const response = {
    error: {
      code,
      message: mapping.userMessage,
      retryable: mapping.retryable,
      timestamp: new Date().toISOString(),
    },
  };

  // Add correlation ID if available
  if (req && req.correlationId) {
    response.error.correlationId = req.correlationId;
  }

  // Add details in development or for operational errors
  if (isDevelopment || isOperational) {
    if (details) {
      response.error.details = details;
    }
    
    if (isDevelopment) {
      response.error.originalMessage = error.message;
      response.error.stack = error.stack;
    }
  }

  // Add retry after for rate limiting
  if (code === 'RATE_LIMITED' && error.details?.retryAfter) {
    response.error.retryAfter = error.details.retryAfter;
  }

  return { response, statusCode: statusCode || mapping.statusCode };
}

/**
 * Main error handler middleware
 */
function errorHandler(error, req, res, next) {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const { response, statusCode } = createErrorResponse(error, req, isDevelopment);

  // Log the error
  logError(error, req, {
    statusCode,
    errorCode: response.error.code,
    retryable: response.error.retryable,
  });

  // Security logging for suspicious errors
  if (statusCode === 400 && error.message.includes('<script>')) {
    logSecurityEvent('potential_xss_attempt', {
      errorMessage: error.message,
      errorCode: response.error.code,
    }, req);
  }

  // Set appropriate headers
  res.status(statusCode);
  
  if (response.error.retryAfter) {
    res.set('Retry-After', response.error.retryAfter);
  }

  // Ensure correlation ID is in response header
  if (req && req.correlationId) {
    res.set('X-Correlation-ID', req.correlationId);
  }

  res.json(response);
}

/**
 * 404 handler for undefined routes
 */
function notFoundHandler(req, res, next) {
  const error = new AppError(
    `Route ${req.method} ${req.originalUrl} not found`,
    404,
    'RESOURCE_NOT_FOUND'
  );
  
  next(error);
}

/**
 * Async error wrapper for route handlers
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Validation error handler for request validation middleware
 */
function handleValidationError(errors) {
  const details = errors.map(error => ({
    field: error.param || error.path,
    value: error.value,
    message: error.msg || error.message,
  }));

  return new ValidationError('Validation failed', details);
}

/**
 * OCR specific error handler
 */
function handleOCRError(stage, originalError) {
  let code = 'OCR_FAILED';
  let message = 'OCR processing failed';

  switch (stage) {
    case 'optimization':
      code = 'OPTIMIZATION_FAILED';
      message = 'Failed to optimize image for processing';
      break;
    case 'extraction':
      code = 'OCR_FAILED';
      message = 'Failed to extract text from image';
      break;
    case 'classification':
      code = 'CLASSIFICATION_FAILED';
      message = 'Failed to classify receipt data';
      break;
  }

  return new OCRError(message, code, {
    stage,
    originalError: originalError.message,
  });
}

/**
 * File upload error handler
 */
function handleFileError(multerError) {
  if (multerError.code === 'LIMIT_FILE_SIZE') {
    return new FileError('File too large', 'FILE_TOO_LARGE');
  }
  
  if (multerError.code === 'LIMIT_UNEXPECTED_FILE') {
    return new FileError('Unexpected file field', 'INVALID_FILE_TYPE');
  }

  return new FileError(multerError.message, 'FILE_ERROR');
}

/**
 * Global unhandled error handlers
 */
function setupGlobalErrorHandlers() {
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    logError(new Error(`Unhandled Rejection: ${reason}`), null, {
      type: 'unhandledRejection',
      promise: promise.toString(),
    });
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    logError(error, null, {
      type: 'uncaughtException',
    });
    
    // Gracefully shutdown
    process.exit(1);
  });
}

module.exports = {
  // Error classes
  AppError,
  ValidationError,
  OCRError,
  RateLimitError,
  FileError,
  
  // Main middleware
  errorHandler,
  notFoundHandler,
  
  // Utility functions
  asyncHandler,
  handleValidationError,
  handleOCRError,
  handleFileError,
  determineErrorInfo,
  createErrorResponse,
  
  // Setup function
  setupGlobalErrorHandlers,
  
  // Constants
  ERROR_MAPPINGS,
};
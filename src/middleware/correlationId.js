// src/middleware/correlationId.js
const { v4: uuidv4 } = require('uuid');
const { logSecurityEvent } = require('../utils/logger');

/**
 * Generate a correlation ID for request tracking
 */
function generateCorrelationId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `api-${timestamp}-${random}`;
}

/**
 * Validate correlation ID format
 */
function isValidCorrelationId(correlationId) {
  if (!correlationId || typeof correlationId !== 'string') {
    return false;
  }

  // Allow various formats:
  // - Frontend format: rn-device-timestamp-random
  // - Backend format: api-timestamp-random
  // - Custom format: any string 8-64 characters with allowed chars
  const validPattern = /^[a-zA-Z0-9\-_]{8,64}$/;
  return validPattern.test(correlationId);
}

/**
 * Extract correlation ID from request headers
 */
function extractCorrelationId(req) {
  // Check multiple possible header names
  const headerNames = [
    'x-correlation-id',
    'x-request-id', 
    'x-trace-id',
    'correlation-id',
    'request-id',
  ];

  for (const headerName of headerNames) {
    const value = req.get(headerName);
    if (value && isValidCorrelationId(value)) {
      return value;
    }
  }

  return null;
}

/**
 * Correlation ID middleware
 */
function correlationIdMiddleware(req, res, next) {
  let correlationId = extractCorrelationId(req);
  let source = 'header';

  // If no valid correlation ID in headers, generate one
  if (!correlationId) {
    correlationId = generateCorrelationId();
    source = 'generated';
  }

  // Add correlation ID to request object
  req.correlationId = correlationId;

  // Add correlation ID to response headers
  res.set('X-Correlation-ID', correlationId);

  // Log correlation ID info for debugging
  if (process.env.LOG_LEVEL === 'debug') {
    console.log(`Correlation ID: ${correlationId} (${source})`);
  }

  // Security check: log if correlation ID looks suspicious
  if (correlationId.length > 64 || /[<>'"&]/.test(correlationId)) {
    logSecurityEvent('suspicious_correlation_id', {
      correlationId,
      source,
      reason: 'Invalid characters or excessive length',
    }, req);
  }

  next();
}

/**
 * Enhanced correlation middleware with additional features
 */
function enhancedCorrelationMiddleware(options = {}) {
  const {
    headerName = 'X-Correlation-ID',
    responseHeaderName = 'X-Correlation-ID',
    generateIfMissing = true,
    validateFormat = true,
    logInvalidIds = true,
  } = options;

  return (req, res, next) => {
    let correlationId = req.get(headerName);
    let isValid = true;
    let source = 'header';

    // Validate format if requested
    if (correlationId && validateFormat) {
      isValid = isValidCorrelationId(correlationId);
      
      if (!isValid && logInvalidIds) {
        logSecurityEvent('invalid_correlation_id_format', {
          provided: correlationId,
          headerName,
        }, req);
      }
    }

    // Generate new ID if missing or invalid
    if (!correlationId || (validateFormat && !isValid)) {
      if (generateIfMissing) {
        correlationId = generateCorrelationId();
        source = correlationId ? 'fallback' : 'generated';
      } else {
        // Don't generate, leave undefined
        correlationId = undefined;
      }
    }

    // Set on request object
    req.correlationId = correlationId;

    // Set response header if we have a valid ID
    if (correlationId && responseHeaderName) {
      res.set(responseHeaderName, correlationId);
    }

    // Add helper methods to request
    req.getCorrelationId = () => correlationId;
    req.setCorrelationId = (newId) => {
      if (isValidCorrelationId(newId)) {
        req.correlationId = newId;
        if (responseHeaderName) {
          res.set(responseHeaderName, newId);
        }
        return true;
      }
      return false;
    };

    next();
  };
}

/**
 * Middleware to propagate correlation ID to outgoing requests
 */
function propagateCorrelationId(req, options = {}) {
  const correlationId = req.correlationId;
  
  if (!correlationId) {
    return {};
  }

  const headerName = options.headerName || 'X-Correlation-ID';
  
  return {
    headers: {
      [headerName]: correlationId,
      ...options.additionalHeaders,
    },
  };
}

/**
 * Express middleware to add correlation context to all responses
 */
function correlationResponseMiddleware(req, res, next) {
  const originalJson = res.json;
  const originalSend = res.send;

  // Override json() to include correlation ID
  res.json = function(obj) {
    if (req.correlationId && obj && typeof obj === 'object') {
      // Only add to error responses or if explicitly requested
      if (res.statusCode >= 400 || req.query.includeCorrelationId === 'true') {
        obj.correlationId = req.correlationId;
      }
    }
    return originalJson.call(this, obj);
  };

  // Override send() for non-JSON responses
  res.send = function(body) {
    // Add correlation ID header for all responses
    if (req.correlationId) {
      this.set('X-Correlation-ID', req.correlationId);
    }
    return originalSend.call(this, body);
  };

  next();
}

/**
 * Create a child logger with correlation ID
 */
function createCorrelatedLogger(req, baseLogger) {
  const correlationId = req.correlationId;
  
  return {
    debug: (message, meta = {}) => baseLogger.debug(message, { correlationId, ...meta }),
    info: (message, meta = {}) => baseLogger.info(message, { correlationId, ...meta }),
    warn: (message, meta = {}) => baseLogger.warn(message, { correlationId, ...meta }),
    error: (message, meta = {}) => baseLogger.error(message, { correlationId, ...meta }),
  };
}

/**
 * Correlation ID utilities for services
 */
const correlationUtils = {
  /**
   * Generate new correlation ID
   */
  generate: generateCorrelationId,

  /**
   * Validate correlation ID
   */
  validate: isValidCorrelationId,

  /**
   * Extract from various sources
   */
  extract: extractCorrelationId,

  /**
   * Create headers for outgoing requests
   */
  createHeaders: (correlationId, additionalHeaders = {}) => ({
    'X-Correlation-ID': correlationId,
    ...additionalHeaders,
  }),

  /**
   * Get correlation ID from Express request
   */
  fromRequest: (req) => req.correlationId,

  /**
   * Create correlation context for service calls
   */
  createContext: (correlationId, metadata = {}) => ({
    correlationId,
    timestamp: new Date().toISOString(),
    ...metadata,
  }),
};

module.exports = {
  // Main middleware (simple version)
  correlationIdMiddleware,
  
  // Enhanced middleware with options
  enhancedCorrelationMiddleware,
  
  // Response middleware
  correlationResponseMiddleware,
  
  // Utility functions
  generateCorrelationId,
  isValidCorrelationId,
  extractCorrelationId,
  propagateCorrelationId,
  createCorrelatedLogger,
  
  // Utils object
  correlationUtils,
};
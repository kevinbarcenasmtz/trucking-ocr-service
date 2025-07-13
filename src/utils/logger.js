// src/utils/logger.js
const winston = require('winston');

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, correlationId, ...meta }) => {
    const logEntry = {
      timestamp,
      level,
      message,
      ...(correlationId && { correlationId }),
      ...meta
    };
    
    return JSON.stringify(logEntry);
  })
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.printf(({ timestamp, level, message, correlationId, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    const corrId = correlationId ? `[${correlationId.slice(-8)}]` : '';
    
    return `${timestamp} ${level} ${corrId} ${message} ${metaStr}`;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: {
    service: 'trucking-ocr-backend',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  },
  transports: [
    // File transport for all logs
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: 'logs/rejections.log' })
  ]
});

// Add console transport for development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    level: 'debug'
  }));
}

// Helper methods for structured logging
const createStructuredLogger = (baseFields = {}) => {
  return {
    debug: (message, meta = {}) => logger.debug(message, { ...baseFields, ...meta }),
    info: (message, meta = {}) => logger.info(message, { ...baseFields, ...meta }),
    warn: (message, meta = {}) => logger.warn(message, { ...baseFields, ...meta }),
    error: (message, meta = {}) => logger.error(message, { ...baseFields, ...meta }),
  };
};

// Request logger helper
const logRequest = (req, res, next) => {
  const start = Date.now();
  
  // Log request start
  logger.info('Request started', {
    correlationId: req.correlationId,
    method: req.method,
    url: req.originalUrl,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    contentLength: req.get('Content-Length'),
  });

  // Override res.end to log response
  const originalEnd = res.end;
  res.end = function(chunk, encoding) {
    const duration = Date.now() - start;
    
    logger.info('Request completed', {
      correlationId: req.correlationId,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      contentLength: res.get('Content-Length'),
    });
    
    originalEnd.call(res, chunk, encoding);
  };

  next();
};

// Error logger helper
const logError = (error, req = null, additionalContext = {}) => {
  const errorLog = {
    message: error.message,
    stack: error.stack,
    name: error.name,
    ...additionalContext,
  };

  if (req) {
    errorLog.correlationId = req.correlationId;
    errorLog.method = req.method;
    errorLog.url = req.originalUrl;
    errorLog.userAgent = req.get('User-Agent');
    errorLog.ip = req.ip;
  }

  logger.error('Application error', errorLog);
};

// Performance logger
const logPerformance = (operation, duration, correlationId, metadata = {}) => {
  logger.info('Performance metric', {
    operation,
    duration: `${duration}ms`,
    correlationId,
    ...metadata,
  });
};

// Security logger
const logSecurityEvent = (event, details, req = null) => {
  const securityLog = {
    securityEvent: event,
    ...details,
    timestamp: new Date().toISOString(),
  };

  if (req) {
    securityLog.correlationId = req.correlationId;
    securityLog.ip = req.ip;
    securityLog.userAgent = req.get('User-Agent');
    securityLog.method = req.method;
    securityLog.url = req.originalUrl;
  }

  logger.warn('Security event', securityLog);
};

// Health check logger
const logHealthCheck = (status, details = {}) => {
  logger.info('Health check', {
    healthStatus: status,
    ...details,
    timestamp: new Date().toISOString(),
  });
};

// OCR specific loggers
const ocrLogger = {
  jobStarted: (jobId, correlationId, metadata = {}) => {
    logger.info('OCR job started', {
      jobId,
      correlationId,
      stage: 'started',
      ...metadata,
    });
  },

  jobProgress: (jobId, stage, progress, correlationId, metadata = {}) => {
    logger.debug('OCR job progress', {
      jobId,
      correlationId,
      stage,
      progress: `${Math.round(progress * 100)}%`,
      ...metadata,
    });
  },

  jobCompleted: (jobId, correlationId, duration, result = {}) => {
    logger.info('OCR job completed', {
      jobId,
      correlationId,
      stage: 'completed',
      duration: `${duration}ms`,
      confidence: result.confidence,
      textLength: result.extractedText?.length,
    });
  },

  jobFailed: (jobId, correlationId, error, metadata = {}) => {
    logger.error('OCR job failed', {
      jobId,
      correlationId,
      stage: 'failed',
      error: error.message,
      errorCode: error.code,
      stack: error.stack,
      ...metadata,
    });
  },
};

// Export the logger and helpers
module.exports = {
  // Main logger instance
  logger,
  
  // Helper functions
  createStructuredLogger,
  logRequest,
  logError,
  logPerformance,
  logSecurityEvent,
  logHealthCheck,
  
  // Specialized loggers
  ocrLogger,
  
  // Log levels for external use
  levels: {
    ERROR: 'error',
    WARN: 'warn', 
    INFO: 'info',
    DEBUG: 'debug',
  },
};
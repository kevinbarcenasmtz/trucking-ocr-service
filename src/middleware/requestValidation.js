// src/middleware/requestValidation.js
const Joi = require('joi');
const { handleValidationError } = require('./errorHandler');

/**
 * Common validation schemas
 */
const commonSchemas = {
  // Correlation ID validation
  correlationId: Joi.string()
    .pattern(/^[a-zA-Z0-9\-_]{8,64}$/)
    .messages({
      'string.pattern.base': 'Correlation ID must contain only letters, numbers, hyphens, and underscores (8-64 characters)',
    }),

  // UUID validation
  uuid: Joi.string()
    .uuid({ version: 'uuidv4' })
    .messages({
      'string.guid': 'Must be a valid UUID',
    }),

  // File size validation (in bytes)
  fileSize: Joi.number()
    .integer()
    .min(1024) // 1KB minimum
    .max(50 * 1024 * 1024) // 50MB maximum
    .messages({
      'number.min': 'File size must be at least 1KB',
      'number.max': 'File size must not exceed 50MB',
    }),

  // Chunk size validation
  chunkSize: Joi.number()
    .integer()
    .min(64 * 1024) // 64KB minimum
    .max(5 * 1024 * 1024) // 5MB maximum
    .default(1048576) // 1MB default
    .messages({
      'number.min': 'Chunk size must be at least 64KB',
      'number.max': 'Chunk size must not exceed 5MB',
    }),

  // Filename validation
  filename: Joi.string()
    .pattern(/^[a-zA-Z0-9\-_\.\s]+\.(jpg|jpeg|png)$/i)
    .max(255)
    .messages({
      'string.pattern.base': 'Filename must be a valid image file (jpg, jpeg, png)',
      'string.max': 'Filename must not exceed 255 characters',
    }),

  // Chunk index validation
  chunkIndex: Joi.number()
    .integer()
    .min(0)
    .max(9999)
    .messages({
      'number.min': 'Chunk index must be 0 or greater',
      'number.max': 'Chunk index must not exceed 9999',
    }),

  // Total chunks validation
  totalChunks: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .messages({
      'number.min': 'Total chunks must be at least 1',
      'number.max': 'Total chunks must not exceed 10000',
    }),
};

/**
 * OCR endpoint validation schemas
 */
const ocrSchemas = {
  // POST /api/ocr/upload
  createUploadSession: Joi.object({
    filename: commonSchemas.filename.required(),
    fileSize: commonSchemas.fileSize.required(),
    chunkSize: commonSchemas.chunkSize.optional(),
  }).messages({
    'any.required': '{#label} is required',
  }),

  // POST /api/ocr/chunk
  uploadChunk: Joi.object({
    uploadId: commonSchemas.uuid.required(),
    chunkIndex: commonSchemas.chunkIndex.required(),
    totalChunks: commonSchemas.totalChunks.required(),
  }).messages({
    'any.required': '{#label} is required',
  }),

  // POST /api/ocr/process
  startProcessing: Joi.object({
    uploadId: commonSchemas.uuid.required(),
  }).messages({
    'any.required': '{#label} is required',
  }),

  // GET /api/ocr/status/:jobId
  getJobStatus: Joi.object({
    jobId: commonSchemas.uuid.required(),
  }).messages({
    'any.required': '{#label} is required',
  }),
};

/**
 * File validation schema for multer uploads
 */
const fileValidation = {
  // Image file validation
  imageFile: {
    allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png'],
    maxSize: 10 * 1024 * 1024, // 10MB
    validate: (file) => {
      const errors = [];

      if (!file) {
        errors.push('File is required');
        return errors;
      }

      // Check file type
      if (!fileValidation.imageFile.allowedMimeTypes.includes(file.mimetype)) {
        errors.push(`Invalid file type. Allowed types: ${fileValidation.imageFile.allowedMimeTypes.join(', ')}`);
      }

      // Check file size
      if (file.size > fileValidation.imageFile.maxSize) {
        errors.push(`File too large. Maximum size: ${fileValidation.imageFile.maxSize / (1024 * 1024)}MB`);
      }

      // Check file buffer/content
      if (file.size === 0) {
        errors.push('File appears to be empty');
      }

      return errors;
    },
  },
};

/**
 * Create validation middleware
 */
function createValidator(schema, source = 'body') {
  return (req, res, next) => {
    let dataToValidate;

    switch (source) {
      case 'body':
        dataToValidate = req.body;
        break;
      case 'params':
        dataToValidate = req.params;
        break;
      case 'query':
        dataToValidate = req.query;
        break;
      case 'headers':
        dataToValidate = req.headers;
        break;
      default:
        dataToValidate = req.body;
    }

    const { error, value } = schema.validate(dataToValidate, {
      abortEarly: false, // Collect all errors
      stripUnknown: true, // Remove unknown fields
      convert: true, // Convert types (string to number, etc.)
    });

    if (error) {
      const validationError = handleValidationError(error.details);
      return next(validationError);
    }

    // Replace the validated data (with type conversion and unknown fields stripped)
    switch (source) {
      case 'body':
        req.body = value;
        break;
      case 'params':
        req.params = value;
        break;
      case 'query':
        req.query = value;
        break;
    }

    next();
  };
}

/**
 * File validation middleware
 */
function validateFile(fileField = 'file', validationType = 'imageFile') {
  return (req, res, next) => {
    const file = req.file || req.files?.[fileField];
    const validator = fileValidation[validationType];

    if (!validator) {
      return next(new Error(`Unknown file validation type: ${validationType}`));
    }

    const errors = validator.validate(file);

    if (errors.length > 0) {
      const validationError = handleValidationError(
        errors.map(msg => ({ msg, param: fileField, value: file?.originalname }))
      );
      return next(validationError);
    }

    next();
  };
}

/**
 * Composite validation for chunk upload (body + file)
 */
function validateChunkUpload(req, res, next) {
  // First validate the body
  const bodyValidator = createValidator(ocrSchemas.uploadChunk, 'body');
  
  bodyValidator(req, res, (bodyError) => {
    if (bodyError) {
      return next(bodyError);
    }

    // Then validate the file
    const fileValidator = validateFile('chunk', 'imageFile');
    fileValidator(req, res, next);
  });
}

/**
 * Header validation middleware
 */
function validateHeaders(requiredHeaders = []) {
  const schema = Joi.object(
    requiredHeaders.reduce((acc, header) => {
      acc[header.toLowerCase()] = Joi.string().required();
      return acc;
    }, {})
  ).unknown(true);

  return createValidator(schema, 'headers');
}

/**
 * Content-Type validation middleware
 */
function validateContentType(allowedTypes = ['application/json']) {
  return (req, res, next) => {
    const contentType = req.get('Content-Type');
    
    // Skip for GET requests or requests without body
    if (req.method === 'GET' || !contentType) {
      return next();
    }

    const isAllowed = allowedTypes.some(type => 
      contentType.toLowerCase().includes(type.toLowerCase())
    );

    if (!isAllowed) {
      const validationError = handleValidationError([{
        msg: `Invalid Content-Type. Allowed types: ${allowedTypes.join(', ')}`,
        param: 'content-type',
        value: contentType,
      }]);
      return next(validationError);
    }

    next();
  };
}

/**
 * Sanitization middleware
 */
function sanitizeInput(fields = []) {
  return (req, res, next) => {
    fields.forEach(field => {
      const value = req.body[field];
      if (typeof value === 'string') {
        // Basic sanitization: remove potentially dangerous characters
        req.body[field] = value
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
          .replace(/[<>'"&]/g, '') // Remove HTML chars
          .trim();
      }
    });
    next();
  };
}

/**
 * Rate limit validation (check if request should be rate limited)
 */
function validateRateLimit(req, res, next) {
  // Add rate limit context to request
  req.rateLimitContext = {
    endpoint: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    correlationId: req.correlationId,
  };
  
  next();
}

/**
 * OCR-specific validation middlewares
 */
const ocrValidation = {
  createUploadSession: [
    validateContentType(['application/json']),
    createValidator(ocrSchemas.createUploadSession, 'body'),
    sanitizeInput(['filename']),
  ],

  uploadChunk: [
    validateContentType(['multipart/form-data']),
    validateChunkUpload,
  ],

  startProcessing: [
    validateContentType(['application/json']),
    createValidator(ocrSchemas.startProcessing, 'body'),
  ],

  getJobStatus: [
    createValidator(ocrSchemas.getJobStatus, 'params'),
  ],
};

/**
 * Generic request validation middleware
 */
function requestValidation(req, res, next) {
  // Add validation context to request
  req.validationContext = {
    endpoint: req.originalUrl,
    method: req.method,
    contentType: req.get('Content-Type'),
    contentLength: req.get('Content-Length'),
  };

  next();
}

module.exports = {
  // Main validation factory
  createValidator,
  
  // File validation
  validateFile,
  validateChunkUpload,
  
  // Header and content validation
  validateHeaders,
  validateContentType,
  
  // Utility middleware
  sanitizeInput,
  validateRateLimit,
  requestValidation,
  
  // OCR-specific validators
  ocrValidation,
  
  // Schemas for external use
  ocrSchemas,
  commonSchemas,
  fileValidation,
};
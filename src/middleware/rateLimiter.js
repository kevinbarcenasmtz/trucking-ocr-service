// src/middleware/rateLimiter.js
const { RateLimitError, AppError } = require('./errorHandler');
const { logSecurityEvent } = require('../utils/logger');

// In-memory store (replace with Redis in production)
class MemoryStore {
  constructor() {
    this.clients = new Map();
    this.resetTime = new Map();
  }

  async get(key) {
    return this.clients.get(key) || { count: 0, resetTime: Date.now() + 60000 };
  }

  async set(key, value, ttl) {
    this.clients.set(key, value);
    this.resetTime.set(key, Date.now() + ttl);
    return true;
  }

  async increment(key, ttl = 60000) {
    const now = Date.now();
    const existing = this.clients.get(key);
    const resetTime = this.resetTime.get(key);

    // Reset if expired
    if (!existing || !resetTime || now > resetTime) {
      const newValue = { count: 1, resetTime: now + ttl };
      this.clients.set(key, newValue);
      this.resetTime.set(key, now + ttl);
      return newValue;
    }

    // Increment existing
    existing.count += 1;
    this.clients.set(key, existing);
    return existing;
  }

  async cleanup() {
    const now = Date.now();
    for (const [key, resetTime] of this.resetTime.entries()) {
      if (now > resetTime) {
        this.clients.delete(key);
        this.resetTime.delete(key);
      }
    }
  }
}

// Global memory store instance
const memoryStore = new MemoryStore();

// Cleanup expired entries every 5 minutes
setInterval(() => {
  memoryStore.cleanup();
}, 5 * 60 * 1000);

/**
 * Create rate limiter middleware
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60 * 1000, // 1 minute
    max = 10, // 10 requests per window
    message = 'Too many requests, please try again later',
    standardHeaders = true, // Include rate limit headers
    legacyHeaders = false, // Include X-RateLimit-* headers
    store = memoryStore,
    keyGenerator = (req) => req.ip,
    handler = null, // Custom handler function
    onLimitReached = null, // Callback when limit is reached
    skip = () => false, // Function to skip rate limiting
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
  } = options;

  return async (req, res, next) => {
    try {
      // Skip if skip function returns true
      if (skip(req, res)) {
        return next();
      }

      const key = keyGenerator(req);
      const now = Date.now();

      // Get or create rate limit data
      const result = await store.increment(key, windowMs);
      const { count, resetTime } = result;

      // Calculate remaining time and requests
      const msBeforeNext = Math.max(0, resetTime - now);
      const remaining = Math.max(0, max - count);

      // Set rate limit headers
      if (standardHeaders) {
        res.set('RateLimit-Limit', max);
        res.set('RateLimit-Remaining', remaining);
        res.set('RateLimit-Reset', new Date(resetTime).toISOString());
      }

      if (legacyHeaders) {
        res.set('X-RateLimit-Limit', max);
        res.set('X-RateLimit-Remaining', remaining);
        res.set('X-RateLimit-Reset', Math.ceil(resetTime / 1000));
      }

      // Check if limit exceeded
      if (count > max) {
        // Log security event
        logSecurityEvent('rate_limit_exceeded', {
          key,
          count,
          limit: max,
          windowMs,
          endpoint: req.originalUrl,
          method: req.method,
          userAgent: req.get('User-Agent'),
        }, req);

        // Call onLimitReached callback if provided
        if (onLimitReached) {
          onLimitReached(req, res, options);
        }

        // Set retry-after header
        const retryAfter = Math.ceil(msBeforeNext / 1000);
        res.set('Retry-After', retryAfter);

        // Use custom handler or default error
        if (handler) {
          return handler(req, res, next);
        }

        const error = new RateLimitError(message, retryAfter);
        return next(error);
      }

      // Continue to next middleware
      next();
    } catch (error) {
      // If rate limiting fails, log and continue (fail open)
      console.error('Rate limiter error:', error);
      next();
    }
  };
}

/**
 * Create OCR-specific rate limiter
 */
function createOCRRateLimiter(options = {}) {
  return createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 OCR requests per minute
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many OCR requests. Please wait before trying again.',
        retryable: true,
      },
    },
    keyGenerator: (req) => {
      // Use combination of IP and correlation ID for more granular limiting
      const ip = req.ip || 'unknown';
      const correlationId = req.correlationId;
      return correlationId ? `${ip}:${correlationId.split('-')[1] || 'unknown'}` : ip;
    },
    onLimitReached: (req, res, options) => {
      logSecurityEvent('ocr_rate_limit_exceeded', {
        ip: req.ip,
        correlationId: req.correlationId,
        endpoint: req.originalUrl,
        userAgent: req.get('User-Agent'),
        limit: options.max,
        window: options.windowMs,
      }, req);
    },
    ...options,
  });
}

/**
 * Create upload-specific rate limiter
 */
function createUploadRateLimiter(options = {}) {
  return createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 upload requests per minute (higher than OCR)
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many upload requests. Please wait before trying again.',
        retryable: true,
      },
    },
    keyGenerator: (req) => req.ip,
    ...options,
  });
}

/**
 * Progressive rate limiter that increases limits for trusted IPs
 */
function createProgressiveRateLimiter(options = {}) {
  const {
    baseLimit = 10,
    trustedIPs = [], // IPs that get higher limits
    multiplier = 2, // Multiplier for trusted IPs
    ...otherOptions
  } = options;

  return createRateLimiter({
    ...otherOptions,
    max: baseLimit,
    keyGenerator: (req) => req.ip,
    // Override max based on IP trust level
    handler: async (req, res, next) => {
      const ip = req.ip;
      const isTrusted = trustedIPs.includes(ip);
      const effectiveLimit = isTrusted ? baseLimit * multiplier : baseLimit;
      
      // Re-check with effective limit
      const key = ip;
      const result = await memoryStore.get(key);
      
      if (result.count <= effectiveLimit) {
        return next();
      }
      
      // Still over limit, apply rate limiting
      const error = new RateLimitError(
        `Too many requests. Limit: ${effectiveLimit} per window.`,
        Math.ceil((result.resetTime - Date.now()) / 1000)
      );
      next(error);
    },
  });
}

/**
 * Global rate limiter for all API endpoints
 */
function createGlobalRateLimiter(options = {}) {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // 1000 requests per 15 minutes
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests from this IP. Please try again later.',
        retryable: true,
      },
    },
    standardHeaders: true,
    keyGenerator: (req) => req.ip,
    onLimitReached: (req, res, options) => {
      logSecurityEvent('global_rate_limit_exceeded', {
        ip: req.ip,
        endpoint: req.originalUrl,
        userAgent: req.get('User-Agent'),
        limit: options.max,
        window: options.windowMs,
      }, req);
    },
    ...options,
  });
}

/**
 * Burst rate limiter for handling sudden spikes
 */
function createBurstRateLimiter(options = {}) {
  return createRateLimiter({
    windowMs: 1000, // 1 second
    max: 5, // 5 requests per second burst
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests too quickly. Please slow down.',
        retryable: true,
      },
    },
    ...options,
  });
}

/**
 * Rate limiter with different limits based on endpoint
 */
function createTieredRateLimiter(tiers = {}) {
  return (req, res, next) => {
    const path = req.route?.path || req.path;
    const method = req.method.toLowerCase();
    const key = `${method}:${path}`;
    
    // Find matching tier
    let tierConfig = null;
    for (const [pattern, config] of Object.entries(tiers)) {
      const regex = new RegExp(pattern);
      if (regex.test(key)) {
        tierConfig = config;
        break;
      }
    }
    
    // Use default if no tier matches
    if (!tierConfig) {
      tierConfig = tiers.default || { windowMs: 60000, max: 100 };
    }
    
    const limiter = createRateLimiter(tierConfig);
    limiter(req, res, next);
  };
}

/**
 * Rate limiter statistics
 */
function getRateLimiterStats() {
  return {
    activeKeys: memoryStore.clients.size,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
  };
}

/**
 * Reset rate limits for a specific key (admin function)
 */
async function resetRateLimit(key) {
  memoryStore.clients.delete(key);
  memoryStore.resetTime.delete(key);
  return true;
}

/**
 * Get current rate limit status for a key
 */
async function getRateLimitStatus(key) {
  const result = await memoryStore.get(key);
  return {
    key,
    count: result.count,
    resetTime: result.resetTime,
    remaining: Math.max(0, Date.now() - result.resetTime),
  };
}

module.exports = {
  // Main rate limiter factory
  createRateLimiter,
  
  // Specialized rate limiters
  createOCRRateLimiter,
  createUploadRateLimiter,
  createProgressiveRateLimiter,
  createGlobalRateLimiter,
  createBurstRateLimiter,
  createTieredRateLimiter,
  
  // Store management
  MemoryStore,
  memoryStore,
  
  // Utility functions
  getRateLimiterStats,
  resetRateLimit,
  getRateLimitStatus,
};
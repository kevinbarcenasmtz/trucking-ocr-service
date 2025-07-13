// server.js
const app = require('./src/app');
const config = require('./src/config');
const OCRService = require('./src/services/ocrService');
const { logger } = require('./src/utils/logger');
const { setupGlobalErrorHandlers } = require('./src/middleware/errorHandler');

async function startServer() {
  try {
    // Setup global error handlers
    setupGlobalErrorHandlers();

    // Initialize OCR service
    await OCRService.initialize();
    logger.info({ message: 'OCR service initialized successfully' });

    // Create required directories
    const fs = require('fs');
    ['temp', 'uploads', 'logs'].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info({ message: `Created directory: ${dir}` });
      }
    });

    // Start server
    const PORT = config.server.port;
    const server = app.listen(PORT, () => {
      logger.info({ 
        message: 'Server started successfully',
        port: PORT,
        environment: config.environment,
        nodeVersion: process.version,
      });
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal) => {
      logger.info({ message: `Received ${signal}, shutting down gracefully` });
      
      server.close(async () => {
        try {
          await OCRService.shutdown();
          logger.info({ message: 'Server shut down successfully' });
          process.exit(0);
        } catch (error) {
          logger.error({ message: 'Error during shutdown', error: error.message });
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    logger.error({ 
      message: 'Failed to start server', 
      error: error.message,
      stack: error.stack 
    });
    process.exit(1);
  }
}

startServer();
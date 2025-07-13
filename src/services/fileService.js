// src/services/fileService.js
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// In-memory session storage (use Redis in production)
const uploadSessions = new Map();
const sessionChunks = new Map();

class FileService {
  /**
   * Create a new upload session
   */
  static async createUploadSession(uploadId, sessionData) {
    try {
      // Ensure temp directory exists
      await this.ensureDirectoryExists('temp');
      await this.ensureDirectoryExists('uploads');

      const session = {
        uploadId,
        ...sessionData,
        chunks: [],
        createdAt: new Date().toISOString(),
      };

      uploadSessions.set(uploadId, session);
      sessionChunks.set(uploadId, []);

      logger.info({ 
        uploadId, 
        message: 'Upload session created',
        sessionData 
      });

      return session;
    } catch (error) {
      logger.error({ 
        uploadId, 
        error: error.message, 
        message: 'Failed to create upload session' 
      });
      throw error;
    }
  }

  /**
   * Get upload session data
   */
  static async getUploadSession(uploadId) {
    return uploadSessions.get(uploadId) || null;
  }

  /**
   * Update upload session
   */
  static async updateUploadSession(uploadId, updates) {
    const session = uploadSessions.get(uploadId);
    if (!session) {
      throw new Error('Upload session not found');
    }

    const updatedSession = {
      ...session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    uploadSessions.set(uploadId, updatedSession);
    
    logger.info({ 
      uploadId, 
      updates, 
      message: 'Upload session updated' 
    });

    return updatedSession;
  }

  /**
   * Add a chunk to the upload session
   */
  static async addChunk(uploadId, chunkData) {
    const chunks = sessionChunks.get(uploadId) || [];
    
    // Add chunk with metadata
    const chunk = {
      ...chunkData,
      receivedAt: new Date().toISOString(),
    };

    chunks.push(chunk);
    sessionChunks.set(uploadId, chunks);

    // Update session
    const session = uploadSessions.get(uploadId);
    if (session) {
      session.receivedChunks = chunks.length;
      session.lastChunkAt = new Date().toISOString();
      uploadSessions.set(uploadId, session);
    }

    logger.info({ 
      uploadId, 
      chunkIndex: chunkData.index,
      totalReceived: chunks.length,
      message: 'Chunk added' 
    });

    return chunk;
  }

  /**
   * Get number of received chunks
   */
  static async getChunkCount(uploadId) {
    const chunks = sessionChunks.get(uploadId) || [];
    return chunks.length;
  }

  /**
   * Get all chunks for an upload
   */
  static async getChunks(uploadId) {
    return sessionChunks.get(uploadId) || [];
  }

  /**
   * Combine all chunks into a single file
   */
  static async combineChunks(uploadId) {
    try {
      const chunks = sessionChunks.get(uploadId) || [];
      const session = uploadSessions.get(uploadId);

      if (!session) {
        throw new Error('Upload session not found');
      }

      if (chunks.length === 0) {
        throw new Error('No chunks found to combine');
      }

      // Sort chunks by index to ensure correct order
      chunks.sort((a, b) => a.index - b.index);

      // Validate we have all chunks
      const expectedChunks = session.maxChunks || chunks.length;
      if (chunks.length !== expectedChunks) {
        throw new Error(`Missing chunks. Expected: ${expectedChunks}, Received: ${chunks.length}`);
      }

      // Generate output filename
      const outputFilename = `${uploadId}-${Date.now()}-${session.filename || 'upload.jpg'}`;
      const outputPath = path.join('uploads', outputFilename);

      logger.info({ 
        uploadId, 
        chunks: chunks.length,
        outputPath,
        message: 'Combining chunks' 
      });

      // Combine chunks by reading and writing in order
      const writeStream = await fs.open(outputPath, 'w');

      try {
        for (const chunk of chunks) {
          const chunkData = await fs.readFile(chunk.path);
          await writeStream.write(chunkData);
          
          // Clean up chunk file
          await fs.unlink(chunk.path).catch(err => {
            logger.warn({ 
              uploadId, 
              chunkPath: chunk.path, 
              error: err.message,
              message: 'Failed to delete chunk file' 
            });
          });
        }
      } finally {
        await writeStream.close();
      }

      // Verify the combined file
      const stats = await fs.stat(outputPath);
      const expectedSize = chunks.reduce((total, chunk) => total + chunk.size, 0);

      if (Math.abs(stats.size - expectedSize) > 1024) { // Allow 1KB difference
        logger.warn({
          uploadId,
          expectedSize,
          actualSize: stats.size,
          message: 'File size mismatch after combining chunks'
        });
      }

      logger.info({ 
        uploadId, 
        outputPath,
        fileSize: stats.size,
        message: 'Chunks combined successfully' 
      });

      return outputPath;
    } catch (error) {
      logger.error({ 
        uploadId, 
        error: error.message, 
        message: 'Failed to combine chunks' 
      });
      throw error;
    }
  }

  /**
   * Clean up upload session and associated files
   */
  static async cleanup(uploadId) {
    try {
      const session = uploadSessions.get(uploadId);
      const chunks = sessionChunks.get(uploadId) || [];

      // Clean up chunk files
      for (const chunk of chunks) {
        try {
          await fs.unlink(chunk.path);
        } catch (err) {
          logger.warn({ 
            uploadId, 
            chunkPath: chunk.path, 
            error: err.message,
            message: 'Failed to delete chunk during cleanup' 
          });
        }
      }

      // Clean up combined file if it exists
      if (session?.combinedPath) {
        try {
          await fs.unlink(session.combinedPath);
        } catch (err) {
          logger.warn({ 
            uploadId, 
            combinedPath: session.combinedPath,
            error: err.message,
            message: 'Failed to delete combined file during cleanup' 
          });
        }
      }

      // Remove from memory
      uploadSessions.delete(uploadId);
      sessionChunks.delete(uploadId);

      logger.info({ 
        uploadId, 
        message: 'Upload session cleaned up' 
      });

      return true;
    } catch (error) {
      logger.error({ 
        uploadId, 
        error: error.message, 
        message: 'Failed to cleanup upload session' 
      });
      throw error;
    }
  }

  /**
   * Clean up old sessions (call periodically)
   */
  static async cleanupOldSessions(maxAgeHours = 24) {
    const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000));
    const sessionsToCleanup = [];

    for (const [uploadId, session] of uploadSessions.entries()) {
      const createdAt = new Date(session.createdAt);
      if (createdAt < cutoffTime) {
        sessionsToCleanup.push(uploadId);
      }
    }

    logger.info({ 
      count: sessionsToCleanup.length,
      maxAgeHours,
      message: 'Cleaning up old sessions' 
    });

    for (const uploadId of sessionsToCleanup) {
      try {
        await this.cleanup(uploadId);
      } catch (error) {
        logger.error({ 
          uploadId, 
          error: error.message,
          message: 'Failed to cleanup old session' 
        });
      }
    }

    return sessionsToCleanup.length;
  }

  /**
   * Get session statistics
   */
  static getStats() {
    return {
      activeSessions: uploadSessions.size,
      totalChunks: Array.from(sessionChunks.values()).reduce((total, chunks) => total + chunks.length, 0),
      oldestSession: Array.from(uploadSessions.values())
        .reduce((oldest, session) => {
          const sessionTime = new Date(session.createdAt);
          return !oldest || sessionTime < oldest ? sessionTime : oldest;
        }, null),
    };
  }

  /**
   * Ensure directory exists
   */
  static async ensureDirectoryExists(dirPath) {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
      logger.info({ dirPath, message: 'Directory created' });
    }
  }
}

module.exports = FileService;
// src/__tests__/debug.test.js
const request = require('supertest');

// Mock everything
jest.mock('../services/ocrService', () => ({
  initialize: jest.fn().mockResolvedValue(),
  getStats: jest.fn().mockResolvedValue({ jobs: { total: 0 } }),
}));

jest.mock('../services/fileService', () => ({
  getStats: jest.fn().mockResolvedValue({ activeSessions: 0 }),
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('Debug App Issues', () => {
  let app;

  beforeAll(() => {
    // Set test environment
    process.env.NODE_ENV = 'test';
    app = require('../app');
  });

  it('should debug health endpoint', async () => {
    try {
      const response = await request(app)
        .get('/health');

      console.log('Status:', response.status);
      console.log('Body:', response.body);
      console.log('Error:', response.error);
      
      if (response.status === 500) {
        // Log the actual error from the response
        console.log('500 Error details:', response.text);
      }
      
    } catch (error) {
      console.log('Request failed with error:', error.message);
      console.log('Error stack:', error.stack);
    }
  });
});
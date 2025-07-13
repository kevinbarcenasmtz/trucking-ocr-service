// src/__tests__/basic.test.js
const request = require('supertest');

// Mock all services before importing app
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

describe('Basic App Test', () => {
  let app;

  beforeAll(() => {
    // Import app after mocks are set up
    app = require('../app');
  });

  it('should respond to health check', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);

    console.log('Health response:', response.body);
    expect(response.body.status).toBe('healthy');
  });

  it('should return 404 for unknown routes', async () => {
    const response = await request(app)
      .get('/unknown-route')
      .expect(404);

    console.log('404 response:', response.body);
    expect(response.body.error).toBe('Endpoint not found');
  });
});
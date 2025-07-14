// src/__tests__/setup.js
// Global test setup
jest.setTimeout(10000); // 10 second timeout

// Mock console.error to avoid noise in tests
const originalError = console.error;
beforeAll(() => {
  console.error = (...args) => {
    if (args[0]?.includes && args[0].includes('Warning')) {
      return;
    }
    originalError.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
});
// jest.config.js
module.exports = {
    testEnvironment: 'node',
    collectCoverageFrom: [
      'src/**/*.js',
      '!src/__tests__/**',
      '!src/server.js',
    ],
    setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.js'],
    testMatch: ['**/__tests__/**/*.test.js'],
    verbose: true,
    forceExit: true, // Force Jest to exit
    detectOpenHandles: true, // Help debug async issues
  };
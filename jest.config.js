module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/app.js',
    '!src/worker.js',
  ],
  coverageThreshold: {
    global: { lines: 60, functions: 60, branches: 50 },
  },
  testTimeout: 15000,
  clearMocks: true,
};

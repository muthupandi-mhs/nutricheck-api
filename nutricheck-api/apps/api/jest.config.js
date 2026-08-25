/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testMatch: ['**/__tests__/**/*.spec.ts'],
  // Unit tests only. The Testcontainers suite is jest.int.config.js and is a
  // separate task so `npm test` stays fast enough to run on every save.
  passWithNoTests: true,
};

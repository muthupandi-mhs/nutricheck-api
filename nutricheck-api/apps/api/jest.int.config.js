/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
  // Container startup plus migrations plus an ingest is comfortably past the
  // 5s default. This is the price of testing against real Postgres rather than
  // a mock that cannot tell you whether the trigram index works.
  testTimeout: 180_000,
  maxWorkers: 1,
};

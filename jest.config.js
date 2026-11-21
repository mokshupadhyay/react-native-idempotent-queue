module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Helpers under __tests__/support are not test files.
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  modulePathIgnorePatterns: ['<rootDir>/lib/', '<rootDir>/.run/'],
  // Property tests run many simulated scenarios; no test waits on real time.
  testTimeout: 60000,
};

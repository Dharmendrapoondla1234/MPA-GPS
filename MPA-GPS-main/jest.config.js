module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/backend/tests', '<rootDir>/frontend/src/__tests__'],
  transform: {
    '^.+\\.jsx?$': 'babel-jest',
  },
  moduleFileExtensions: ['js', 'jsx', 'json', 'node'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  setupFilesAfterEnv: ['<rootDir>/setupTests.js'],
};
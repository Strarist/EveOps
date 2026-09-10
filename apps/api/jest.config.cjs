module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^@eveops/contracts$': '<rootDir>/../../../packages/contracts/src',
    '^@eveops/operations$': '<rootDir>/../../../packages/operations/src',
  },
};

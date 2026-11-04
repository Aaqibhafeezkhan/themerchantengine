export default {
  displayName: 'common',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': [
      '<rootDir>/jest-nest-esm.transformer.js',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022',
          keepClassNames: true,
        },
        module: { type: 'commonjs', lazy: true },
      },
    ],
  },
  // Nest 12 ships ESM only, so swc compiles @nestjs/* too.
  transformIgnorePatterns: ['/node_modules/(?!@nestjs/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../../coverage/libs/shared/common',
  maxWorkers: 4,
  workerIdleMemoryLimit: '512MB',
};

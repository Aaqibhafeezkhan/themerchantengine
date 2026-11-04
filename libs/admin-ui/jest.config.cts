module.exports = {
  displayName: 'admin-ui',
  preset: '../../jest.preset.js',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  coverageDirectory: '../../coverage/libs/admin-ui',
  // Constitution 3.8 floor, ratcheted to the measured level with a few points
  // of headroom so ordinary variation does not fail the gate. Replaces the
  // retired `test-coverage-auditor`, which read the tree and gave an opinion.
  // Raise these when a phase raises the real number; never lower one to go
  // green, which is what `.claude/hooks/config-protection.sh` is there for.
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 72,
      functions: 83,
      lines: 88,
    },
  },
  transform: {
    '^.+\\.(ts|mjs|js|html)$': [
      '<rootDir>/jest-nest-esm.transformer.js',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\\.(html|svg)$',
        isolatedModules: true,
      },
    ],
  },
  // Nest 12 is ESM only and shared-common re-exports Nest decorators.
  transformIgnorePatterns: ['node_modules/(?!.*\\.mjs$|@nestjs/)'],
  moduleNameMapper: {
    // Better Auth's browser client is ESM-only and drags in an ESM-only
    // dependency tree Jest's CommonJS runtime cannot load. admin-ui never uses
    // the client, but `asset-picker.component.ts` imports `AssetsService` from
    // the `@admin-services` barrel, which re-exports the auth client, so both
    // asset-picker specs inherit that tree and die on `nanostores`' bare
    // `export`. Stubbed here exactly as apps/admin and libs/admin-services
    // already stub it. The real client is exercised by the admin Playwright
    // suite against the live API.
    '^better-auth/client/plugins$': '<rootDir>/src/testing/better-auth-client.mock.ts',
    '^better-auth/client$': '<rootDir>/src/testing/better-auth-client.mock.ts',
  },
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment',
  ],
  maxWorkers: 2,
  workerIdleMemoryLimit: '1024MB',
};

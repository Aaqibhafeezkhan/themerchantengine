export default {
  displayName: 'admin',
  preset: '../../jest.preset.js',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  coverageDirectory: '../../coverage/apps/admin',
  // Constitution 3.8 floor, ratcheted to the measured level with a few points
  // of headroom so ordinary variation does not fail the gate. Replaces the
  // retired `test-coverage-auditor`, which read the tree and gave an opinion.
  // Raise these when a phase raises the real number; never lower one to go
  // green, which is what `.claude/hooks/config-protection.sh` is there for.
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 64,
      functions: 72,
      lines: 83,
    },
  },
  transform: {
    '^.+\\.(ts|mjs|js|html)$': [
      '<rootDir>/jest-nest-esm.transformer.js',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\\.(html|svg)$',
        // Skip the full ts.Program build inside every Jest worker. Type
        // safety still lives in `nx build admin` and the IDE — running it
        // again per spec was costing ~400 MB per worker.
        isolatedModules: true,
      },
    ],
  },
  // Nest 12 is ESM only and shared-common re-exports Nest decorators.
  transformIgnorePatterns: ['node_modules/(?!.*\\.mjs$|@nestjs/)'],
  moduleNameMapper: {
    // Better Auth's browser client is ESM-only and drags in an ESM-only
    // dependency tree Jest's CommonJS runtime cannot load. Unit tests never
    // touch the real client — every spec injects a fake via the
    // ADMIN_AUTH_CLIENT token — so it is stubbed here. The real client is
    // exercised by the admin Playwright suite against the live API.
    '^better-auth/client/plugins$': '<rootDir>/src/testing/better-auth-client.mock.ts',
    '^better-auth/client$': '<rootDir>/src/testing/better-auth-client.mock.ts',
  },
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment',
  ],
  // Cap parallelism and recycle workers before they balloon. Angular's
  // TestBed + compiler keep ~600 MB resident per worker; without these
  // caps the default (CPUs-1) workers easily exceeded 8 GB total.
  maxWorkers: 2,
  workerIdleMemoryLimit: '1024MB',
};

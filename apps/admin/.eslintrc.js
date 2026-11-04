module.exports = {
  rules: {
    // Constitution 3.5: `unknown` at the boundary, narrowed at once. Warn
    // repo-wide because the api tree carries 21; an error on this lane, which
    // carries none. It lives in the lane's own config rather than in a root
    // `overrides` block: ESLint resolves an extended config's override globs
    // relative to the extending config, so `apps/admin/**` written at the root
    // would resolve to `apps/admin/apps/admin/**` here and match nothing.
    '@typescript-eslint/no-explicit-any': 'error',
  },
  extends: ['../../.eslintrc.js'],
  ignorePatterns: [
    '!**/*',
    '**/*.js.map',
    'jest.config.ts',
    '.postcssrc.json',
    'tailwind.config.js',
    '.eslintrc.js',
  ],
  overrides: [
    {
      files: ['*.html'],
      parser: '@angular-eslint/template-parser',
      plugins: ['@angular-eslint/template'],
      rules: {
        'prettier/prettier': 'off',
      },
    },
  ],
};

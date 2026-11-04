/* eslint-disable @typescript-eslint/no-var-requires */
// Nest 12 ships ESM only and its sources use `import.meta.url`. Jest runs
// CommonJS, so jest-preset-angular compiles @nestjs/* to CJS and this wrapper
// fixes what is left: `import.meta.url` becomes a file URL, and a top-level
// `const require = createRequire(...)` (which clashes with the CJS wrapper
// parameter) is renamed.
const { NgJestTransformer } = require('jest-preset-angular/build/ng-jest-transformer');

class NestEsmTransformer extends NgJestTransformer {
  process(sourceText, sourcePath, transformOptions) {
    const result = super.process(sourceText, sourcePath, transformOptions);
    if (typeof result.code === 'string' && result.code.includes('import.meta')) {
      result.code = result.code.replace(/import\.meta\.url/g, "'file://' + __filename");
      result.code = result.code.replace(/^const require = /gm, 'const __esmRequire = ');
    }
    return result;
  }
}

module.exports = {
  createTransformer: (options) => new NestEsmTransformer(options),
};

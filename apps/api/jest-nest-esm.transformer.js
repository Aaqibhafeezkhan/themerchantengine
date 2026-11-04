/* eslint-disable @typescript-eslint/no-var-requires */
// Nest 12 ships ESM only and its sources use `import.meta.url`. Jest runs
// CommonJS, so ts-jest compiles @nestjs/* to CJS and this wrapper fixes what
// TypeScript leaves behind: `import.meta.url` becomes a file URL, and a
// top-level `const require = createRequire(...)` (which clashes with the CJS
// wrapper parameter) is renamed.
const { TsJestTransformer } = require('ts-jest');

class NestEsmTransformer extends TsJestTransformer {
  process(sourceText, sourcePath, transformOptions) {
    const result = super.process(sourceText, sourcePath, transformOptions);
    if (typeof result.code === 'string' && result.code.includes('import.meta')) {
      result.code = result.code.replace(/import\.meta\.url/g, "'file://' + __filename");
      result.code = result.code.replace(/^const require = \(0, /gm, 'const __esmRequire = (0, ');
    }
    return result;
  }
}

module.exports = {
  createTransformer: (options) => new NestEsmTransformer(options),
};

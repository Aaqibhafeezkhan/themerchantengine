/* eslint-disable @typescript-eslint/no-var-requires */
// Nest 12 ships ESM only and its sources use `import.meta.url`. Jest runs
// CommonJS, so swc compiles @nestjs/* to CJS and this wrapper fixes what swc
// leaves behind: `import.meta.url` becomes a file URL, and a top-level
// `const require = createRequire(...)` (which clashes with the CJS wrapper
// parameter) is renamed.
const swcJest = require('@swc/jest');

module.exports = {
  createTransformer: (options) => {
    const inner = swcJest.createTransformer(options);
    return {
      ...inner,
      process(sourceText, sourcePath, transformOptions) {
        const result = inner.process(sourceText, sourcePath, transformOptions);
        if (typeof result.code === 'string' && result.code.includes('import.meta')) {
          result.code = result.code.replace(/import\.meta\.url/g, "'file://' + __filename");
          result.code = result.code.replace(/^const require = /gm, 'const __esmRequire = ');
        }
        return result;
      },
    };
  },
};

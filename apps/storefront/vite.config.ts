/// <reference types="vitest" />

import { fileURLToPath } from 'node:url';

import analog from '@analogjs/platform';
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

// SH2 — Nitro's bundle resolver does not honour the workspace tsconfig path
// aliases that Vite + nxViteTsPaths handle for the Angular client + SSR
// pipelines. Transitive imports from `pages/**/*.server.ts` companion files
// (page server endpoints) trigger `Invalid module "@storefront-types"`
// 500s when the bundled module hits Nitro's runtime resolver. Surfacing the
// alias map to Nitro via `nitro.alias` keeps the workspace-package
// ergonomics for `.server.ts` callers (which need `createApiClient` from
// `apps/storefront/src/server/api-client.ts`, which itself imports
// `@storefront-types` + `@storefront-services` for type info + the
// `mapHttpErrorToStorefrontError` helper). See clarifications.md §1.17.
//
// Plan E2.1/E2.2 (DR-31) gave `libs/storefront-types` and
// `libs/storefront-services` their own transitive imports from
// `libs/shared/common` (`@common/*`): the runtime config schema shape, the
// neutral config constant and the palette generator. Vite resolves those
// fine for the browser and SSR bundles, same as it always resolved
// `@storefront-types` before the entries above existed, but Nitro's own
// bundler hits the identical `Cannot find package '@common/...'` 500 on
// every page's internal `/api/_analog/pages/**` data endpoint until it is
// told the same way. The deep `store-config-fixture.schema` entry has to
// come before the bare `store-config-fixtures` one: Nitro's alias resolver
// picks the first prefix match, so a shorter entry earlier would shadow it.
const NITRO_ALIASES = {
  '@storefront-types': fileURLToPath(
    new URL('../../libs/storefront-types/src/index.ts', import.meta.url),
  ),
  '@storefront-services': fileURLToPath(
    new URL('../../libs/storefront-services/src/index.ts', import.meta.url),
  ),
  '@common/store-config-fixtures/store-config-fixture.schema': fileURLToPath(
    new URL(
      '../../libs/shared/common/src/store-config-fixtures/store-config-fixture.schema.ts',
      import.meta.url,
    ),
  ),
  '@common/store-config-fixtures': fileURLToPath(
    new URL('../../libs/shared/common/src/store-config-fixtures/index.ts', import.meta.url),
  ),
  '@common/store-config': fileURLToPath(
    new URL('../../libs/shared/common/src/store-config/index.ts', import.meta.url),
  ),
  '@common/locale/locale-registry': fileURLToPath(
    new URL('../../libs/shared/common/src/locale/locale-registry.ts', import.meta.url),
  ),
  '@common/locale': fileURLToPath(
    new URL('../../libs/shared/common/src/locale/index.ts', import.meta.url),
  ),
  '@common/brand': fileURLToPath(
    new URL('../../libs/shared/common/src/brand/index.ts', import.meta.url),
  ),
  '@common/fingerprint': fileURLToPath(
    new URL('../../libs/shared/common/src/fingerprint/index.ts', import.meta.url),
  ),
};

// Analog (Angular meta-framework) + Vite + Vitest configuration for the
// merchants-engine storefront. Dev port 53300, e2e port 53311.
// Brand tokens, Tailwind v4 + brand.css are wired via the project-local
// postcss.config.cjs which Vite picks up automatically.
export default defineConfig(({ mode }) => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/storefront',
  build: {
    outDir: '../../dist/apps/storefront/client',
    reportCompressedSize: true,
    target: ['es2020'],
    // Emit `.vite/manifest.json` so the S14 bundle-budget verifier
    // (apps/storefront/tools/verify-bundle-budgets.cjs) can walk the
    // dependency graph rooted at the entry chunk and gzip every chunk
    // for the budget assertion (First Load JS ≤ 170 KB gz, idle
    // hydration ≤ 60 KB gz per quality-gates.md + clarifications §1.30).
    manifest: true,
    // S14.4 / S14.9: split the Angular framework + Analog runtime into
    // dedicated vendor chunks so the per-route First Load JS reflects
    // route-owned code, not the framework boilerplate. Without this
    // split the entry chunk reaches ~150 KB gz; with it the framework
    // lives in cacheable vendor.* chunks while route entries stay
    // route-sized. Measured floor: 161 KB gz total First Load (vendor +
    // entry); 170 KB cap carries 9 KB headroom per clarifications §1.30.
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/@angular/')) return 'vendor-angular';
          if (
            id.includes('node_modules/@analogjs/') ||
            id.includes('node_modules/h3/') ||
            id.includes('node_modules/nitropack/') ||
            id.includes('node_modules/ofetch/')
          ) {
            return 'vendor-analog';
          }
          if (
            id.includes('node_modules/zod/') ||
            id.includes('node_modules/rxjs/')
            // zone.js is intentionally NOT manual-chunked. It must execute
            // synchronously before any Angular code touches NgZone — its
            // constructor throws NG0908 ("Zone is undefined") if the Zone
            // global isn't already on globalThis. In SSR, splitting zone.js
            // into a vendor-runtime chunk caused Analog's auto-generated
            // virtual SSR renderer to call `new NgZone()` before the Zone
            // chunk finished evaluating → 500 on every storefront page.
            // Keeping it inline with the entry (main.ts / main.server.ts both
            // `import 'zone.js'` / `import 'zone.js/node'` as the first line)
            // guarantees the polyfill loads first.
          ) {
            return 'vendor-runtime';
          }
          return undefined;
        },
      },
    },
  },
  // Pre-bundle dependencies that the smoke page and services lib import so
  // Vite does not trigger a mid-run dep-optimisation reload when the e2e
  // suite hits `/_smoke/services`. Without this the first browser that
  // imports `zod` causes Vite to re-optimise and reload all clients,
  // hanging any in-flight fetches and causing the services smoke spec to
  // time out on Chromium / Chrome while WebKit gets a network error.
  optimizeDeps: {
    include: ['zod'],
  },
  server: {
    port: 53300,
    host: 'localhost',
    fs: {
      allow: ['.'],
    },
    // Proxy API calls from the storefront dev server to the NestJS API so
    // browser-side fetch('/v1/...') resolves to http://localhost:53000/api/v1/...
    // without triggering Angular Router (which only handles same-origin routes).
    // The API runs with `API_GLOBAL_PREFIX=api`, so the proxy rewrites the
    // outbound path to include `/api`. Override the rewrite via the
    // `STOREFRONT_API_TARGET_PREFIX` env var if a deployment uses a different
    // prefix (e.g. `''` when the API runs without a global prefix). Vite
    // requires a dev-server restart to pick up changes to this block.
    //
    // SEO + GEO surface proxy (S13):
    // In Vite dev mode, Analog's Nitro middleware is only mounted at `/api`.
    // Routes like /sitemap_index.xml, /robots.txt, /llms.txt fall through to
    // the Angular SSR renderer and return HTML. These proxy rules intercept
    // the SEO surface paths before Angular handles them and forward directly
    // to the upstream API — mirroring exactly what the production Nitro server
    // routes (apps/storefront/src/server/routes/*.ts) do.
    proxy: (() => {
      const seoApiBase = process.env['STOREFRONT_API_URL'] ?? 'http://localhost:53000';
      // Rewrite /path → <prefix>/v1/path on the API base. Mirrors the
      // existing /v1 browser-proxy convention below: default dev mounts the
      // API at /api/v1 so we prepend /api; in e2e the base already includes
      // /api and STOREFRONT_API_TARGET_PREFIX is set to '' to disable the
      // rewrite.
      const seoApiTargetPrefix = process.env['STOREFRONT_API_TARGET_PREFIX'] ?? '/api';
      const seoRewrite = (path: string) =>
        seoApiTargetPrefix ? `${seoApiTargetPrefix}/v1${path}` : `/v1${path}`;
      return {
        // /v1 routes — existing browser-side API proxy (unchanged).
        // cookiePathRewrite strips the API's `/api` prefix from Set-Cookie Path
        // so cookies set by login/register are stored on the storefront origin
        // at a path that matches subsequent storefront requests (e.g. browser
        // fetch `/v1/auth/refresh` won't match a cookie scoped to
        // `/api/v1/auth`). Without this, refresh-token cookies are dropped on
        // every page reload and the user gets logged out.
        '/v1': {
          target: seoApiBase,
          changeOrigin: true,
          rewrite: (path: string) => {
            const prefix = process.env['STOREFRONT_API_TARGET_PREFIX'] ?? '/api';
            return prefix ? `${prefix}${path}` : path;
          },
          cookiePathRewrite: (() => {
            const prefix = process.env['STOREFRONT_API_TARGET_PREFIX'] ?? '/api';
            return prefix ? { [`${prefix}/v1/auth`]: '/v1/auth' } : {};
          })(),
        },
        // SEO surface routes — proxied to /api/v1/<path> on the API.
        '/sitemap_index.xml': {
          target: seoApiBase,
          changeOrigin: true,
          rewrite: seoRewrite,
        },
        '/sitemap-products.xml': {
          target: seoApiBase,
          changeOrigin: true,
          rewrite: seoRewrite,
        },
        '/sitemap-categories.xml': {
          target: seoApiBase,
          changeOrigin: true,
          rewrite: seoRewrite,
        },
        '/sitemap-pages.xml': {
          target: seoApiBase,
          changeOrigin: true,
          rewrite: seoRewrite,
        },
        '/robots.txt': {
          target: seoApiBase,
          changeOrigin: true,
          rewrite: seoRewrite,
        },
        '/llms.txt': {
          target: seoApiBase,
          changeOrigin: true,
          rewrite: seoRewrite,
        },
        // /sitemap.xml — 301 alias to /sitemap_index.xml (not /v1/sitemap_index.xml).
        // The API returns Location: /v1/sitemap_index.xml; rewrite to strip /v1
        // so crawlers and the e2e spec see the storefront-level path.
        '/sitemap.xml': {
          target: seoApiBase,
          changeOrigin: true,
          rewrite: () =>
            seoApiTargetPrefix ? `${seoApiTargetPrefix}/v1/sitemap.xml` : '/v1/sitemap.xml',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          configure: (proxy: any) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            proxy.on('proxyRes', (proxyRes: any) => {
              if (proxyRes.statusCode === 301 && proxyRes.headers['location']) {
                proxyRes.headers['location'] = (proxyRes.headers['location'] as string).replace(
                  /^(\/api)?\/v1\/sitemap_index\.xml$/,
                  '/sitemap_index.xml',
                );
              }
            });
          },
        },
      };
    })(),
  },
  preview: {
    port: 53300,
  },
  plugins: [
    // Do NOT set `VITE_ANALOG_PUBLIC_BASE_URL` for this build. It is unset today,
    // and Analog's route resolver reads it to decide whether to answer a page
    // endpoint with `globalThis.$fetch(url.pathname)` instead of `HttpClient`.
    // That path skips every interceptor, so it would drop the deep-linked query
    // again with nothing red anywhere. See `src/lib/loader-query.ts`.
    analog({
      ssr: true,
      static: false,
      prerender: {
        routes: [],
      },
      // Exclude Vitest spec files from Nitro's server-directory scan so that
      // *.spec.ts files co-located with middleware or routes (e.g.
      // server/middleware/security-headers.spec.ts) are not mistakenly
      // imported as middleware handlers during the Nitro build. Nitro uses
      // this `ignore` list as glob patterns relative to the project root.
      nitro: {
        ignore: ['**/*.spec.ts'],
        alias: NITRO_ALIASES,
      },
    }),
    nxViteTsPaths(),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['**/*.spec.ts'],
    reporters: ['default'],
    // Switch from the default `threads` pool to `forks` so each worker is
    // a separate Node process with its own bounded heap. The thread pool
    // shares the parent's heap and the 115-file suite was OOM-killing one
    // worker on CI (axe-core + jsdom canvas stubs allocate per `expect`
    // and the cumulative retention crossed Node's default cap). Forks
    // recycle between files via vitest's per-file isolation, so the
    // ceiling stays at ~1 GB × maxForks.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 2,
        minForks: 1,
      },
    },
    coverage: {
      reportsDirectory: '../../coverage/apps/storefront',
      provider: 'v8',
    },
  },
  define: {
    'import.meta.vitest': mode !== 'production',
  },
}));

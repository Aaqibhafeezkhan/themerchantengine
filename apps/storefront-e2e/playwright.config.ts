import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

/**
 * Windows Hyper-V port-exclusion escape hatch. If the OS reserves the default
 * (53311 / 53300) — confirmed on some dev machines where the dynamic exclusion
 * range covers 5xxxx — set STOREFRONT_DEV_PORT to any available port (e.g.
 * 53400) and Playwright will use it for both the webServer spawn and the
 * baseURL. Mirrors the ADMIN_DEV_PORT knob in apps/admin-e2e.
 */
const STOREFRONT_DEV_PORT = process.env['STOREFRONT_DEV_PORT'] ?? '53311';
const baseURL = process.env['BASE_URL'] ?? `http://localhost:${STOREFRONT_DEV_PORT}`;

/**
 * Windows port-exclusion escape hatch: a PORT override, and nothing more.
 *
 * `STOREFRONT_E2E_REUSE_DEV_API=1` used to live here. It skipped the test-API
 * spawn and pointed the whole suite at the dev API on :53000, and its own
 * comment admitted the trade-off: "the test then hits the dev DB instead of
 * the seeded test DB". That is the identical mistake the admin harness made
 * with PLAYWRIGHT_SKIP_LIVE_BACKEND, which wrote e2e fixtures into the dev
 * database for two weeks (plan H, finding H1) — this suite mutates carts,
 * orders, wishlists, reviews and customer accounts, so it had at least as much
 * to spill. Plan H removed both. `STOREFRONT_E2E_API_PORT` keeps the half that
 * was actually about ports, and `global-setup.ts` asserts the API on it is a
 * test-mode API on a `_test` database before any spec runs.
 */
const TEST_API_PORT = process.env['STOREFRONT_E2E_API_PORT'] ?? '53001';
const STOREFRONT_API_BASE = `http://localhost:${TEST_API_PORT}/api`;

/**
 * Storefront e2e configuration.
 *
 * Boots the Analog dev server on port 53311 (test port) so it does not
 * collide with the dev server on 53300. Specs hit the real Analog SSR
 * pipeline — no fixtures, no mocks (constitution §3.8).
 *
 * Viewport matrix mirrors `apps/admin-e2e/playwright.config.ts` so brand
 * + a11y auditors can compare across surfaces.
 */
export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  globalSetup: require.resolve('./src/global-setup'),
  // One retry handles any residual Vite cold-start or flake on first run.
  retries: process.env['CI'] ? 2 : 1,
  // Multi-step journeys navigate home → category → product → cart, each step
  // waiting up to 60 s for the grid/summary to appear (WebKit cold-start
  // ceiling, S21.8). The chromium projects exit on first paint so this is
  // only loaded on mobile-safari. 240 s overall covers the full 5-step chain
  // (home+category+product+CTA+cart) with headroom for slow Vite SSR dev
  // server cold starts on WebKit.
  timeout: 240_000,
  // Limit parallelism to 3 workers so the single Vite SSR dev server is not
  // overwhelmed by concurrent test workers, which causes slow page renders and
  // timeout failures on multi-step journeys.
  workers: 3,
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video:
      process.env['PW_VIDEO'] === 'on' ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off',
  },
  // Visual regression snapshot config (S14.8). 1 % maxDiffPixelRatio absorbs
  // sub-pixel font-rendering jitter (common on Chromium across machines)
  // without masking real UI breakage. Animations + caret are disabled so
  // baselines do not drift on motion-sensitive flows.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  /**
   * Two-server setup: the test API on 53001 plus the storefront SSR on 53311.
   * Playwright spawns both in parallel and waits for each `url` to respond
   * before the suite starts. Caught by the S21 final e2e sweep — the prior
   * single-server config required the operator to start the API in a separate
   * terminal, which silently broke every section-driven test (page rendered
   * without sections because /v1/storefront/sections/home returned 502).
   *
   * There is no branch that points either server at the dev stack. When the
   * OS reserves 53001, move the test API with STOREFRONT_E2E_API_PORT; the
   * identity guard in globalSetup then confirms what answers there.
   */
  webServer: [
    {
      command: 'npx nx serve api',
      url: `http://localhost:${TEST_API_PORT}/api/v1/storefront/sections/home`,
      reuseExistingServer: !process.env['CI'],
      cwd: workspaceRoot,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        PORT: TEST_API_PORT,
        // .env loads PORT=53000 + API_GLOBAL_PREFIX=api. dotenv ignores values
        // already set in process.env when called with `override: false` (the
        // default). nx-serve-spawned Node inherits these env vars first, so
        // the .env values do not stomp them.
        API_GLOBAL_PREFIX: 'api',
        // Override .env to point Prisma at the test DB. seed-storefront-test
        // already wrote here in globalSetup; the test API serves the seeded
        // catalog without contaminating dev data.
        DATABASE_URL:
          process.env['DATABASE_TEST_URL'] ??
          process.env['TEST_DATABASE_URL'] ??
          'postgresql://postgres:postgres@localhost:55433/merchants_engine_test',
        // Nx loads .env, so REDIS_PORT is the dev Redis here. Read the test pair.
        REDIS_HOST: process.env['REDIS_TEST_HOST'] ?? 'localhost',
        REDIS_PORT: process.env['REDIS_TEST_PORT'] ?? '56380',
        // Throttler: env-gated bypass per clarifications §1.17.
        DISABLE_THROTTLE: '1',
        // Registers the fake_embedded and fake_redirect test providers (issue #45).
        // The API refuses to boot with this flag when NODE_ENV=production.
        PAYMENT_FAKE_PROVIDERS: 'true',
        // BA4: drop Better Auth's requireEmailVerification on the e2e API
        // so a freshly-registered customer can be authenticated without an
        // inbox round-trip. Scoped to this spawn only — the backend e2e
        // keeps the real verification path. See apps/api/src/auth/auth.ts.
        AUTH_SKIP_EMAIL_VERIFICATION: '1',
        // S15: same revalidate secret the storefront uses (env share via env-block).
        STOREFRONT_REVALIDATE_SECRET:
          process.env['STOREFRONT_REVALIDATE_SECRET'] ??
          'storefront-e2e-revalidate-secret-32+bytes',
        // Without this, `apps/api/src/modules/seo/site-url.ts` falls back to
        // `DEV_FALLBACK = 'http://localhost:53300'` (the default storefront
        // dev port, not the e2e test port), so every absolute URL the API
        // emits — sitemap `<loc>` entries, JSON-LD, canonical/hreflang —
        // points at a port nothing in this run is listening on.
        // `seo.journey.spec.ts` navigates via those sitemap URLs directly,
        // so a mismatch here fails with ERR_CONNECTION_REFUSED regardless
        // of locale. Matches the storefront's own `STOREFRONT_PUBLIC_BASE_URL`
        // below so both halves agree.
        STOREFRONT_PUBLIC_BASE_URL: baseURL,
        // The seed writes the fixture images to uploads-test and stamps their
        // URLs on this API, so this API must serve that root.
        UPLOADS_ROOT: 'uploads-test',
        PRIVATE_UPLOADS_DIR: 'uploads-test-private',
        UPLOADS_BASE_URL: `http://localhost:${TEST_API_PORT}/uploads`,
      },
    },
    {
      command: `npx nx serve storefront --port=${STOREFRONT_DEV_PORT}`,
      url: `http://localhost:${STOREFRONT_DEV_PORT}/fr/`,
      reuseExistingServer: !process.env['CI'],
      cwd: workspaceRoot,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // Route the Vite dev-server proxy to the test API (port 53001) rather
        // than the default dev API (port 53000). The test API uses the test DB
        // seeded by globalSetup so e2e specs hit isolated, known-good data.
        //
        // STOREFRONT_API_URL is the single base URL consumed by both the SSR
        // server client and the Vite browser proxy. The SSR client appends the
        // path segment itself, so the base must include the `/api` global
        // prefix. The Vite proxy would normally also prepend `/api` via its
        // own rewrite rule — left enabled, requests would resolve to
        // `/api/api/v1/...`. Setting STOREFRONT_API_TARGET_PREFIX='' disables
        // that rewrite so the proxy passes `/v1/...` straight through to the
        // already-prefixed base URL.
        //   - SSR:           http://localhost:53001/api + /v1/search → /api/v1/search ✓
        //   - Browser proxy: /v1/search → http://localhost:53001/api + /v1/search ✓
        // Nx loads .env, whose STOREFRONT_API_URL is the dev API, so the
        // override reads a test-only name.
        STOREFRONT_API_URL: process.env['STOREFRONT_E2E_API_URL'] ?? STOREFRONT_API_BASE,
        STOREFRONT_API_TARGET_PREFIX: process.env['STOREFRONT_API_TARGET_PREFIX'] ?? '',
        // S15: shared secret the revalidate.journey suite uses to authenticate
        // the Nitro `/api/_internal/revalidate` route. The same value is read
        // by `process.env` in both the Nitro handler and the spec.
        STOREFRONT_REVALIDATE_SECRET:
          process.env['STOREFRONT_REVALIDATE_SECRET'] ??
          'storefront-e2e-revalidate-secret-32+bytes',
        // Matches the API spawn's `STOREFRONT_PUBLIC_BASE_URL` above. Page
        // components (`about.page.ts` and siblings) read the same env var
        // for canonical / og:url / hreflang; unset, it falls back to the
        // default dev port 53300 rather than this run's actual port.
        STOREFRONT_PUBLIC_BASE_URL: baseURL,
      },
    },
  ],
  projects: [
    {
      // `notification-preferences`, `returns` and `wishlist` were absent from
      // every project's testMatch, so all three collected zero tests under
      // every run while still reading as covered: two of them are locale-matrix
      // specs that auditors counted as compliant. Added here, to the primary
      // desktop project only, at phase D2. Widen to the mobile projects once
      // they have a run's worth of history.
      name: 'desktop-chromium-1440',
      testMatch:
        /(smoke|services\.journey|layout-shell\.journey|home\.journey|home-section-driven\.journey|home-sections\.journey|catalog\.journey|catalog-facets\.journey|catalog-infinite-scroll\.journey|catalog-ssr\.journey|catalog-query-ssr\.journey|category-ssr\.journey|search\.journey|search-ssr\.journey|cart\.journey|cart-merge\.journey|auth\.journey|checkout\.journey|account\.journey|reviews\.journey|seo\.journey|visual-regression\.journey|error-pages\.journey|revalidate\.journey|responsive-overflow\.journey|av4-picture-rendering\.journey|locale-redirect\.journey|mobile-search\.journey|scroll-restoration\.journey|product-detail-ssr\.journey|home-ssr\.journey|about-ssr\.journey|policy-ssr\.journey|locale-leak-ssr\.journey|root-redirect\.journey|newsletter\.journey|notification-preferences\.journey|returns\.journey|wishlist\.journey|product-availability\.journey|product-page-ux\.journey|price-tax-mention\.journey|loader-404\.journey|rich-text\.journey|cms-pages\.journey|spa-rehydration\.journey|order-track\.journey|order-cancel\.journey|order-invoice\.journey|request-budget\.journey|analytics-events\.journey|analytics-pixels\.journey)\.spec\.ts$|project-coverage\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-chrome',
      testMatch:
        /(smoke|services\.journey|layout-shell\.journey|home\.journey|home-section-driven\.journey|home-sections\.journey|catalog\.journey|catalog-infinite-scroll\.journey|catalog-ssr\.journey|category-ssr\.journey|search\.journey|search-ssr\.journey|cart\.journey|auth\.journey|checkout\.journey|account\.journey|reviews\.journey|seo\.journey|visual-regression\.journey|error-pages\.journey|revalidate\.journey|av4-picture-rendering\.journey|locale-redirect\.journey|mobile-search\.journey|scroll-restoration\.journey|product-detail-ssr\.journey|home-ssr\.journey|about-ssr\.journey|policy-ssr\.journey|locale-leak-ssr\.journey|root-redirect\.journey|newsletter\.journey|cms-pages\.journey|product-page-ux\.journey)\.spec\.ts$/,
      use: { ...devices['Pixel 7'] },
    },
    {
      // mobile-safari (WebKit) excludes catalog-infinite-scroll per
      // clarifications §1.35 (the spec requires Angular ngOnInit to fire
      // which depends on browser hydration, and WebKit does not reliably
      // complete hydration in the Vite dev-server cold path).
      // Covered by desktop-chromium-1440 + mobile-chrome (4/4 pass).
      // Lifts with the v2 SSG/ISR build (§1.23 lineage).
      //
      // home-section-driven.journey.spec.ts testIgnore carve-out is LIFTED
      // at SH4 exit per clarifications §1.18: the catalog-page SSR migration
      // (SH4) closes the catalog-grid hydration gap that was the sole
      // remaining mobile-safari blocker in that spec. The SSR HTML now
      // carries catalog-grid on first byte so WebKit does not need to
      // wait for a browser-side hydrate fetch on the category click test.
      name: 'mobile-safari',
      testMatch:
        /(smoke|services\.journey|layout-shell\.journey|home\.journey|home-section-driven\.journey|home-sections\.journey|catalog\.journey|catalog-ssr\.journey|category-ssr\.journey|search\.journey|search-ssr\.journey|cart\.journey|auth\.journey|checkout\.journey|account\.journey|reviews\.journey|seo\.journey|visual-regression\.journey|error-pages\.journey|revalidate\.journey|locale-redirect\.journey|mobile-search\.journey|product-detail-ssr\.journey|home-ssr\.journey|about-ssr\.journey|policy-ssr\.journey|locale-leak-ssr\.journey|root-redirect\.journey|newsletter\.journey|cms-pages\.journey)\.spec\.ts$/,
      testIgnore: /catalog-infinite-scroll\.journey\.spec\.ts$/,
      use: { ...devices['iPhone 14'] },
    },
    {
      // store-config.journey rewrites the store contact block and currency
      // mid-run. Run it after every other project so no visual baseline or
      // money assertion sees the mutated config. Guarded by
      // project-coverage.spec.ts.
      name: 'desktop-chromium-1440-store-config',
      testMatch: /store-config\.journey\.spec\.ts$/,
      dependencies: [
        'desktop-chromium-1440',
        'mobile-chrome',
        'mobile-safari',
        'desktop-chromium-1440-card-payment',
      ],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // embedded-card-payment.journey activates a second payment method in the
      // shared DB while it runs. An order placed without a method code then
      // fails with ORDER_PAYMENT_METHOD_INVALID, so no other spec may run
      // beside it. Guarded by project-coverage.spec.ts.
      name: 'desktop-chromium-1440-card-payment',
      testMatch: /embedded-card-payment\.journey\.spec\.ts$/,
      dependencies: ['desktop-chromium-1440', 'mobile-chrome', 'mobile-safari'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});

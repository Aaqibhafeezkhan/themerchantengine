---
title: Repository layout
description: "The Nx workspace: every app and library with its port, its purpose and how it builds, the path a request travels from the edge nginx to Prisma and back, and which app imports which library."
primaryQuery: nestjs prisma ecommerce repository layout
updated: 2026-10-27
schema: TechArticle
---

The engine is one Nx workspace (`nx.json`, Nx 22) holding three applications, three e2e projects and eight libraries. One `package.json` at the root carries every dependency; there are no per-app package files. Node 22 (`.nvmrc`), NestJS 10, Prisma 7, Angular 21, Analog 2. This page is the map. [Development environment](./development-environment.md) says how to run it and [Conventions](./conventions.md) says the rules a change follows.

## The applications

- `apps/api/`: the NestJS REST API. Dev port 53000. Nx project `api`.
- `apps/admin/`: the Angular admin dashboard. Dev port 53200. Nx project `admin`.
- `apps/storefront/`: the Analog.js storefront, rendered on the server by Nitro. Dev port 53300. Nx project `storefront`.
- `apps/admin-e2e/`, `apps/storefront-e2e/`: the two Playwright suites, each with its own `playwright.config.ts` and global setup.
- `apps/admin-services-e2e/`: a Playwright project that exercises `libs/admin-services/` against the real API (`npm run test:services-e2e`).
- `tools/setup/`: the install stepper that `setup.sh` and `setup.ps1` run. It renders `deploy/templates/` into a stack directory; [Topology](../operate/topology.md) describes what it writes.

## The libraries and who imports them

Every library is reached through a path alias declared in `tsconfig.base.json`. The alias is the import; nothing imports a library by relative path across the tree.

- `libs/shared/common/` (`@common/*`, project `common`): the backend's shared layer. The response interceptor, the exception filter, the Translatable interceptor, the guards, the decorators, the correlation and security-header middleware, money and store-config helpers. Imported by the API in 169 files, and by the storefront, the admin and their type libraries for the store-config schema, the palette generator and money formatting.
- `libs/shared/permissions/` (`@permissions`): the permission catalogue, one frozen list of modules and actions. Imported by the API, the admin, the admin services and the admin e2e suite. `prisma/permission-catalogue.ts` is a hand-kept copy for the seed, and `apps/api/src/permission-catalogue.parity.spec.ts` fails when the two drift.
- `libs/shared/admin-routes/` (`@admin-routes`): every `/v1/admin/*` path as a constant. The API controllers and the admin services both build their paths from it, 32 files on each side.
- `libs/admin-types/` (`@admin-types`): the Zod schemas and types the admin validates every API response against.
- `libs/admin-services/` (`@admin-services`): one Angular service per API module, the HTTP layer of the admin. Imported by the admin in 311 files.
- `libs/admin-ui/` (`@admin-ui`): the admin design-system primitives, atoms and organisms.
- `libs/storefront-types/` (`@storefront-types`): the Zod schemas of the storefront API surface.
- `libs/storefront-services/` (`@storefront-services`): the storefront's Angular services and its browser API client, `libs/storefront-services/src/lib/shared/browser-api-client.ts`.

The API-only aliases are `@/*` (`apps/api/src`), `@modules/*` and `@config/*`. The admin's own source is `@admin/*`.

## The API

`apps/api/src/main.ts` boots one Nest application and `apps/api/src/app.module.ts` imports the modules.

- There are thirty-three module directories under `apps/api/src/modules/`: analytics, assets, audit-log, auth, campaigns, carriers, cart, categories, checkout, cms, contact, countries, currencies, geo, gift-cards, inventory, mail, notifications, orders, payments, products, promotions, returns, reviews, search, seo, settings, shipping, storefront-config, tax, users, webhooks and wishlist.
- `auth/` holds only the permissions guard. Authentication itself is Better Auth, configured in `apps/api/src/auth/auth.ts` and mounted as a raw Node handler in `main.ts`, not as a Nest module.
- A module is a directory with a module class, one or more controllers, a service, a `dto/` directory and its specs. Modules talk to each other by injecting services; a module never reaches another module's tables through Prisma.
- The database client is `apps/api/src/prisma/prisma.service.ts`, one Prisma client extended with the soft-delete filter, provided by `PrismaModule`.
- Two settings shape every URL. `API_GLOBAL_PREFIX=api` moves every route under `/api` and Swagger under `/api/docs`; `/health` is excluded from the prefix on purpose. Production sets it (`.env.production.example`, written by `tools/setup/src/output/compose-env.ts`), and the admin and storefront dev proxies assume it too, so a checkout sets it as well (see [Development environment](./development-environment.md)). `PORT` defaults to 53000.

How it builds:

- `npx nx build api` runs `nest build` with the webpack builder (`apps/api/nest-cli.json`, `apps/api/webpack.config.js`). The output is two bundles: `dist/apps/api/main.js`, the server, and `dist/apps/api/openapi-export.js`, which `npm run docs:generate` runs to write the public API reference without listening. `main.js` is what the container and the backend e2e harness run.
- `npx nx serve api` runs `nest start --watch`.
- `apps/api/Dockerfile` runs `prisma generate` and `nx build api`, then ships a slim runtime with the bundle, `prisma/` and `libs/shared/common/src` (the seed imports it at run time).

## The admin

`apps/admin/` is a standalone-component Angular 21 app.

- The source is `apps/admin/src/app/`: `core/` (stores, guards, HTTP interceptors, the session bootstrap), `features/` (one lazy-loaded route group per module), `shared/` (layouts and navigation).
- Tailwind 4 with `apps/admin/tailwind.config.js`; the brand tokens live in `apps/admin/src/styles.css`.
- Signals hold local UI state, Reactive Forms hold every form, and `@angular/cdk` supplies the dialog, overlay, listbox and a11y primitives. TanStack Query caches server state only; there is no NgRx.
- Every API response and form is parsed by a Zod schema from `libs/admin-types/`, called by the matching service in `libs/admin-services/`. Component tests run jest-axe; the Playwright journeys run axe.
- The app's API base is the relative `/api` (`apps/admin/src/environments/environment.ts`), in dev and in production alike.
- `npx nx serve admin` runs the dev server on 53200 with `apps/admin/proxy.conf.json`, which forwards `/api` to `http://localhost:53000` without rewriting the path.
- `npx nx build admin` uses `@angular/build:application` (esbuild) and writes `dist/apps/admin/browser`, with production budgets of 900 kB on the initial bundle and 80 kB on `main` (`apps/admin/project.json`).
- In production `apps/admin/Dockerfile` serves that directory from nginx with `apps/admin/nginx.conf`: hashed assets cached for a year, `index.html` never cached, `/healthz` for the health check. The container proxies nothing; `/api` on the admin host is the edge's job.

## The storefront

`apps/storefront/` is an Analog.js application on Vite (`apps/storefront/vite.config.ts`).

- Pages are files under `apps/storefront/src/app/pages/`, with a locale prefix in every route. `apps/storefront/src/lib/routes.ts` is the one place a route path is spelled.
- `apps/storefront/src/app/layout/` is the shell (header, footer, the session boot), `apps/storefront/src/app/sections/` the feature components per area (catalog, product, cart, checkout, account, auth, search, home), `apps/storefront/src/app/services/` the client-side state.
- The server half runs on Nitro. `apps/storefront/src/server/` holds the middleware (`locale-redirect.ts`, `security-headers.ts`, `seo-redirect.ts`), the server routes that proxy `robots.txt`, the sitemaps and the `llms.txt` files to the API, and `api/_internal/revalidate.post.ts`, the route the API calls after a catalogue write.
- `apps/storefront/src/server/api-client.ts` is the request-scoped client every SSR loader uses. It forwards the customer's cookies, sets `Accept-Language` from the route locale and `X-Request-Id` on every call.
- `npx nx serve storefront` runs the Vite dev server on 53300. Its proxy sends browser calls to `/v1/...` on to `http://localhost:53000/api/v1/...`.
- `npx nx build storefront --configuration=production` writes `dist/apps/storefront/client` and `dist/apps/storefront/analog/server/index.mjs`; `node` runs the latter. `apps/storefront/Dockerfile` does exactly that and listens on 54300 inside the container.
- Nitro does not read the workspace path aliases, so the ones the server bundle needs are repeated as `nitro.alias` in `apps/storefront/vite.config.ts`.

## The path of a request

On an installed store the edge nginx is the first hop (`deploy/templates/nginx/`):

- `api.conf` proxies everything on the API host to `api:53000`.
- `admin.conf` proxies `/api/` on the admin host to the API and `/` to the admin container.
- `storefront.conf` rewrites `/v1/...` on the storefront host to `/api/v1/...` on the API and sends `/` to the storefront container.
- Every hop carries `X-Request-Id`, taken from the client when one was sent and minted by the edge otherwise (`deploy/shared/nginx-base.conf`).

Inside the API, in order (`apps/api/src/main.ts`, `apps/api/src/app.module.ts`):

- Express middleware registered in `main.ts`: the cache-control hardening (`apps/api/src/bootstrap/cache-control-hardening.ts`), the local uploads mount, the cookie parser, CORS from `CORS_ORIGIN`, the Better Auth handler for `/v1/auth/*` (before the JSON parser, because it reads the raw body), then the JSON and urlencoded parsers with a 100 kB limit.
- Nest middleware from `app.module.ts`: `CorrelationIdMiddleware` (sets `req.id` and the `X-Request-Id` response header), then `SecurityHeadersMiddleware`, on every route.
- The four global guards in registration order: `AppThrottlerGuard` (`libs/shared/common/src/guards/throttler.guard.ts`, Redis-backed), `SessionAuthGuard` (`apps/api/src/common/session-auth.guard.ts`, resolves the Better Auth cookie and loads the user's role and permissions fresh from the database into `req.user`), `PermissionsGuard` (`apps/api/src/modules/auth/guards/permissions.guard.ts`), `OwnerGuardGuard` (`libs/shared/common/src/guards/owner-guard.guard.ts`).
- The global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`, which turns the body into the controller's DTO class or answers 400 `VALIDATION_ERROR`.
- The controller method, which calls the module service, which calls `PrismaService`.
- On the way out, the global interceptors run in reverse registration order: `DecimalSerializationInterceptor` (Prisma decimals to numbers), `ClassSerializerInterceptor`, `TranslatableInterceptor` (Translatable objects to one string per the request locale), `ApiResponseInterceptor` (the `{ data, meta? }` envelope).
- Any error thrown anywhere in that chain ends in `HttpExceptionFilter` (`libs/shared/common/src/filters/http-exception.filter.ts`), which writes `{ error: { code, message, details? } }`.

After the app is built and before it listens, `main.ts` runs `assertFtsIntegrity` (`apps/api/src/bootstrap/fts-integrity.ts`), which refuses to boot a dev or test database whose search column is missing while its trigger is still attached.

## Infrastructure ports

`docker-compose.yml` at the root runs the four development services. The ports are in the 5xxxx range so they clash with nothing else on a laptop.

- `postgres-dev`, host port 55432, database `merchants_engine_dev`.
- `postgres-test`, host port 55433, database `merchants_engine_test`.
- `redis-dev`, host port 56379.
- `redis-test`, host port 56380.

`.env.example` points `DATABASE_URL` and `REDIS_PORT` at the dev pair and `DATABASE_TEST_URL` and `REDIS_TEST_PORT` at the test pair. The application ports are not in the compose file:

- API 53000, and 53001 for the API every e2e harness spawns.
- Admin 53200, and 53211 for the admin e2e dev server.
- Storefront 53300, and 53311 for the storefront e2e dev server.

## The Nx targets

Each app's `project.json` declares the targets `npx nx <target> <project>` runs:

- `api` (`apps/api/project.json`): `build`, `serve`, `start` (the built bundle), `test`, `e2e` (the Supertest suite through `test/jest.e2e.config.ts`, which depends on `build`), `lint` (which also lints `test/`), `prisma-generate`.
- `admin` (`apps/admin/project.json`): `build`, `serve`, `serve-static` (the built bundle from `dist/apps/admin/browser`), `test`, `lint`.
- `storefront` (`apps/storefront/project.json`): `build`, `serve`, `serve-production` (the Nitro build on 53311), `test`, `lint`, `lighthouse`, and the four verifiers that run against the production build: `verify-bundle-budgets`, `verify-ssr-payloads`, `verify-ssr-smoke` (`npm run test:storefront-ssr-smoke`), `verify-font-subsets`.
- Every library has `test` and, outside `libs/shared/`, `lint`. `npm test` runs every `test` target; `npm run lint` runs the API's and the common library's.

## The rest of the tree

- `prisma/`: `schema.prisma`, `migrations/`, the seed (`prisma/seed.ts`), the roles-and-permissions-only seed for a new store (`prisma/seed-roles-only.ts`), the scenario seeds under `prisma/seeds/`, and the SQL that lives outside the schema: `prisma/search_fts_setup.sql` and its applier `prisma/apply-fts-setup.ts`. `prisma.config.ts` at the root holds the database URL and the seed command.
- `test/`: the backend Supertest e2e suite (`test/e2e/`), its global setup and the store-config fixtures under `test/fixtures/store-configs/`.
- `scripts/`: repository scripts and their specs, including the docs-site guard, `scripts/verify-no-client-refs.ts` and the e2e identity guard `scripts/e2e-identity-guard.ts`.
- `deploy/`: the compose and nginx templates the installer renders, and the rendered stack directories git ignores.
- `docs/`: this documentation site under `docs/site/`, including the generated API reference under `docs/site/reference/`, plus the security reports and two pointer files where the hand-written API catalogues used to be.

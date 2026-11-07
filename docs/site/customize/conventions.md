---
title: Conventions
description: "The rules every change to the engine follows, each with the file that enforces it: envelopes, translatable text, permissions and ownership, idempotency keys, soft delete, atomic decrements, sort allowlists, validation, raw SQL, browser caching, session bootstrap and request correlation."
primaryQuery: nestjs ecommerce api conventions response envelope idempotency rbac
updated: 2026-09-09
schema: TechArticle
---

These are not style preferences. Each rule below is enforced by a piece of code that is named with it, and a change that breaks the rule fails a guard, a spec or a request rather than a review. The recipes under this track assume all of them. Where a request runs through the API is on [Repository layout](./repository-layout.md).

## Response and error envelopes

Every successful response is `{ data }`, or `{ data, meta }` when the service returned a page.

- `libs/shared/common/src/interceptors/api-response.interceptor.ts` is a global interceptor that wraps whatever the controller returns. A controller returns the bare value and never builds the envelope itself; `apps/api/src/health/health.controller.ts` records what happened when one did (`{ data: { data } }`).
- A service signals pagination by returning `{ data: T[], meta: { page, pageSize, total, totalPages } }`. The interceptor recognises the shape by the `total` key.
- Money leaves the API as numbers. `libs/shared/common/src/interceptors/decimal-serialization.interceptor.ts` converts Prisma decimals before anything else touches the body.

Every error is `{ error: { code, message, details? } }`. `libs/shared/common/src/filters/http-exception.filter.ts` catches everything:

- An `HttpException` whose body is already `{ error: { code, message } }` is passed through as is. That is how a service throws a stable code the storefront can translate.
- A plain Nest exception gets its code from the status: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `UNPROCESSABLE_ENTITY`, `INTERNAL_SERVER_ERROR`.
- A Prisma `P2002` or `P2003` becomes 409 `CONFLICT`; `P2025` becomes 404 `NOT_FOUND`. Any other error is a 500 that is also reported to Sentry.
- `details` is included outside production only. Every log line the filter writes carries the request's correlation id and a redacted URL.

## Translatable text and locale resolution

Every user-facing text is a `Translatable` JSONB object with a required `default` key and one key per locale (`libs/shared/common/src/interfaces/translatable.interface.ts`). Slugs, SKUs, emails, prices and flags are not translatable. A row is stored whole; nothing resolves a locale inside a service.

`libs/shared/common/src/interceptors/translatable.interceptor.ts` runs on every response and replaces each Translatable with one string:

- The locale comes from `X-Locale` when present, else from `Accept-Language`. `X-Locale` exists because a browser page cannot set `Accept-Language`.
- Three rungs: the requested locale, then the store's default locale, then `default`. A locale the store has not enabled parses to a sentinel that matches no key, so it falls to the store default. No header at all resolves to `default`.
- The enabled set and the default are runtime configuration. `apps/api/src/modules/settings/store-locale.registry.ts` keeps a process-wide snapshot, loaded at boot, replaced on every settings write and re-read every minute.
- `X-Resolve-Locale: false` returns the whole object, which is what an edit form needs. The admin sends it on every call: `libs/admin-services/src/shared/http-options.ts` declares the `ADMIN_RAW_LOCALE` context token with a default of `true`, and `apps/admin/src/app/core/interceptors/accept-language.interceptor.ts` attaches the header whenever the token is set. The storefront never sends it.

Writes are checked against the same snapshot:

- A Translatable DTO extends `TranslatableLocaleKeysDto` (`apps/api/src/common/dto/translatable-locale-keys.dto.ts`); its `IsEnabledLocale` validator refuses a value for a locale the store does not run.
- `apps/api/src/common/translatable-dto-parity.spec.ts` fails a DTO that declares only `default`, because the validation pipe's whitelist would strip every other locale silently.
- `test/e2e/locale-spine.e2e-spec.ts` proves the chain under two store fixtures.

## Permissions and ownership

`apps/api/src/common/session-auth.guard.ts` runs on every route that is not `@Public()`. It resolves the Better Auth session cookie, loads the user with its role and permissions fresh from the database on every request, and sets `req.user = { id, role, permissions }`. A permission change takes effect on the next call. A soft-deleted or deactivated user is refused even with a valid cookie. `@OptionalAuth()` lets an anonymous request through with no `req.user`.

Every admin endpoint carries `@Permissions('<module>:<action>')` from `libs/shared/common/src/decorators/permissions.decorator.ts`:

- `apps/api/src/modules/auth/guards/permissions.guard.ts` answers 403 `AUTH_PERMISSION_INSUFFICIENT` unless the user holds one of the listed strings. `SUPER_ADMIN` passes everything.
- A route with no decorator is open to any signed-in user, so a forgotten decorator is a real hole, not a default.
- The strings come from one catalogue, `libs/shared/permissions/src/index.ts`: twenty-six modules times five actions (`view`, `create`, `update`, `delete`, `manage`).
- `apps/api/src/permission-key-drift.spec.ts` fails in both directions: a controller naming a key outside the catalogue, or a catalogue module that no route enforces. Adding a module means adding it there, mirroring it in `prisma/permission-catalogue.ts` (`apps/api/src/permission-catalogue.parity.spec.ts` checks the copy) and giving it at least one enforcing route.

A customer endpoint that reads or writes one customer's data carries `@OwnerGuard()` (`libs/shared/common/src/decorators/owner-guard.decorator.ts`):

- `libs/shared/common/src/guards/owner-guard.guard.ts` refuses the request when `req.user.id` is missing, and refuses a route that carries both `@OwnerGuard()` and `@Public()`.
- The service then matches the entity's owner against `req.user.id`. That is where a 403 for someone else's order comes from; the guard alone never proves ownership.
- A route that also serves anonymous callers takes `@OptionalAuth()` instead, never both. `apps/api/src/modules/orders/orders.controller.ts` explains the swap above its `POST`.

## Idempotency keys

A sensitive write takes `X-Idempotency-Key` through `@IdempotencyKey(IdempotencyKeyPipe)` (`apps/api/src/common/decorators/idempotency-key.decorator.ts`). The pipe requires the header and validates it as a UUID v4 (`apps/api/src/common/dto/idempotency-key-header.dto.ts`). The routes that carry it:

- Customer and admin order creation, `apps/api/src/modules/orders/orders.controller.ts`.
- Inventory adjust and transfer, `apps/api/src/modules/inventory/inventory.controller.ts`.
- The return refund, `apps/api/src/modules/returns/returns.controller.ts`.
- The manual search-engine submission, `apps/api/src/modules/seo/seo.controller.ts`.
- The webhook test delivery, `apps/api/src/modules/webhooks/webhooks.controller.ts`.
- The payment retry and the payment confirm on an order, `POST /v1/orders/:id/payment` and `POST /v1/orders/:id/payment/confirm`, in `apps/api/src/modules/orders/orders.controller.ts`.

Gift-card redemption is not its own endpoint: `redeem` in `apps/api/src/modules/gift-cards/gift-cards.service.ts` runs inside order creation and rides the order's key.

`apps/api/src/common/idempotency.service.ts` owns the state machine:

- Each `(scope, key)` is stored in Redis under `idemp:<scope>:<hash>` for twenty-four hours (`IDEMPOTENCY_TTL_SECONDS` in `apps/api/src/common/idempotency.constants.ts`), with a hash of the caller and a hash of the body.
- A replay with the same body returns the stored response without running the handler. The same key with a different body is a 409. The same key from a different caller is a 403. A key whose first request is still running reports in-flight.
- When the handler throws, the entry is deleted so a retry can succeed. When Redis is down, the request goes through and the database's unique constraints are the safety net.
- `apps/api/src/common/idempotency.module.ts` is global, so a new module injects the service without importing anything.

## Soft delete

Every model in `SOFT_DELETE_MODELS` (`apps/api/src/prisma/prisma.service.ts`) has a `deletedAt` column and is never hard-deleted.

- The Prisma client is extended so that `findMany`, `findFirst`, `findUnique` and `count` add `deletedAt: null` to the `where`, unless the caller already named `deletedAt`, which is how an admin recovery screen reads deleted rows.
- `count` is on the list because a paginated list whose `meta.total` counted deleted rows rendered an empty last page.
- Better Auth gets the same extended client, so a soft-deleted user cannot sign in.
- A delete endpoint sets `deletedAt` or a status such as `ARCHIVED`. The append-only tables (order items, inventory movements, gift-card transactions, promotion usage, the audit log) are never deleted at all.

## Atomic decrements

A contested number is never read, computed and written back. The write carries its own guard in the `WHERE` clause and the affected-row count is the answer:

- Stock: `decrementStock` in `apps/api/src/modules/inventory/inventory.service.ts` runs `UPDATE "StockLevel" SET "onHand" = "onHand" - qty WHERE ... AND "onHand" >= qty` and returns `false` when no row changed.
- Gift-card balance: `redeem` in `apps/api/src/modules/gift-cards/gift-cards.service.ts` uses `updateMany` with `currentBalance: { gte: amount }` and throws `GiftCardInsufficientBalanceException` on a zero count.
- Promotion usage: `recordUsage` in `apps/api/src/modules/promotions/promotions.service.ts` locks the row with `SELECT ... FOR UPDATE` inside a transaction and re-checks the limits under the lock before inserting the usage row.

## Sort allowlists

A list endpoint sorts only by a column named in a constant the module owns, never by a string taken from the request:

- `VALID_STOCK_SORT_FIELDS` and `VALID_MOVEMENT_SORT_FIELDS` in `apps/api/src/modules/inventory/inventory.constants.ts`; the query DTO also carries them in `@IsEnum`.
- `GIFT_CARD_SORT_FIELDS` in `apps/api/src/modules/gift-cards/gift-cards.constants.ts`, with a default field for anything else.
- `AUDIT_LOG_SORT_FIELDS` in `apps/api/src/modules/audit-log/audit-log.constants.ts`.

A `sortBy` outside the list falls back to the default field or fails validation. It is never interpolated into `orderBy`.

## Validation and sanitisation

`apps/api/src/main.ts` installs one `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true` and `transform: true`:

- A property without a class-validator decorator is stripped. A body carrying an unknown property is refused with 400 `VALIDATION_ERROR`. The body reaches the controller as an instance of its DTO class.
- The failure `details` are flattened by `libs/shared/common/src/utils/validation-errors.ts`, so a nested Translatable error names its field.
- Admin and customer DTOs are separate classes, even for the same entity. `apps/api/src/modules/users/dto/admin/` and `apps/api/src/modules/users/dto/customer/` are the pattern, so a customer can never post a field only staff may set.
- On the admin side every response is parsed by a Zod schema from `libs/admin-types/` before a screen sees it.

Rich text is sanitised on write with `sanitizeRichText` or `sanitizeTranslatableHtml` from `libs/shared/common/src/utils/sanitize-rich-text.ts`: `sanitize-html` with an allowlist of `p`, `br`, `strong`, `em`, `a`, lists and `h1` to `h4`, `https`, `http` and `mailto` links only, and a pass that unwraps a block the editor nested inside a heading. Products, categories, CMS pages, notification templates and campaigns all call it in their service, not in a DTO. A new rich-text field does the same.

## Raw SQL

`$queryRaw` and `$executeRaw` are used where the typed client cannot express the query, and each use is marked as sanctioned in a comment beside it:

- The stock decrement and the `RETURNING` reads in `apps/api/src/modules/inventory/inventory.service.ts`, and the promotion lock, all bind their values through the tagged template.
- The full-text search in `apps/api/src/modules/search/search.service.ts`, where every value is a `Prisma.sql` fragment.
- The order and return number sequences in `apps/api/src/modules/orders/orders.service.ts` and `apps/api/src/modules/returns/returns.service.ts`, the two places that use the `Unsafe` variants: the only interpolated value is a sequence name built from a fixed prefix and the current year.

Nothing builds SQL from request input. A new raw query needs a reviewer and the same comment.

## Browser caching and 304

`apps/api/src/bootstrap/cache-control-hardening.ts`, applied first in `main.ts`, disables Express's ETag and sets `Cache-Control: no-store` on every response before any handler runs.

- The only sanctioned way to cache is `@PublicCacheable(maxAgeSeconds, varyOn?)` (`libs/shared/common/src/decorators/public-cacheable.decorator.ts`), which emits `Cache-Control: public, max-age=N` and a `Vary` header when the body depends on a request header.
- It belongs on a public, read-only route whose body does not depend on the caller: the sitemaps, `robots.txt`, the `llms.txt` files, the geo lookups. Never on a route that carries `@Permissions` or returns customer data.
- A raw `@Header('Cache-Control', ...)` anywhere else is an unreviewed bypass.

Because nothing is cached, a browser should never send `If-None-Match` and a 304 should never arrive. Both clients still treat one as success rather than as an error: `apps/admin/src/app/core/interceptors/error-normalizer.interceptor.ts` turns a 304 into an empty success response before the error mapping, and `libs/storefront-services/src/lib/shared/browser-api-client.ts` returns from a 304 before its `!response.ok` branch. A new client, or a new error mapper, keeps that short-circuit.

## Session bootstrap

Both front ends restore a session with one `getSession()` call and commit it in one step or not at all.

- `apps/admin/src/app/core/session-bootstrap.ts` is an app initializer. It calls `getSession()` and, when a staff user comes back, calls `AuthStore.setSession({ user })` (`apps/admin/src/app/core/stores/auth.store.ts`) once. On `null`, which covers logged-out and transient failures alike, it leaves the store untouched. There is no access token, no `/me` follow-up and no `clearSession()` on the boot path.
- `boot()` in `apps/storefront/src/app/layout/layout-shell.component.ts` does the same for the customer behind the browser-only gate, commits through `apps/storefront/src/app/services/auth-state.service.ts`, and marks the boot settled in a `finally` so consumers wait on the outcome instead of polling.
- A transient 429 or 5xx never logs anyone out. The session is one signed `HttpOnly` cookie; nothing about it is stored in `localStorage`.

## Request ids, secrets and logs

`libs/shared/common/src/middleware/correlation-id.middleware.ts` runs first on every route. It takes `X-Request-Id` from the request or mints a UUID, sets `req.id` and echoes the header back.

- The pino logger configured in `apps/api/src/app.module.ts` uses the same value as the request id on every line, and the exception filter logs it beside every error.
- The admin's `correlation-id.interceptor.ts` sends a fresh id per call and surfaces it in error toasts. The storefront's server client (`apps/storefront/src/server/api-client.ts`) sets one on every SSR call.
- On an installed store the edge forwards the client's id or mints one, so one id follows a request end to end.

Secrets come from the environment only: `.env` on a checkout, the installer-written `.env.production` on a box, never a file in the tree. The API refuses to boot in production without `CORS_ORIGIN`, and without the Resend keys when mail is on.

Logs never carry a credential:

- The logger redacts the `authorization` and `cookie` headers, and request and response bodies are never logged.
- `libs/shared/common/src/utils/log-redaction.ts` blanks any query parameter whose name looks like a secret or personal data (`email`, `phone`, `token`, `password`, `secret`, `api_key`, `signature` and more) and any value shaped like an email address, whatever the parameter is called.
- The idempotency service logs a sixteen-character hash of a key, never the key.
- A new log line follows the same rule: an id, a code, a count, and nothing a person typed.

## Shared constants

Two more single sources keep the API and the front ends in step:

- Every `/v1/admin/*` path is a constant in `libs/shared/admin-routes/src/index.ts`, used by the controller (`@Controller(node.base)`, `@Get(node.sub)`) and by the Angular service that calls it, so a path is spelled once.
- Every storefront route is in `apps/storefront/src/lib/routes.ts`.

Adding an endpoint, a screen or a page starts by adding the constant; the recipes under this track show where.

# themerchantengine

## 1.0.1

Card payment at checkout, with Stripe as the first card provider.

### Minor Changes

- Card checkout. A shopper can pay by card at checkout. Stripe is now
  offered at checkout, in an embedded Payment Element form or on a hosted
  Checkout Session page. Each payment method row picks its `checkoutMode`.
- Provider agnostic payment action. Placing an order answers with a
  `paymentAction`: `none`, `redirect`, `form_post` or `embedded`. The
  storefront has one handler for all four, so a new provider needs no
  storefront change unless it is `embedded`.
- Payment retry and confirm. `POST /v1/orders/:id/payment` starts a fresh
  payment for an unpaid order. `POST /v1/orders/:id/payment/confirm` asks
  the provider for the live status when the shopper comes back. Both need
  `X-Idempotency-Key`. Webhooks stay the source of truth.
- Credentials in the admin. The operator enters the provider keys on the
  payment method form. Secret fields are encrypted at rest (AES-256-GCM)
  with `PAYMENT_CONFIG_ENCRYPTION_KEY`, and old keys can stay readable in
  `PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS`. Without a key, saving a secret
  answers `PAYMENT_CONFIG_ENCRYPTION_UNAVAILABLE` and the app still boots.
  `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PUBLISHABLE_KEY`
  still work as a fallback.
- Several payment methods can be active at once, each with its own keys.
- New stable error codes for conflicts: `CATEGORY_SLUG_TAKEN`,
  `CATEGORY_HAS_PRODUCTS`, `REVIEW_ALREADY_PUBLISHED` and
  `QUESTION_ALREADY_PUBLISHED`.

## 1.0.0

The first public release of the engine, under the MIT License.

### Major Changes

- MIT License. `LICENSE` holds the MIT text and `NOTICE` the copyright and
  the trademark note. The four package files name `MIT`.
- Runtime client config: store identity, brand palette, locale pair, money
  and domains live in `StoreSetting` and are served on `GET /v1/store/config`.
  The storefront renders its tokens, locale routing and money formats from
  it at SSR; the admin renders its editors, money inputs and shell identity
  from it. No client branch, no build per client.
- The install stepper: `./setup.sh` (Linux, macOS) and `./setup.ps1`
  (Windows, local profile) run `tools/setup`, which asks for every
  store-specific value once, verifies storage, mail, bot protection and the
  optional search-engine integrations live, renders the compose stack, the
  nginx vhosts and the timers from `deploy/templates/`, builds the images on
  the box, installs the schema, the seeds and the owner account, issues TLS
  and probes the result. Profiles: `engine`, `storefront`, `both`, `local`.
- Payment providers behind one `PaymentProvider` interface and registry, with
  `cod` and `manual` reference providers and a Stripe example.
- Admin light mode, a semantic token layer, settings screens for identity,
  brand (with a palette preview and contrast report), localization, money
  and domains.
- A brandless tree, guarded by `verify:no-client-refs` on every push, and
  scenario fixtures (`gulf-rtl`, `maghreb-ltr`, `demo`) every locale, money
  and e2e matrix runs against.
- Deploy templates with no client value, an operator manual at
  `deploy/README.md`, a generic GitHub Actions pipeline with an install
  smoke job, secret scanning, and `npm run release`.
- Migration: `20261027120000_drop_license_rows` deletes the `license:*`
  `RolePermission` rows and the `license` `StoreSetting` rows left by
  pre-release installs. A setup answers file that still carries a `license`
  key warns once and the key is ignored.

## Pre-release history

Internal work before the engine became a product, kept for reference.

### Minor Changes

- Phase 20, Notifications + Global search: shipped NotificationTemplate +
  NotificationLog Prisma models, `/v1/admin/notifications/{templates,log,log/:id/resend}`
  CRUD, `/v1/admin/search` cross-entity fan-out, 3 notification admin
  screens, a Cmd+K global search overlay replacing the nav-only palette,
  and a `/search` full-page results route. 15 new api unit tests
  (958 total), 30 new admin tests (484 total).

  Phase 21, Quality gates: tightened admin bundle budgets (900 kB
  initial error ceiling, 80 kB main-bundle guard), whitelisted
  sanitize-html CJS, shipped `lighthouserc.json` + GitHub Actions
  workflow running lint + test + budget + Lighthouse on every admin
  PR. Local LHCI known-broken on Windows+Node 22; documented as
  CI-only.

  Phase 22, Docs + handoff: README rewritten to cover the full Nx
  monorepo; `docs/deployment.md` §13 added for admin static-host +
  SPA fallback + CSP + cookie scoping; `/dev/design-system` demo
  extended with every primitive shipped after Phase 3 (Icon, KPI card,
  Sparkline, Tab strip, Translatable input, Rich text editor, Dropzone).

  Sentry wiring: env-var-driven init on both apps, inert without a DSN.
  `captureException` called from `HttpExceptionFilter` on unmapped
  Prisma/unknown errors and from `GlobalErrorHandler` on uncaught +
  5xx ApiError. PII scrubbed in `beforeSend`.

  Changesets tooling: wired `@changesets/cli` for CHANGELOG generation.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/logo-dark.svg">
    <img src="docs/assets/readme/logo-light.svg" alt="The Merchant Engine" width="420">
  </picture>
</p>

<p align="center">
  The Merchant Engine, open-source self-hosted ecommerce: a NestJS API, an Angular admin and an SSR storefront. French, English and Arabic (RTL), cash on delivery, one-command install. MIT.
</p>

<p align="center">
  If this is useful, a star helps others find it. Tell me what is missing in the <a href="https://github.com/Xdabier/themerchantengine/discussions/25">feedback discussion</a>.
</p>

<p align="center">
  <a href="https://demo.themerchantengine.com">Storefront demo</a> ·
  <a href="https://demo-admin.themerchantengine.com">Admin demo</a> ·
  <a href="https://themerchantengine.com/docs">Docs</a> ·
  <a href="docs/site/getting-started/install-locally.md">Try it locally</a> ·
  <a href="https://github.com/Xdabier/themerchantengine/discussions">Discussions</a> ·
  <a href="https://badii.studio/themerchantengine">Have it built and run for you</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://github.com/Xdabier/themerchantengine/actions/workflows/ci.yml"><img src="https://github.com/Xdabier/themerchantengine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Xdabier/themerchantengine/releases"><img src="https://img.shields.io/github/v/release/Xdabier/themerchantengine" alt="Latest release"></a>
  <a href="https://github.com/Xdabier/themerchantengine/commits"><img src="https://img.shields.io/github/last-commit/Xdabier/themerchantengine" alt="Last commit"></a>
  <a href="https://github.com/Xdabier/themerchantengine/stargazers"><img src="https://img.shields.io/github/stars/Xdabier/themerchantengine" alt="Stars"></a>
  <a href="https://github.com/Xdabier/themerchantengine/issues"><img src="https://img.shields.io/github/issues/Xdabier/themerchantengine" alt="Issues"></a>
  <a href="https://www.opensourcealternatives.to"><img src="https://www.opensourcealternatives.to/badge-osa.svg" alt="As seen on Open Source Alternatives" height="20"></a>
  <a href="https://www.saashub.com/the-merchant-engine?utm_source=badge&utm_campaign=badge&utm_content=the-merchant-engine&badge_variant=color&badge_kind=approved"><img src="https://cdn-b.saashub.com/img/badges/approved-color.png?v=1" alt="The Merchant Engine badge" width="150"></a>  <img src="https://img.shields.io/badge/node-22-339933.svg" alt="Node 22">
</p>

<p align="center">
  <a href="https://www.producthunt.com/products/the-merchant-engine"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1297939&theme=light" alt="The Merchant Engine on Product Hunt" width="250" height="54"></a>
</p>

<p align="center">
  <img src="docs/assets/readme/checkout.gif" alt="A cash on delivery order on the storefront demo, from the home page to the order confirmation" width="720">
</p>

## Why

- **One generic build.** Every store-specific value (identity, brand, locales, currency, domains, third-party keys) is entered once through the install stepper and lives in the database and the environment. No fork per client.
- **The whole stack in one repository.** API, admin and storefront share one schema, one set of types and one test suite, so a change lands everywhere at once.
- **Built for agencies.** A developer with a server, a bucket, a domain and the third-party accounts ready goes from clone to a live, empty store in one sitting.
- **MIT.** Use it for any store, paid or not. No license key, no tiers, no caps.

## Screenshots

<table>
  <tr>
    <td><img src="docs/assets/readme/admin-dashboard.png" alt="Admin dashboard"></td>
    <td><img src="docs/assets/readme/admin-product-edit.png" alt="Admin product editor"></td>
  </tr>
  <tr>
    <td><img src="docs/assets/readme/storefront-home.png" alt="Storefront home page"></td>
    <td><img src="docs/assets/readme/storefront-product.png" alt="Storefront product page"></td>
  </tr>
</table>

## Features

- **Catalogue:** products, variants, categories, inventory, reviews and full-text search. See [What you get](docs/site/getting-started/what-you-get.md).
- **Orders:** cart, checkout, orders, returns, invoices, gift cards and promotions. See [Checkout and orders](docs/site/build-a-storefront/05-checkout-and-orders.md).
- **Content:** CMS pages, home sections, SEO and translatable fields in every locale you enable. See [Content and sections](docs/site/build-a-storefront/07-content-and-sections.md).
- **Payments:** cash on delivery, manual bank transfer and gift cards. A Stripe example provider (`STRIPE_API_KEY`) shows the card seam but is not offered at checkout yet. See [What you get](docs/site/getting-started/what-you-get.md).
- **Mail:** Resend (`RESEND_API_KEY`), plus a console transport that logs mail in development. See [Environment variables](docs/site/reference/environment-variables.md).
- **Storage:** local disk or any S3-compatible bucket (`S3_BUCKET`). See [Install on a server](docs/site/getting-started/install-on-a-server.md).
- **Shipping:** zones and methods with the rates you enter in the admin, and a carrier list for tracking links. See [Store settings](docs/site/operate/store-settings.md).
- **Admin:** Angular 21 with signals, `@angular/cdk` and Tailwind 4.3, themed at runtime from the store's brand settings. See [Store settings](docs/site/operate/store-settings.md).
- **Storefront:** Analog SSR with locale routing and a documented API contract, so you can also [build your own](docs/site/build-a-storefront/index.md).
- **Roles and permissions:** granular admin permissions, listed in [Permissions](docs/site/reference/permissions.md).

Planned, not built yet:

- A card payment provider offered at checkout.
- More mail adapters, such as SMTP.
- Live shipping adapters that fetch carrier rates and labels.

## Quickstart

With Node 22 and Docker installed, three commands give you a local store:

```bash
git clone https://github.com/Xdabier/themerchantengine.git
cd themerchantengine
./setup.sh --local                 # or ./setup.ps1 on Windows
```

The stepper asks for the store's identity, brand, locales, money and owner account, then starts the stack. [Install locally](docs/site/getting-started/install-locally.md) walks through each question.

To work on the engine itself, run the services from source:

```bash
npm install && npm run docker:up && cp .env.example .env
npm run db:setup && SEED_DEV_OK=1 npm run db:seed
npx nx serve api                   # then admin and storefront in two more terminals
```

Sign in to the admin at `http://localhost:53200` as `superadmin@merchants.test` with `Admin123!`. [Development environment](docs/site/customize/development-environment.md) covers the env file, the test stack, everyday commands and what to do when the checkout misbehaves.

## Architecture

```mermaid
flowchart LR
  shopper([Shopper]) --> storefront[Storefront<br/>Analog SSR]
  staff([Store staff]) --> admin[Admin<br/>Angular 21]
  storefront -->|/api/v1| api[API<br/>NestJS modular monolith]
  admin -->|/api/v1| api
  api --> pg[(PostgreSQL<br/>Prisma 7)]
  api --> redis[(Redis<br/>cache and BullMQ)]
  redis --> workers[Workers<br/>mail, media, sitemaps, webhooks]
  api --> storage[(Local disk<br/>or S3)]
  api --> stripe[Stripe]
  workers --> resend[Resend]
```

The API is one NestJS process split into modules that never touch each other's tables. The storefront reads the store's identity, brand, locales and money from `GET /v1/store/config` at runtime, so one build serves every store. [Topology](docs/site/operate/topology.md) shows how the pieces sit on one or two servers.

## Repository layout

```
themerchantengine/
├── apps/
│   ├── api/              # NestJS backend (port 53000)
│   ├── admin/            # Angular 21 admin (port 53200)
│   └── storefront/       # Analog.js SSR storefront (port 53300)
├── libs/                 # shared types, services and UI for the apps
├── prisma/               # schema and seeds
├── tools/setup/          # the install stepper behind setup.sh
├── docs/site/            # the documentation site
└── scripts/              # setup, release and maintenance scripts
```

[Repository layout](docs/site/customize/repository-layout.md) explains every folder and the rules each app follows.

## Documentation

The full guide lives at [themerchantengine.com/docs](https://themerchantengine.com/docs). Its source is [docs/site/](docs/site/):

- [Getting started](docs/site/getting-started/): what to have ready, what the stepper asks and the first hour after install.
- [Operate](docs/site/operate/): updates, rollback, backups, TLS, logs and store settings.
- [Customize](docs/site/customize/): the development environment, conventions, testing and gates, and releasing your fork.
- [Build a storefront](docs/site/build-a-storefront/): the storefront API contract, step by step.
- Reference: [environment variables](docs/site/reference/environment-variables.md), [CLI](docs/site/reference/cli.md), [error codes](docs/site/reference/error-codes.md), the [admin API](docs/site/reference/admin-api/) and the [storefront API](docs/site/reference/storefront-api/).
- [Troubleshooting](docs/site/getting-started/troubleshooting.md) for install problems.

## Deploy

Two commands on a prepared Linux box:

```bash
git clone https://github.com/Xdabier/themerchantengine.git /srv/themerchantengine
cd /srv/themerchantengine && ./setup.sh --profile engine
```

Use `--profile storefront` on a second box, or `--profile both` to run everything on one. The stepper verifies each third-party integration live, installs the stack and ends with `backend server installed successfully!` or `storefront server installed successfully!`, the admin URL and the owner login. A release tarball works the same way and skips the stepper build.

Read [Install on a server](docs/site/getting-started/install-on-a-server.md) first, then the [go-live checklist](docs/site/getting-started/go-live-checklist.md).

## Contributing, security and community

- [CONTRIBUTING.md](CONTRIBUTING.md) explains how to propose a change. Run `npm run gate` before you open a pull request; the public tree installs no git hooks.
- [ROADMAP.md](ROADMAP.md) lists what is planned next and which issues are open for contributors.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability privately. Please do not open a public issue for one.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to every space of the project.
- Questions and ideas go to [Discussions](https://github.com/Xdabier/themerchantengine/discussions). Feedback, good or bad, goes to the [feedback discussion](https://github.com/Xdabier/themerchantengine/discussions/25). Bugs go to [Issues](https://github.com/Xdabier/themerchantengine/issues). If you tried to install it, the "I tried to install it" template takes two minutes.
- Every release is listed in the [CHANGELOG](CHANGELOG.md).

## Need it built or run for you?

The engine is free to use on your own. If you would rather not run it yourself, hire Badii Boutar, who builds the engine and works as [Badii Studio](https://badii.studio/themerchantengine). He installs, customizes, hosts and maintains stores built on it. Write to badii@badii.studio.

## License

themerchantengine is licensed under the MIT License. See [LICENSE](LICENSE) for the terms and [NOTICE](NOTICE) for the copyright and trademark note. Questions go to Badii Studio at badii@badii.studio.

## Contributors

<a href="https://github.com/Xdabier/themerchantengine/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Xdabier/themerchantengine" alt="Contributors">
</a>

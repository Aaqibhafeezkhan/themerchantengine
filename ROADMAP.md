# Roadmap

The Merchant Engine is built and maintained by one person, Badii Boutar. This roadmap only lists what one maintainer plus contributors can carry. It changes after each release, and changes are logged at the bottom instead of being deleted.

Every item links to an issue or a discussion. If an item has no link, it is not started.

## How to read it

- **Shipped**: released, with the version that carried it.
- **Now**: being worked on. Issues are open and claimable.
- **Next**: agreed and ordered, no date. Badii builds the base first, then adapter issues open for contributors.
- **Later**: agreed direction, no date. Design happens in a discussion first.
- **Exploring**: ideas from users and contributors. Nothing here is promised.

Versions are attached only to what has shipped. A release that adds a payment adapter bumps the third number (1.0.2, 1.0.3 and so on).

## Shipped

- **v1.0.1: card payment at checkout.** Stripe is offered at checkout, embedded or hosted. The operator enters the keys in the admin and secrets are encrypted at rest. More providers plug in behind the same `PaymentProvider` interface.
- **v1.0.0: first public release** under the MIT License.

## Now

Goal: make the first contribution easy and fast to review.

- **Payment adapters.** Each provider is its own issue: Mollie, PayPal, Paymob, Konnect, Flouci, Tap and CMI. One class behind `PaymentProvider`, one line in `PAYMENT_PROVIDER_IMPLEMENTATIONS`, and the conformance suite must pass. See [Add a payment provider](docs/site/customize/recipes/api/add-a-payment-provider.md). Label: `help wanted`, `payments`.
- **Admin services fail cleanly on bad input.** Many admin services validate with `schema.parse()` before the Observable exists, so bad input throws instead of reaching the error handler. One issue per service, released in small batches. Label: `good first issue`.
- **More storefront languages.** The storefront ships French, English and Arabic. Adding a language is one registry entry plus a string file, and a partial file is fine because missing keys fall back to the default language. Spanish, German, Turkish and Portuguese are open first. Label: `good first issue`, `i18n`.
- **Install and docs fixes.** Every install report that hits a wall becomes a docs issue. Label: `documentation`.

## Next

- **Mail transport interface.** Badii adds a transport interface so Resend is one adapter among others. Then an SMTP adapter opens for contributors. Label: `help wanted`, `mail`.
- **Deploy guides.** One guide per host, written and tested by someone who deployed there (Hetzner, DigitalOcean, Railway, Coolify, a plain VPS). Label: `documentation`, `help wanted`.

## Later

- **Live shipping rates and labels.** An interface for carrier rates and label printing, then one adapter per carrier.
- **Extensions.** A documented way to add a module, a payment provider or a shipping adapter without forking. Design starts in a discussion.
- **Admin translations.** The admin is English only today. The storefront language registry is the starting point.

## Exploring

Ideas live in the [Ideas discussions](https://github.com/Xdabier/themerchantengine/discussions/categories/ideas). React with 👍 on the ones you want. After each release, Badii reads the top ideas and moves some to Later or Next, with a short reason on the discussion.

Votes help, but they do not decide alone. Fit with the engine and the cost of keeping it working both count.

## How to take an issue

- Comment on the issue to claim it. Badii assigns it to you, usually the same day.
- One open claim per person at a time.
- A claim with no pull request or update after 7 days goes back to open. Ask for more time if you need it, that is fine.
- Every bug fix starts with a test that fails before the fix.
- If you used an AI tool, say so in the pull request. It is allowed. A pull request that does not match its issue is closed without debate.

## Change log

- 2026-10-30: first version.
- 2026-11-07: card checkout shipped in v1.0.1. Dropped the v1.1 milestone and the date ranges. Sections are now Shipped, Now, Next, Later. Payment adapters moved to Now as one issue per provider.

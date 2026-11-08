---
title: Install on a server
description: Install the engine on a prepared Linux box with the setup CLI. The two-box and one-box runs, every prompt in order with its default and its live check, what the installer writes, what it does, and how a run resumes.
primaryQuery: self hosted ecommerce docker install
updated: 2026-09-08
schema: HowTo
---

Two commands install a store on a prepared Linux box. This page is the operator's view of that run: what to have ready, every prompt in the order it comes with its default and what it verifies, what the installer writes and does, the lines it ends with, and how a failed run resumes.

## Before you start

Have everything on the [Requirements](./requirements.md) page ready: the box with Docker, Compose v2, git and Node 22; the three hostnames pointing at the box; the bucket, the Resend domain and webhook secret, the Turnstile keys; and, if you want them, the IndexNow key, the Bing key and the Search Console service account. The installer verifies each one live and stops at the first that is not ready, so a missing item costs a prompt, not an install.

The installer never touches SSH, the firewall or the OS. Those stay the checklist of whoever prepared the box.

## Install on two boxes

On the engine box, which serves `admin.<apex>` and `api.<apex>`:

```bash
git clone <the engine repository> /srv/themerchantengine
cd /srv/themerchantengine
./setup.sh --profile engine
```

The run ends with:

```
backend server installed successfully!
admin: https://admin.shop.example/
owner login: owner@shop.example
storefront box: run setup with --profile storefront; when it asks for the revalidate secret, read it with: grep STOREFRONT_REVALIDATE_SECRET .env.production
```

On the storefront box, which serves the apex and `www`:

```bash
git clone <the engine repository> /srv/themerchantengine
cd /srv/themerchantengine
./setup.sh --profile storefront
```

This run asks for the engine's public API origin, the revalidate secret the engine box's closing line named, and the Turnstile site key the engine was configured with. It ends with:

```
storefront server installed successfully!
storefront: https://shop.example/
```

## Install on one box

```bash
git clone <the engine repository> /srv/themerchantengine
cd /srv/themerchantengine
./setup.sh --profile both
```

One compose project, one edge, one certificate per host. Both closing blocks print at the end. A release tarball extracted to the same path works the same way and skips the stepper build, because the built stepper ships inside it.

## What the wrapper checks first

`setup.sh` refuses to start until the box has what it needs, one instruction per missing item: a complete clone (it reads the Node major from `.nvmrc`), git, Docker Engine reachable as your user, the Compose v2 plugin, Node at the major the engine pins (22), and, for a server profile, ports 80 and 443 free. A re-run on an installed box finds this project's own edge on those ports; that is the expected state, and the port check is skipped when a container named `themerchantengine-*` is running. It then builds the stepper from its own small lockfile when the built copy is missing or older than its sources, and runs it.

## What the stepper asks, in order

Every prompt shows its default in brackets. Enter keeps it. A re-run defaults every prompt to the previous answer, so changing one value is a series of Enter presses up to it.

1. **Profile and box role.** `engine`, `storefront`, `both` or `local`. Answered by `--profile`.
2. **Store identity.** Store name, brand name (one word, rendered verbatim), one-line description, legal entity name, contact email, contact phone (E.164 or empty), street address, city, region, postal code, country as a two-letter code, business type.
3. **Domains.** The storefront origin, then the admin and API origins defaulting to `https://admin.<apex>` and `https://api.<apex>`, and the email Let's Encrypt writes to. Each host this box serves is resolved and compared with the box's own addresses; a host that resolves elsewhere stops the run with the address it found. A storefront box is asked here for the engine's API origin and the sixty-four-character revalidate secret.
4. **Brand.** A primary colour, an optional secondary and accent (hex), with a palette preview and a contrast report in the terminal; a palette that cannot reach the contrast floor is refused with the pair that failed. Then the font kit (`latin-rounded`: Baloo 2, Inter and JetBrains Mono; `arabic-latin`: Cairo, Tajawal and Nunito) and an optional logo file (PNG or SVG), uploaded to the bucket by the installer.
5. **Locales and timezone.** Which of the languages in the engine's language registry (`fr`, `en` and `ar` out of the box) the store serves, the default among them, and the IANA timezone. Enabling Arabic switches the brand to the Arabic-capable font kit when the brand step chose the other, and says so.
6. **Currency, tax and shipping.** The ISO 4217 code, the symbol as shown on prices, its position (before or after the amount), the decimal and thousands separators, the decimals shown on prices, the VAT rate as a percent (0 for none), how prices show tax (`TTC` including tax, `HT` excluding it, or no mention), and the domestic flat shipping rate.
7. **Asset storage.** Endpoint, region, bucket (hyphens, no dots), the public URL prefix, the access key and the secret key. Proven by a put, a get and a delete of a probe object.
8. **Transactional mail.** Sender address and display name, reply-to, the address the contact form is delivered to, the Resend API key, the webhook signing secret, and the address a test message is sent to. The sending domain is looked up in the account and must be `verified`; the test message must send.
9. **Turnstile.** The site key and the secret key. The secret is proven against Cloudflare's verification endpoint. A storefront box is asked for the site key only.
10. **Search-engine submission.** All optional: the IndexNow key, the Bing Webmaster API key (proven by a sites call), the Search Console service-account JSON file and the property it has access to (proven by a sitemaps list). Empty answers skip; sitemaps and `robots.txt` work without them.
11. **Payment methods.** Cash on delivery (default yes), manual bank transfer (default no), Stripe (default no). If you answer yes, the stepper asks for the Stripe secret key and the webhook signing secret and writes them to the environment as `STRIPE_API_KEY` and `STRIPE_WEBHOOK_SECRET`. The API uses them as a fallback. Keys entered later on the payment methods page of the admin are encrypted in the database and win over the environment. You can also leave Stripe off here and set it up in the admin after the install. With every method off, the store cannot take an order until one is switched on in the admin, and the stepper says so.
12. **Admin owner account.** Email, first and last name, and a password of twelve or more characters with a lower-case letter, an upper-case letter and a digit. This is the first Super Admin.
13. **Demo catalogue.** Whether to seed the demonstration catalogue (products, categories, a customer, sample orders). Default no on a server; a yes warns that the store serves fictional products until they are deleted.
14. **Summary and confirm.** Every answer in one block, secrets masked, and one question: install with these answers? A no ends the run without writing anything; run setup again to change an answer.

## What it writes

- `.env.production` on an engine or both box and `apps/storefront/.env.production` on a storefront or both box, mode `0600`, every value quoted, nothing left to fill in. Generated secrets (database and Redis passwords, the session secret, the signed-URL secret, the unsubscribe secret, the revalidate secret) live here and nowhere else.
- `client.config.json`, the store's runtime configuration, parsed by the same schema the public config endpoint serves. The seed writes it into the settings rows before anything reads them.
- `deploy/engine/` or `deploy/storefront/`: the rendered compose file, the nginx vhosts, a `config/` directory with the logo and the optional service-account file, the IndexNow key file, and the systemd units for the backup timer. Rendered from `deploy/templates/`; a run rewrites them, so a hand edit does not survive a re-run.
- `.setup-state.json`: the answers and the completed steps, so a run resumes. It never holds a secret; the environment files do.

All of these are ignored by git, as is any `answers*.json` document, which may hold secrets. The two committed example documents hold placeholders. The document the engine's own CI installs from, `ci/answers.local.json` in the repository (it is left out of the release tarball), carries a public owner password that the stepper refuses on every profile but `local`, so it cannot be used as a server template by accident.

## What the install does

The install runs after the summary, in this order, printing each step as it starts:

1. Writes the environment, the store configuration and the rendered stack.
2. Publishes the logo to asset storage, when one was given.
3. Builds the API, admin and storefront images from source. This is the long step: the images compile the three applications, and a first build on a small box takes most of the run.
4. Starts Postgres and Redis, creates the application role and database.
5. Pushes the schema, then re-applies the full-text search index and the extra indexes the schema push cannot express.
6. Seeds the store configuration, roles and permissions, notification templates, tax and shipping zones and the payment methods from your answers, and the demo catalogue if asked for.
7. Creates the owner account.
8. Starts the edge on port 80, issues each certificate through certbot's webroot challenge, enables the TLS vhosts, and starts the whole stack. Nothing answers on a public port before the store's accounts are the ones you chose.
9. Installs the certificate renewal timer and the nightly database dump timer.
10. Probes the API health endpoint, the public store configuration, the admin login page with its security headers, and the storefront, retrying for a minute, and fails the install if any probe does not answer as expected.

A first install on a laptop with Docker Desktop, the profile that skips certificates, measured seven minutes end to end; a re-run of the same install completed every step in twenty-six seconds. A server run adds the certificate issuance, which is seconds when DNS is right.

## A failed run resumes

Every step is idempotent. When a question's live check fails, the stepper prints the step and the cause and stops before writing anything. When an install step fails, it prints the step and the cause, and:

```
fix the cause and run setup again; completed steps are kept
```

In both cases, run `./setup.sh` again with the same profile: the prompts default to your previous answers, secrets are kept, issued certificates are skipped, the owner account is left as it is, and the demo catalogue, a first-install step, never runs again on a store that has a user, whatever the answer says. [Troubleshooting](./troubleshooting.md) lists every line the wrapper and the stepper print when they stop, with the fix.

## Without a terminal

`./setup.sh --profile both --answers answers.json` runs the same install from a JSON document and asks nothing. `--dry-run` prints every file and command a run would produce without running anything. [Non-interactive runs and CI](./non-interactive-and-ci.md) has the document's shape and the flags.

## Changing a value later

Identity, brand, locales, money and domains are editable in the admin's settings screens; the runtime configuration belongs to the store after the install. Environment values (keys, secrets, origins) change by running setup again: answer Enter up to the value you change. [Store settings](../operate/store-settings.md) says which value lives where.

## After the closing line

Sign in as the owner and follow [The first hour](./first-hour.md). Before customers arrive, walk the [go-live checklist](./go-live-checklist.md). Everything after that is the [Operate](../operate/topology.md) track.

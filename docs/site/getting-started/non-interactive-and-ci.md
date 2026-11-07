---
title: Non-interactive runs and CI
description: Run the installer without a terminal from a JSON answers document, preview a run with --dry-run, start over with --reset, understand what the state file holds and never holds, and see the CI install smoke the engine runs on itself as a worked example.
primaryQuery: ecommerce setup script non-interactive ci
updated: 2026-09-08
schema: HowTo
---

Every prompt the installer asks has a path in a JSON document, so the same install runs from a file with no terminal: in CI, from a provisioning tool, or to reproduce a store on a second box with the same answers. This page is the document's shape, the flags, and the pipeline the engine runs on itself.

## The answers document

```bash
./setup.sh --profile both --answers answers.json
```

The document has the shape of `tools/setup/answers.server.example.json` in the repository (`answers.local.example.json` for the local profile). Abridged:

```json
{
  "profile": "both",
  "identity": {
    "storeName": { "default": "Atlas", "fr": "Atlas", "en": "Atlas" },
    "brandName": "atlas",
    "description": { "default": "Outdoor gear for the coast" },
    "legalName": { "default": "Atlas SAS" },
    "contactEmail": "hello@atlas.example",
    "contactPhone": "+33100000000",
    "street": { "default": "1 Rue de la Demo" },
    "locality": "Lyon",
    "region": "Auvergne-Rhône-Alpes",
    "postalCode": "69001",
    "country": "FR",
    "businessType": "OnlineStore"
  },
  "domains": {
    "storefront": "https://atlas.example",
    "admin": "https://admin.atlas.example",
    "api": "https://api.atlas.example",
    "certbotEmail": "ops@atlas.example"
  },
  "brand": { "primary": "#1F4E79", "secondary": "#F2B441", "accent": "", "fontKit": "latin-rounded", "logoPath": "" },
  "localization": { "supportedLocales": ["fr", "en"], "defaultLocale": "fr", "timezone": "Europe/Paris" },
  "money": {
    "currencyCode": "EUR", "symbol": "€", "symbolPosition": "after",
    "decimalSeparator": ",", "thousandsSeparator": " ", "displayPrecision": 2,
    "vatPercent": 20, "taxDisplay": "TTC", "shippingFlatRate": 7
  },
  "storage": { "endpoint": "https://s3.<region>.<provider>", "region": "<region>", "bucket": "atlas-assets", "publicUrl": "https://atlas-assets.s3.<region>.<provider>", "accessKey": "...", "secretKey": "..." },
  "mail": { "fromEmail": "noreply@atlas.example", "fromName": "Atlas", "replyTo": "hello@atlas.example", "contactFormRecipient": "hello@atlas.example", "apiKey": "re_...", "webhookSecret": "whsec_...", "testRecipient": "ops@atlas.example" },
  "turnstile": { "siteKey": "0x...", "secretKey": "0x..." },
  "seo": { "indexNowKey": "", "bingApiKey": "", "gscServiceAccountFile": "" },
  "payments": { "cod": true, "manual": false, "stripe": false },
  "owner": { "email": "owner@atlas.example", "firstName": "Ada", "lastName": "Atlas", "password": "..." },
  "demoCatalogue": false
}
```

Text fields the storefront renders (`storeName`, `description`, `legalName`, `street`) are objects with a `default` key and one key per locale. A storefront-only box adds `"engine": { "apiUrl": "https://api.atlas.example", "revalidateSecret": "<64 hex characters>" }` and gives `turnstile` the site key only.

Three rules decide what happens with a path:

- A path the document answers is used, and validated the way the prompt would validate it. A wrong value ends the run naming the path and the rule it broke.
- A path the document leaves out falls back to the prompt's default, when the prompt has one: the admin origin defaults to `https://admin.<apex>`, cash on delivery to `true`, the demo catalogue to `false` on a server.
- A path with no answer and no default ends the run naming the path, before anything is written.

The document may hold secrets, so keep it out of git and off the box once the install is done. The state file never copies them.

When stdin is not a terminal and no document was given, the stepper stops at once:

```
stdin is not a terminal and no --answers document was given; nothing can answer the stepper
```

## The flags

```
--profile <engine|storefront|both|local>  What this box runs. Asked when omitted.
--local                                   Shorthand for --profile local.
--answers <file.json>                     Non-interactive run from an answers document.
--dry-run                                 Print every file and command; write and run nothing.
--state <file>                            Resumable state file (default .setup-state.json).
--root <dir>                              Repository root (default: the current directory).
--reset                                   Ignore the state file and start over.
--help                                    This text.
--version                                 The engine version.
```

`./setup.sh --help` prints the same list. On Windows, `setup.ps1` takes `-Answers`, `-DryRun`, `-Reset` and `-State`, and always installs the local profile.

## Preview a run with --dry-run

```bash
./setup.sh --profile engine --answers answers.json --dry-run
```

The stepper asks (or reads) every answer, skips the live checks that need the network (the S3 probe, the Resend lookup and test message, the Turnstile and search-engine calls), and then prints every file the install would write and every command it would run, in order, without touching the box. A file that carries secrets is listed but its contents are withheld, and a secret-shaped line anywhere else is redacted, so the output is safe to paste into a review. The smoke step lists the URLs a real run would hold the install to.

## Resume, or start over

The stepper writes `.setup-state.json` after every completed step. It holds the non-secret answers and the list of completed steps, so a crash, a Ctrl-C or a failed live check resumes at the step it stopped on, with every earlier answer offered as the default. It never holds a password, a key or a generated secret: those live in the environment file the installer writes with mode `0600`, and a resumed run reads them back from there.

A run without a terminal takes every answer from its `--answers` document and none from the state file, so a field the document leaves out gets its default, not the value an earlier run saved.

`--reset` ignores the state file and asks everything again. `--state <file>` puts the state file elsewhere, which matters when one checkout installs more than one profile.

An install that already ran is safe to run again with the same document: every step is idempotent, secrets and certificates are kept, and the run ends with the same closing lines. That is how a store is updated, and it is what the engine's own CI asserts.

## Worked example: the CI install smoke

The engine's pipeline installs itself on every push, under the local profile on a plain Ubuntu runner with Docker, from the committed document `ci/answers.local.json` (in the repository; it is left out of the release tarball). Its owner password is public, which is why the stepper refuses that exact password on every profile but `local`. The job, trimmed to its steps:

```yaml
install-smoke:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
    - name: Install, local profile
      run: ./setup.sh --profile local --answers ci/answers.local.json
    - name: Probe the installed store from outside the installer
      run: |
        curl -fsS http://localhost:53000/health | grep -q '"ok"'
        curl -fsS http://localhost:53000/api/v1/store/config | grep -q '"identity"'
        curl -fsS -D - -o /dev/null http://localhost:53200/ | grep -qi '^x-frame-options: DENY'
        curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:53300/ | grep -qE '^(200|30[0-9])$'
    - name: Install again, a re-run must be a no-op that ends the same way
      run: |
        ./setup.sh --profile local --answers ci/answers.local.json | tee second-run.log
        grep -q 'backend server installed successfully!' second-run.log
        grep -q 'storefront server installed successfully!' second-run.log
    - name: Tear down
      if: always()
      run: docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/.env down -v --remove-orphans
```

The same shape works for a server in your own pipeline: check out the tag, run `./setup.sh --profile both --answers <document from your secret store>`, and probe the four URLs over TLS. Keep the document in the pipeline's secret store, never in the repository, and give the job the seventy-five minutes the engine's own job allows for three image builds on a small runner.

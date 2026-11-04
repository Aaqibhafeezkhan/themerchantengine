# syntax=docker/dockerfile:1.7
# ────────────────────────────────────────────────────────────────────────────
# merchants-engine API (NestJS), production image
# Build context: repo root.  Build:
#   docker build -f apps/api/Dockerfile -t merchants-engine/api:<tag> .
# ────────────────────────────────────────────────────────────────────────────
ARG NODE_VERSION=22-bookworm-slim

# ── Stage 1: deps (cache target — only re-runs when package.json changes) ──
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
# Harden `npm ci` against transient registry errors on a shared CI network.
# Five retries absorb a reset connection; a 2-min per-request ceiling makes a
# socket that stalls mid-transfer fail fast and retry on a fresh connection
# instead of freezing the build. `--no-audit --no-fund` skip the post-install
# audit request, which the build never needs.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=60000 \
    NPM_CONFIG_FETCH_TIMEOUT=120000
COPY package.json package-lock.json prisma.config.ts .npmrc ./
COPY prisma ./prisma
# `npm ci` runs the root prepare hook; it exits 0 here, with no .git.
COPY scripts/install-git-hooks.mjs ./scripts/
RUN npm ci --include=dev --no-audit --no-fund

# ── Stage 2: build (compile api + generate prisma client) ─────────────────
FROM deps AS build
WORKDIR /app
# NestJS Webpack build + ts-loader on 26 modules sits well under 2 GB
# today, but the storefront and admin builds both need 4 GB on a small CI
# runner. Standardize the heap budget across all three so a
# slow climb in module count never silently OOMs the api stage.
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY tsconfig.base.json tsconfig.json nx.json jest.config.ts jest.preset.js .eslintrc.js ./
COPY apps/api ./apps/api
COPY libs ./libs
COPY test ./test
RUN npx prisma generate
RUN npx nx build api && rm -f dist/apps/api/openapi-export.js

# ── Stage 3: runtime (slim image, prod deps only) ─────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    # /app is root-owned (no chown -R for build perf), so npx cannot write
    # its default cache at /app/.npm when running as the unprivileged
    # `app` user. Point npm cache at /tmp which is world-writable. Affects
    # every npx invocation: prisma db seed, create-admin.ts, etc.
    NPM_CONFIG_CACHE=/tmp/.npm \
    # Skip ts-node type-checking in prod. The runtime image installs only
    # production deps via `npm ci --omit=dev`, so @types/* aren't present
    # and ts-node TS7016's on the first untyped import (`bcrypt` etc.).
    # Type checking is already enforced in CI's `lint` + `build` stages —
    # the prod container just needs the JS to execute.
    TS_NODE_TRANSPILE_ONLY=true
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app && useradd -r -g app -d /app app

COPY package.json package-lock.json prisma.config.ts tsconfig.base.json tsconfig.json .npmrc ./
COPY prisma ./prisma
COPY scripts/install-git-hooks.mjs ./scripts/
# ts-node + typescript stay in the runtime image so we can run prisma db seed
# and the create-admin TS script without a separate compile step. Install
# globally — `npm install --no-save` was silently dropping the packages on
# npm 10 (legacy-peer-deps + multi-step RUN chain), leaving the runtime
# without any /app/node_modules/.bin/ts-node, which broke prisma db seed
# and create-admin.ts. Global install puts the binaries on /usr/local/bin
# (already on PATH for every user), so prisma's raw spawn() finds them
# without npx, no per-user cache write, no node_modules resolution dance.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm install -g ts-node@10 typescript@6.0 \
    && npm cache clean --force \
    && npx prisma generate

COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/api/scripts ./apps/api/scripts
COPY --from=build /app/apps/api/tsconfig.app.json ./apps/api/tsconfig.app.json
# Static runtime assets read by InvoicePdfService at request time (pdfkit
# registerFont + logo lockups). Resolved via process.cwd() = /app, so the
# committed `apps/api/assets/{fonts,brand}` must ship into the runtime image —
# `dist` does not carry non-TS files. See invoice-pdf.service.ts.
COPY --from=build /app/apps/api/assets ./apps/api/assets
# prisma/seed.ts and its helpers value-import the shared config library
# (store config rows, money formatter, cache keys). Ship that subtree so the
# in-container seed resolves it; nothing else under libs/ is needed.
COPY --from=build /app/libs/shared/common/src ./libs/shared/common/src
# No chown -R: npm-installed files are 0644 / dirs 0755 (world-readable),
# so the unprivileged `app` user reads them fine. A recursive chown on
# the ~50k node_modules tree added ~3-5 min to every api image build.
USER app

EXPOSE 53000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:53000/health || exit 1

CMD ["node", "dist/apps/api/main.js"]

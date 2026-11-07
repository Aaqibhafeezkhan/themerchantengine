/* eslint-disable */
/**
 * Jest global setup for the backend e2e suite.
 *
 * Brings the dockerised test stack to a known-good baseline, then boots a
 * webpack-bundled API instance on port 53001:
 *   1. re-seed the test database (restores depleted stock, clears stray e2e rows)
 *   2. flush the test Redis (product caches, rate-limit budget, queues)
 *   3. install the product full-text-search infrastructure
 *   4. start (or reuse) the API on :53001
 */
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';
import {
  API_BASE_URL,
  TEST_DATABASE_URL,
  TEST_REDIS_HOST,
  TEST_REDIS_PORT,
  E2E_BETTER_AUTH_SECRET,
  E2E_STRIPE_WEBHOOK_SECRET,
  describeHarnessStoreConfig,
} from './e2e/env';
import { applyFtsSetup } from '../prisma/apply-fts-setup';
import { applyTemplateBackfill } from '../prisma/backfill-notification-bodies';
import { applyNotificationIndexes } from '../prisma/apply-notification-indexes';
import { applyShippingIndexes } from '../prisma/apply-shipping-indexes';
import { applyOrderStatusHistoryBackfill } from '../prisma/backfill-order-status-history';
import { assertTestTarget } from '../scripts/e2e-identity-guard';

const HEALTH_URL = `${API_BASE_URL}/health`;
/**
 * A route that exists only under this suite's `API_GLOBAL_PREFIX: ''`. Public,
 * so it needs no session, and cheap.
 */
const UNPREFIXED_PROBE_URL = `${API_BASE_URL}/v1/products?pageSize=1`;
const REPO_ROOT = path.resolve(__dirname, '..');

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * True when the server on the port is one this suite can talk to.
 *
 * `/health` is registered OUTSIDE the global prefix, so it answers 200 on an
 * instance started with the default `API_GLOBAL_PREFIX` of `api` as readily as
 * on this suite's unprefixed one. A stale dev-configured build left on :53001
 * therefore looked healthy to `ensureApi`, got reused, and 404'd every single
 * route: 1028 failures whose message says nothing about the cause. Probing a
 * real route is what separates "a server" from "our server".
 *
 * It does NOT separate our DATABASE from the dev one: an API started against
 * `merchants_engine_dev` with an empty prefix passes this and writes every
 * spec's fixtures into the developer's working data. `assertTestTarget` is the
 * check that closes that, and `ensureApi` runs both — this one first, because
 * its message names the prefix mistake precisely.
 */
async function isOurApi(): Promise<boolean> {
  try {
    const res = await fetch(UNPREFIXED_PROBE_URL);
    return res.status !== 404;
  } catch {
    return false;
  }
}

/**
 * Bring the test database's shape up to `schema.prisma` before seeding it.
 *
 * This step did not exist, and its absence is only visible the first time a
 * phase adds a column: the seed and the suite then fail against a database
 * whose shape is whatever the last `nx e2e admin-e2e` left behind, with an
 * error that names a missing column rather than a missing migration step. The
 * admin suite has always pushed; this one only ever seeded.
 *
 * `--accept-data-loss` is required rather than incidental: `searchVector` lives
 * outside `schema.prisma` per DR-19, so every push drops it.
 *
 * The push must therefore be followed by `setupSearchFts()` BEFORE the seed
 * runs, not merely somewhere after it. Dropping the column does not drop
 * `product_search_vector_trig`: the trigger fires on `name`, `description`,
 * `shortDescription` and `tags`, none of which are dropped, and a PL/pgSQL body
 * is late-bound so Postgres tracks no dependency on the assignment target. The
 * trigger survives orphaned, and the seed's first product upsert then fails
 * with `record "new" has no field "searchVector"`. `prisma/seed.ts` states the
 * same invariant and names this file as the e2e owner of it.
 *
 * Output is not swallowed. The one run where this ordering is wrong is the one
 * where an operator most needs to read the error, and it is state-dependent:
 * an admin-e2e run drops the schema whole and leaves no trigger to orphan, so
 * a wrong order reads as an intermittent seed failure rather than a bug.
 */
function syncSchema(): void {
  execSync(`npx prisma db push --accept-data-loss --url="${TEST_DATABASE_URL}"`, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}

/**
 * Re-seed the test database to the known-good baseline. The seed is
 * idempotent (upserts) and restores stock levels depleted by prior runs and
 * clears accumulated non-seeded e2e rows — so the suite is repeatable.
 */
function reseedDatabase(): void {
  execSync('npx ts-node prisma/seed.ts', {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      STORE_CONFIG_FIXTURE: process.env.STORE_CONFIG_FIXTURE ?? 'demo',
    },
    stdio: 'ignore',
  });
}

/** Flush the test Redis — product caches, Better Auth rate-limit budget, queues. */
async function flushRedis(): Promise<void> {
  const redis = new Redis({
    host: TEST_REDIS_HOST,
    port: TEST_REDIS_PORT,
    lazyConnect: true,
    connectTimeout: 4000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.flushdb();
  } catch {
    // best-effort
  } finally {
    redis.disconnect();
  }
}

/**
 * Install the REAL production full-text-search infrastructure
 * (prisma/search_fts_setup.sql via the shared applier): the `searchVector`
 * column, the trigger, the brand/category/reference coverage indexes, and the
 * backfill. Using the same applier as dev/prod keeps the e2e index identical to
 * production (no divergent simplified trigger), and its guard fails the suite
 * loudly if any active product is left unsearchable. Idempotent.
 */
async function setupSearchFts(): Promise<void> {
  await applyFtsSetup(TEST_DATABASE_URL);
}

async function ensureApi(): Promise<void> {
  if (await isUp()) {
    if (await isOurApi()) {
      // Healthy AND unprefixed is still not enough: it says nothing about the
      // database. Fail-closed before any spec runs.
      await assertTestTarget(API_BASE_URL, 'e2e');
      console.log(`[e2e] reusing API already healthy at ${API_BASE_URL}`);
      return;
    }
    throw new Error(
      `[e2e] a server is listening on ${API_BASE_URL} and answers /health, but ` +
        `${UNPREFIXED_PROBE_URL} is 404, so it is not this suite's API. It is most ` +
        'likely a stale build started with the default API_GLOBAL_PREFIX, or a ' +
        'stopped storefront-e2e run. Stop that process and re-run.',
    );
  }

  const bundle = path.join(REPO_ROOT, 'dist', 'apps', 'api', 'main.js');
  if (!fs.existsSync(bundle)) {
    throw new Error(`[e2e] ${bundle} not found — run \`nx build api\` first`);
  }

  const logFd = fs.openSync(path.join(REPO_ROOT, 'test', '.e2e-api.log'), 'w');
  const port = new URL(API_BASE_URL).port || '53001';

  const child = spawn('node', [bundle], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: port,
      API_GLOBAL_PREFIX: '',
      // The scenario config the database was seeded from (plan E0.4, E1.4).
      STORE_CONFIG_FIXTURE: process.env.STORE_CONFIG_FIXTURE ?? 'demo',
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_HOST: TEST_REDIS_HOST,
      REDIS_PORT: String(TEST_REDIS_PORT),
      BETTER_AUTH_URL: API_BASE_URL,
      BETTER_AUTH_SECRET: E2E_BETTER_AUTH_SECRET,
      // The specs sign unsubscribe tokens with the auth secret; a `.env` value would win over it.
      UNSUBSCRIBE_TOKEN_SECRET: E2E_BETTER_AUTH_SECRET,
      STRIPE_WEBHOOK_SECRET: E2E_STRIPE_WEBHOOK_SECRET,
      // Test doubles for the card flow; the API refuses this flag in production.
      PAYMENT_FAKE_PROVIDERS: 'true',
    },
    stdio: ['ignore', logFd, logFd],
  });
  (globalThis as Record<string, unknown>).__E2E_API__ = child;

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isUp()) {
      // Our own spawn, so the target is known — but assert it anyway. The
      // spawn inherits `process.env`, and a DATABASE_URL exported in the shell
      // is exactly the kind of thing that is invisible until it has written.
      await assertTestTarget(API_BASE_URL, 'e2e');
      console.log(`[e2e] API ready at ${API_BASE_URL} (pid ${child.pid})`);
      return;
    }
    if (child.exitCode !== null) {
      throw new Error(
        `[e2e] API exited (code ${child.exitCode}) before becoming healthy — see test/.e2e-api.log`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error('[e2e] API did not become healthy within 90s — see test/.e2e-api.log');
}

/**
 * Backfill the NotificationTemplate en/ar bodies from the canonical defaults
 * (NE3). The reseed above upserts with `update: {}`, so a template row that was
 * first seeded with an empty body BEFORE NE3 is never repaired by re-seeding —
 * the idempotent backfill fills those empty bodies so the e2e DB exercises the
 * DB-as-truth render path, exactly like dev/prod after deploy.
 */
async function backfillTemplateBodies(): Promise<void> {
  await applyTemplateBackfill(TEST_DATABASE_URL);
}

export default async function globalSetup(): Promise<void> {
  // The scenario config every harness helper derives assertions from (plan E1.4):
  // demo unless the shell selects another fixture.
  process.env.STORE_CONFIG_FIXTURE ??= 'demo';
  syncSchema();
  // Before the seed, not after: the push above leaves the search trigger
  // orphaned, and the seed's first product upsert would hit it.
  await setupSearchFts();
  console.log(`[api-e2e] seeding (${describeHarnessStoreConfig()})`);
  reseedDatabase();
  await backfillTemplateBodies();
  await flushRedis();
  // NE8 — re-install the NotificationLog raw-SQL index that db push would drop.
  await applyNotificationIndexes(TEST_DATABASE_URL);
  // Re-install the one-default-per-zone partial-unique index (db push can't).
  await applyShippingIndexes(TEST_DATABASE_URL);
  // AD6 — the seeded orders predate OrderStatusHistory, and `db push` runs no
  // migration body, so the timeline they render comes from this backfill.
  await applyOrderStatusHistoryBackfill(TEST_DATABASE_URL);
  await ensureApi();
}

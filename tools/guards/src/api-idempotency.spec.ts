import { expectNoViolations, readCanary, readTree, SourceFile, Violation } from './lib/repo';
import { Route, readRoutes } from './lib/controllers';

/**
 * Constitution 3.6: every sensitive write accepts `X-Idempotency-Key`, and
 * inbound provider webhooks dedupe through `ProcessedWebhook`.
 *
 * Replaces the retired `idempotency-auditor`. The sensitive set is the literal
 * 3.6 list, written out here as route matchers so that adding a sensitive
 * endpoint is a deliberate edit to this file rather than a judgement call at
 * review time.
 */
const GUARD = 'api-idempotency';

interface SensitiveRoute {
  readonly reason: string;
  readonly verb: string;
  readonly path: RegExp;
}

const SENSITIVE: readonly SensitiveRoute[] = [
  { reason: 'order creation, storefront', verb: 'Post', path: /^v1\/orders$/ },
  // 3.6 says "order creation" without naming a lane. The admin route already
  // reads the key; nothing was holding it there.
  { reason: 'order creation, admin', verb: 'Post', path: /^v1\/admin\/orders$/ },
  { reason: 'refund', verb: 'Patch', path: /^v1\/admin\/returns\/[^/]+\/refund$/ },
  { reason: 'payment capture', verb: 'Post', path: /^v1\/admin\/orders\/[^/]+\/payment\/capture$/ },
  { reason: 'payment refund', verb: 'Post', path: /^v1\/admin\/orders\/[^/]+\/payment\/refund$/ },
  { reason: 'payment cancel', verb: 'Post', path: /^v1\/admin\/orders\/[^/]+\/payment\/cancel$/ },
  { reason: 'payment retry, storefront', verb: 'Post', path: /^v1\/orders\/[^/]+\/payment$/ },
  {
    reason: 'payment confirm, storefront',
    verb: 'Post',
    path: /^v1\/orders\/[^/]+\/payment\/confirm$/,
  },
  { reason: 'stock adjustment', verb: 'Patch', path: /^v1\/admin\/inventory\/adjust$/ },
  { reason: 'stock transfer', verb: 'Post', path: /^v1\/admin\/inventory\/transfer$/ },
  { reason: 'webhook replay', verb: 'Post', path: /^v1\/admin\/webhooks\/[^/]+\/test$/ },
];

/** Inbound provider webhooks. Each must reach ProcessedWebhook for dedup. */
const INBOUND_WEBHOOK_SERVICES = /(?:^|\/)[a-z0-9-]+-webhook\.service\.ts$/;

const ACCEPTS_KEY = /@IdempotencyKey\(/;

export function checkRoutes(routes: readonly Route[]): Violation[] {
  const violations: Violation[] = [];
  for (const sensitive of SENSITIVE) {
    const matched = routes.filter((r) => r.verb === sensitive.verb && sensitive.path.test(r.path));
    if (matched.length === 0) {
      violations.push({
        file: 'tools/guards/src/api-idempotency.spec.ts',
        line: 1,
        message: `no route matches the ${sensitive.reason} entry (${sensitive.verb} ${sensitive.path.source}). The route moved or was renamed: update this matcher rather than letting the rule go quiet (constitution 3.6).`,
      });
      continue;
    }
    for (const route of matched) {
      if (!ACCEPTS_KEY.test(route.signature)) {
        violations.push({
          file: route.file,
          line: route.line,
          message: `${route.verb} /${route.path} is a sensitive write (${sensitive.reason}) that does not read X-Idempotency-Key (constitution 3.6).`,
        });
      }
    }
  }
  return violations;
}

export function checkWebhookDedup(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!INBOUND_WEBHOOK_SERVICES.test(file.path)) continue;
    if (file.path.endsWith('.spec.ts')) continue;
    if (file.text.includes('ProcessedWebhook')) continue;
    violations.push({
      file: file.path,
      line: 1,
      message:
        'an inbound webhook service with no ProcessedWebhook dedup. A provider that retries would replay the effect (constitution 3.6).',
    });
  }
  return violations;
}

describe(GUARD, () => {
  const apiFiles = readTree({ dirs: ['apps/api/src'], extensions: ['.ts'] });
  const controllerFiles = apiFiles.filter((f) => f.path.endsWith('.controller.ts'));

  it('finds every sensitive write reading X-Idempotency-Key', () => {
    expectNoViolations(checkRoutes(readRoutes(controllerFiles)));
  });

  it('finds every inbound webhook service deduping through ProcessedWebhook', () => {
    expectNoViolations(checkWebhookDedup(apiFiles));
  });

  it('finds at least one inbound webhook service, so the filename shape cannot go quiet', () => {
    // The check keys on `*-webhook.service.ts`. A provider service named
    // anything else would make this half of the guard scan zero files and
    // report nothing, which reads exactly like a clean tree.
    const matched = apiFiles.filter(
      (f) => INBOUND_WEBHOOK_SERVICES.test(f.path) && !f.path.endsWith('.spec.ts'),
    );
    expect(matched.length).toBeGreaterThan(0);
  });

  it('canary: the guard turns red on a sensitive write with no key and a webhook with no dedup', () => {
    const canary = readCanary(GUARD);
    const routeMessages = checkRoutes(
      readRoutes(canary.filter((f) => f.path.endsWith('.controller.ts'))),
    ).map((v) => v.message);
    expect(routeMessages.some((m) => m.includes('does not read X-Idempotency-Key'))).toBe(true);

    const webhookMessages = checkWebhookDedup(canary).map((v) => v.message);
    expect(webhookMessages.some((m) => m.includes('no ProcessedWebhook dedup'))).toBe(true);
  });

  it('canary: the guard turns red when a sensitive route is renamed out from under its matcher', () => {
    const messages = checkRoutes([]).map((v) => v.message);
    expect(messages).toHaveLength(SENSITIVE.length);
    expect(messages.every((m) => m.includes('The route moved or was renamed'))).toBe(true);
  });
});

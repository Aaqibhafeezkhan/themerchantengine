import {
  expectNoViolations,
  matchAll,
  readCanary,
  readTree,
  SourceFile,
  Violation,
} from './lib/repo';

/**
 * DR-34 and the card-checkout spec: checkout and orders are the bottom layer and
 * know no payment provider. A concrete provider id or class name in them means a
 * new provider would need a change there. Providers live under `payments/`.
 */
const GUARD = 'api-payment-provider-agnostic';

const SCANNED_DIRS = ['apps/api/src/modules/orders', 'apps/api/src/modules/checkout'];
const SCANNED_FILES = ['apps/api/src/modules/payments/payment-gateway.service.ts'];

const PROVIDER_LITERAL = /['"`](stripe|paypal|mollie|paymob|konnect|flouci|tap|cmi)['"`]/i;
const PROVIDER_IDENTIFIER = /\b(Stripe|PayPal|Mollie|Paymob|Konnect|Flouci)\w*/;

export function check(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.ts') || file.path.endsWith('.spec.ts')) continue;
    for (const pattern of [PROVIDER_LITERAL, PROVIDER_IDENTIFIER]) {
      violations.push(
        ...matchAll(
          file,
          pattern,
          (match) => `Concrete payment provider "${match[0]}" outside the providers layer.`,
          { skipComments: true },
        ),
      );
    }
  }
  return violations;
}

describe(GUARD, () => {
  it('finds no concrete provider in checkout, orders or the gateway', () => {
    const files = [
      ...readTree({ dirs: SCANNED_DIRS, extensions: ['.ts'] }),
      ...readTree({ dirs: SCANNED_FILES }),
    ];
    expect(files.length).toBeGreaterThan(0);
    expectNoViolations(check(files));
  });

  it('canary: turns red on a fixture that names a provider', () => {
    const violations = check(readCanary(GUARD));
    expect(violations.map((v) => v.file)).toContain('apps/api/src/modules/orders/bad.service.ts');
  });

  it('canary: stays green on a fixture that only reads the action type', () => {
    const approved = readCanary(GUARD).filter((f) => f.path.includes('approved'));
    expect(approved.length).toBeGreaterThan(0);
    expect(check(approved)).toEqual([]);
  });
});

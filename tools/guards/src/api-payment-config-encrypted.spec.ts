import {
  expectNoViolations,
  readCanary,
  readTree,
  SourceFile,
  Violation,
  lineAt,
} from './lib/repo';

/**
 * Card-checkout spec: payment method secrets are encrypted at rest. Every write
 * of a `paymentMethod` row that carries a `config` must pass the value through
 * `PaymentConfigCrypto`, or write an empty object. A raw DTO config written to
 * the column would store a secret key as plain text.
 */
const GUARD = 'api-payment-config-encrypted';

const SCANNED_DIRS = ['apps/api/src', 'apps/api/scripts', 'prisma'];
const WRITE_CALL = /\bpaymentMethod\.(?:create|createMany|update|updateMany|upsert)\(/g;
const CONFIG_VALUE = /\bconfig:\s*([^\n]*)/g;

function callBody(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return text.slice(openParen, i + 1);
  }
  return text.slice(openParen);
}

/** The identifier is allowed when the same file assigns it from the crypto service. */
function isEncryptedIdentifier(text: string, ident: string): boolean {
  const assignment = new RegExp(`(?:const|let)\\s+${ident}\\b[^;]*?\\bcrypto\\.`);
  return assignment.test(text);
}

export function check(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.ts') || file.path.endsWith('.spec.ts')) continue;
    for (const call of file.text.matchAll(WRITE_CALL)) {
      const open = (call.index ?? 0) + call[0].length - 1;
      const body = callBody(file.text, open);
      for (const config of body.matchAll(CONFIG_VALUE)) {
        const value = config[1].trim();
        const ident = /^([A-Za-z_]\w*)\b(?!\.)/.exec(value)?.[1];
        const ok =
          value.startsWith('{}') ||
          value.startsWith('this.crypto.') ||
          (ident !== undefined && isEncryptedIdentifier(file.text, ident));
        if (!ok) {
          violations.push({
            file: file.path,
            line: lineAt(file.text, open + (config.index ?? 0)),
            message:
              'paymentMethod config written without PaymentConfigCrypto. Encrypt it or write {}.',
          });
        }
      }
    }
  }
  return violations;
}

describe(GUARD, () => {
  it('finds no payment method config written as plain text', () => {
    const files = readTree({ dirs: SCANNED_DIRS, extensions: ['.ts'] });
    expect(files.length).toBeGreaterThan(0);
    expectNoViolations(check(files));
  });

  it('canary: turns red on a fixture that stores the raw DTO config', () => {
    const violations = check(readCanary(GUARD));
    expect(violations.map((v) => v.file)).toEqual(['apps/api/src/modules/payments/bad.service.ts']);
  });

  it('canary: stays green on a fixture that encrypts or writes {}', () => {
    const approved = readCanary(GUARD).filter((f) => f.path.includes('approved'));
    expect(approved.length).toBeGreaterThan(0);
    expect(check(approved)).toEqual([]);
  });
});

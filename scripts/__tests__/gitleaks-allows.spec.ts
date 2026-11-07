/**
 * The inline `gitleaks:allow` markers (constitution §3.7). Each one exempts
 * a single line from the secret scan, so each must sit on a value that is
 * unmistakably fake, and their number is pinned: a new marker is a review
 * decision, not a side effect of making a scan pass.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');

const FAKE_SHAPES = [
  /test-secret/,
  /0123456789/,
  /f47ac10b-58cc-4372-a567-0e02b2c3d479/, // the RFC 4122 example UUID
  /must_never_appear/,
  /abcdef1234567890/,
  /0xS(ITE|ECRET)KEY1234/,
];

function markedLines(): { file: string; line: string }[] {
  const out = execFileSync(
    'git',
    ['grep', '-n', 'gitleaks:allow', '--', '.', ':!scripts/__tests__/gitleaks-allows.spec.ts'],
    {
      cwd: REPO,
      encoding: 'utf8',
    },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [file, , ...rest] = row.split(':');
      return { file, line: rest.join(':') };
    });
}

describe('inline gitleaks allows', () => {
  const marks = markedLines();

  it('are seventeen, all in specs; change this number with the review that added the line', () => {
    expect(marks).toHaveLength(17);
    for (const { file } of marks) {
      expect(file, file).toMatch(/\.spec\.ts$|\.e2e-spec\.ts$/);
    }
  });

  it('each sits on a value of an obviously fake shape', () => {
    for (const { file, line } of marks) {
      expect(
        FAKE_SHAPES.some((shape) => shape.test(line)),
        `${file}: ${line.trim()}`,
      ).toBe(true);
    }
  });
});

import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import config from '../playwright.config';

/**
 * Every spec file must be collected by at least one project.
 *
 * Each project in `playwright.config.ts` carries an explicit `testMatch`
 * allowlist naming every spec by hand. A spec that nobody adds to one of those
 * lists is not skipped and does not error: it collects zero tests, and the run
 * is green because nothing ran. The file exists, the assertions inside it look
 * thorough, an auditor greps for it and finds it, and it has never once
 * executed.
 *
 * This has happened here before. The config's own comment above the
 * `desktop-chromium-1440` project records three specs that "collected zero
 * tests under every run while still reading as covered: two of them are
 * locale-matrix specs that auditors counted as compliant". It happened again
 * at D8 with `loader-404.journey.spec.ts`, which is why this guard exists
 * rather than another comment.
 *
 * The rule is per-file rather than per-project on purpose. Which projects a
 * spec runs under is a real scoping decision, and several are deliberately
 * narrowed: WebKit skips the specs that need hydration under the Vite dev
 * server, and the mobile projects lag the desktop one until a spec has a run's
 * worth of history. Nothing here second-guesses that. It only insists the
 * answer is not "none".
 */

const SRC_DIR = __dirname;

/** This file is a source guard, not a browser journey; it runs anywhere. */
const SELF = 'project-coverage.spec.ts';

function specFiles(): string[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => entry.name)
    .filter((name) => name !== SELF);
}

interface ProjectLike {
  name?: string;
  testMatch?: RegExp | string | (RegExp | string)[];
  testIgnore?: RegExp | string | (RegExp | string)[];
  dependencies?: string[];
}

/**
 * Absent means different things for the two options, and conflating them is
 * how the first draft of this guard reported every spec as orphaned: an absent
 * `testIgnore` was read as "ignores everything".
 */
function hits(pattern: ProjectLike['testMatch'], file: string): boolean {
  if (!pattern) return false;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  // The config's patterns are anchored on the file name with `$`, and Playwright
  // tests them against the full path, so a path-shaped subject is what they
  // expect.
  const subject = resolve(SRC_DIR, file);
  return patterns.some((p) => (p instanceof RegExp ? p.test(subject) : subject.includes(p)));
}

function collectedBy(
  file: string,
  projects: ProjectLike[] = (config.projects ?? []) as ProjectLike[],
): string[] {
  return projects
    .filter((project) => {
      // No allowlist means the preset's default collects everything.
      const included = project.testMatch ? hits(project.testMatch, file) : true;
      return included && !hits(project.testIgnore, file);
    })
    .map((project) => project.name ?? '(unnamed)');
}

const STORE_CONFIG_SPEC = 'store-config.journey.spec.ts';

/**
 * `store-config.journey.spec.ts` rewrites the store contact block and the
 * currency, then restores them. Its serial mode only orders its own file, so
 * a visual baseline or a money assertion on another worker could see the
 * mutated config. Every project that collects it must collect nothing else
 * and must depend on every other project.
 */
function storeConfigOrderViolations(projects: ProjectLike[]): string[] {
  const mutatorNames = collectedBy(STORE_CONFIG_SPEC, projects);
  if (mutatorNames.length === 0) return [`no project collects ${STORE_CONFIG_SPEC}`];
  const others = projects
    .map((p) => p.name ?? '(unnamed)')
    .filter((name) => !mutatorNames.includes(name));
  const violations: string[] = [];
  for (const project of projects.filter((p) => mutatorNames.includes(p.name ?? '(unnamed)'))) {
    const shared = specFiles().filter(
      (file) => file !== STORE_CONFIG_SPEC && collectedBy(file, [project]).length > 0,
    );
    if (shared.length > 0) violations.push(`${project.name} also collects ${shared.join(', ')}`);
    const missing = others.filter((name) => !(project.dependencies ?? []).includes(name));
    if (missing.length > 0)
      violations.push(`${project.name} does not depend on ${missing.join(', ')}`);
  }
  return violations;
}

const CARD_PAYMENT_SPEC = 'embedded-card-payment.journey.spec.ts';

/**
 * `embedded-card-payment.journey.spec.ts` activates a second payment method in
 * the shared DB while it runs, and an order placed without a method code then
 * fails with ORDER_PAYMENT_METHOD_INVALID. Every project that collects it must
 * collect nothing else and must run after the projects that are not
 * themselves ordered after it.
 */
function cardPaymentIsolationViolations(projects: ProjectLike[]): string[] {
  const names = collectedBy(CARD_PAYMENT_SPEC, projects);
  if (names.length === 0) return [`no project collects ${CARD_PAYMENT_SPEC}`];
  const violations: string[] = [];
  for (const project of projects.filter((p) => names.includes(p.name ?? '(unnamed)'))) {
    const shared = specFiles().filter(
      (file) => file !== CARD_PAYMENT_SPEC && collectedBy(file, [project]).length > 0,
    );
    if (shared.length > 0) violations.push(`${project.name} also collects ${shared.join(', ')}`);
    // A project that depends on this one runs after it, so it is allowed to be absent here.
    const missing = projects
      .filter((p) => !names.includes(p.name ?? '(unnamed)'))
      .filter((p) => !(p.dependencies ?? []).includes(project.name ?? '(unnamed)'))
      .map((p) => p.name ?? '(unnamed)')
      .filter((name) => !(project.dependencies ?? []).includes(name));
    if (missing.length > 0)
      violations.push(`${project.name} does not depend on ${missing.join(', ')}`);
  }
  return violations;
}

test.describe('storefront-e2e project coverage', () => {
  test('the config exposes projects to check, so this cannot pass vacuously', () => {
    const projects = (config.projects ?? []) as ProjectLike[];
    expect(projects.length).toBeGreaterThan(1);
    expect(projects.map((p) => p.name)).toContain('desktop-chromium-1440');
    expect(specFiles().length).toBeGreaterThan(20);
  });

  test('every spec file is collected by at least one project', () => {
    const orphans = specFiles()
      .filter((file) => collectedBy(file).length === 0)
      .sort();
    expect(
      orphans,
      'these spec files are in no project testMatch, so they collect zero tests and the ' +
        'suite is green because nothing ran. Add each to the project it belongs in, in ' +
        'apps/storefront-e2e/playwright.config.ts.',
    ).toEqual([]);
  });

  test('store-config.journey runs alone, after every other project', () => {
    expect(storeConfigOrderViolations((config.projects ?? []) as ProjectLike[])).toEqual([]);
  });

  test('embedded-card-payment.journey runs alone, after the parallel projects', () => {
    expect(cardPaymentIsolationViolations((config.projects ?? []) as ProjectLike[])).toEqual([]);
  });

  test.describe('card-payment isolation canaries', () => {
    const parallel: ProjectLike = {
      name: 'parallel',
      testMatch: /visual-regression.journey\.spec\.ts$/,
    };
    const card = (overrides: Partial<ProjectLike>): ProjectLike => ({
      name: 'card',
      testMatch: /embedded-card-payment\.journey\.spec\.ts$/,
      dependencies: ['parallel'],
      ...overrides,
    });

    test('a card project that depends on the parallel project passes', () => {
      expect(cardPaymentIsolationViolations([parallel, card({})])).toEqual([]);
    });

    test('a card project that shares a project with the visual suite fails', () => {
      const shared = card({
        testMatch: /(visual-regression.journey|embedded-card-payment\.journey)\.spec\.ts$/,
      });
      expect(cardPaymentIsolationViolations([parallel, shared])).toEqual([
        'card also collects visual-regression.journey.spec.ts',
      ]);
    });

    test('a card project missing a dependency fails', () => {
      expect(cardPaymentIsolationViolations([parallel, card({ dependencies: [] })])).toEqual([
        'card does not depend on parallel',
      ]);
    });
  });

  test.describe('store-config ordering canaries', () => {
    const visual: ProjectLike = {
      name: 'visual',
      testMatch: /visual-regression\.journey\.spec\.ts$/,
    };
    const mutator = (overrides: Partial<ProjectLike>): ProjectLike => ({
      name: 'mutator',
      testMatch: /store-config\.journey\.spec\.ts$/,
      dependencies: ['visual'],
      ...overrides,
    });

    test('a mutator that depends on every other project passes', () => {
      expect(storeConfigOrderViolations([visual, mutator({})])).toEqual([]);
    });

    test('a mutator that shares a project with the visual suite fails', () => {
      const shared = mutator({
        testMatch: /(visual-regression|store-config)\.journey\.spec\.ts$/,
      });
      expect(storeConfigOrderViolations([visual, shared])).toEqual([
        'mutator also collects visual-regression.journey.spec.ts',
      ]);
    });

    test('a mutator missing a dependency fails', () => {
      expect(storeConfigOrderViolations([visual, mutator({ dependencies: [] })])).toEqual([
        'mutator does not depend on visual',
      ]);
    });

    test('no project collecting the mutator fails', () => {
      expect(storeConfigOrderViolations([visual])).toEqual([
        `no project collects ${STORE_CONFIG_SPEC}`,
      ]);
    });
  });
});

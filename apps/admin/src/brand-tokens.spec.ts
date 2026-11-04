import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The semantic token layer, checked as a structure rather than as a rendering.
 *
 * Colour is checked where colour exists, which is the Playwright contrast
 * probe against a real browser. What can go wrong here is structural and
 * silent: a token declared in dark mode and forgotten in light, a Tailwind
 * utility pointing at a variable nothing declares, or the two light blocks
 * drifting apart so the mode renders differently depending on whether the
 * operator chose it or their system did. None of those three shows up as a
 * failure anywhere else — an undeclared custom property resolves to nothing
 * and the element simply inherits, which reads as a styling opinion rather
 * than as a bug.
 */

const adminRoot = join(__dirname, '..');
const stylesPath = join(adminRoot, 'src', 'styles.css');
const tailwindPath = join(adminRoot, 'tailwind.config.js');

const styles = readFileSync(stylesPath, 'utf8');
const tailwind = readFileSync(tailwindPath, 'utf8');

/** The declaration body that follows `selector {`, to its matching brace. */
function blockAfter(source: string, selector: string): string {
  const at = source.indexOf(selector);
  if (at === -1) throw new Error(`styles.css has no ${selector} block`);
  let i = source.indexOf('{', at + selector.length - 1);
  let depth = 0;
  const start = i + 1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  throw new Error(`unterminated block for ${selector}`);
}

/** `--name: value;` pairs, in declaration order. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name, value.trim());
  }
  return out;
}

const dark = declarations(blockAfter(styles, ":root,\n:root[data-theme='dark']"));
const lightBySystem = declarations(blockAfter(styles, ":root:not([data-theme='dark'])"));
const lightByChoice = declarations(blockAfter(styles, ":root[data-theme='light']"));

describe('admin semantic token layer', () => {
  it('declares the same token set in dark mode and in both light blocks', () => {
    expect([...lightBySystem.keys()].sort()).toEqual([...dark.keys()].sort());
    expect([...lightByChoice.keys()].sort()).toEqual([...dark.keys()].sort());
  });

  it('gives the two light blocks identical values', () => {
    // A drift here is a mode that renders one way when the operator picks it
    // and another way when their system does.
    expect(Object.fromEntries(lightByChoice)).toEqual(Object.fromEntries(lightBySystem));
  });

  it('declares every colour token as RGB channels, never as hex', () => {
    // Tailwind wraps these as `rgb(var(--token))`. A hex value produces
    // `rgb(#0a0a0a)`, which is invalid, so every semantic colour in the tree
    // would stop resolving without a single error.
    const channels = /^\d{1,3} \d{1,3} \d{1,3}$/;
    const notColour = new Set(['--scheme', '--picker-indicator-filter']);
    for (const block of [dark, lightBySystem, lightByChoice]) {
      for (const [name, value] of block) {
        if (notColour.has(name)) continue;
        expect(`${name}: ${value}`).toMatch(
          new RegExp(`^${name}: ${channels.source.slice(1, -1)}$`),
        );
      }
    }
  });

  it('declares every semantic token the Tailwind config consumes', () => {
    const consumed = [...tailwind.matchAll(/semantic\(`?'?([\w${}-]+)'?`?\)/g)]
      .map(([, name]) => name)
      .filter((name) => !name.includes('$'));
    // The four status families are built in a loop, so expand them the same
    // way the config does rather than asserting on the loop's source text.
    const expanded = new Set(consumed);
    for (const status of ['success', 'warning', 'error', 'info']) {
      expanded.add(`status-${status}`);
      expanded.add(`status-${status}-fill`);
      expanded.add(`status-${status}-tint`);
      expanded.add(`on-status-${status}`);
      expanded.add(`on-status-${status}-fill`);
    }
    expect(expanded.size).toBeGreaterThan(20);
    for (const name of expanded) {
      expect(dark.has(`--${name}`)).toBe(true);
    }
  });

  it('keeps the palette declared in exactly one place', () => {
    const paletteDeclarations = [...styles.matchAll(/^\s*--color-[\w-]+\s*:/gm)];
    const paletteBlock = blockAfter(styles, ':root {');
    for (const match of paletteDeclarations) {
      expect(paletteBlock).toContain(match[0].trim());
    }
  });
});

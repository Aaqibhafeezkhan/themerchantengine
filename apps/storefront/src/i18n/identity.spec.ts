import { describe, expect, it } from 'vitest';

import { getChromeStrings } from './index';
import {
  applyChromeIdentity,
  countryName,
  NEUTRAL_CHROME_IDENTITY,
  type ChromeIdentity,
} from './identity';
import type { ChromeStrings } from './types';

const ACME: ChromeIdentity = { storeName: 'Acme Supply', country: 'PT' };

describe('chrome identity substitution', () => {
  it('fills {store} and {country} through every level of a catalogue', () => {
    const source = {
      meta: { title: '{store}', description: 'We deliver within {country}.' },
      nested: { deep: { leaf: '© {store}' } },
    } as unknown as ChromeStrings;

    const out = applyChromeIdentity(source, ACME, 'en') as unknown as Record<
      string,
      Record<string, unknown>
    >;

    expect(out['meta']['title']).toBe('Acme Supply');
    expect(out['meta']['description']).toBe('We deliver within Portugal.');
    expect((out['nested']['deep'] as Record<string, string>)['leaf']).toBe('© Acme Supply');
  });

  it('drops a sentence that needs a country when the store has none', () => {
    const source = {
      hint: 'We deliver within {country}.',
      title: '{store}',
    } as unknown as ChromeStrings;

    const out = applyChromeIdentity(
      source,
      { storeName: 'Acme Supply', country: '' },
      'en',
    ) as unknown as Record<string, string>;

    expect(out['hint']).toBe('');
    expect(out['title']).toBe('Acme Supply');
  });

  it('leaves the counting and query placeholders alone', () => {
    // `{count}`, `{q}` and `{platform}` are filled at the call site with a
    // runtime value. Substituting them here would consume them silently.
    const source = { a: '{count} in cart', b: 'Results for "{q}"', c: '{store} on {platform}' };
    const out = applyChromeIdentity(
      source as unknown as ChromeStrings,
      ACME,
      'en',
    ) as unknown as Record<string, string>;

    expect(out['a']).toBe('{count} in cart');
    expect(out['b']).toBe('Results for "{q}"');
    expect(out['c']).toBe('Acme Supply on {platform}');
  });

  it('names the country in the reader language', () => {
    expect(countryName('PT', 'en')).toBe('Portugal');
    expect(countryName('PT', 'fr')).toBe('Portugal');
    expect(countryName('DE', 'fr')).toBe('Allemagne');
  });

  it('gives back an unconfigured country as nothing and never throws on a bad one', () => {
    expect(countryName('', 'en')).toBe('');
    // A code the runtime cannot even parse. A wrong-looking label beats a
    // throw on a page whose only fault is a malformed settings row.
    expect(countryName('X', 'en')).toBe('X');
    // A well-formed code no region claims resolves to whatever the runtime
    // calls it, which is a label rather than an error.
    expect(countryName('ZZ', 'en').length).toBeGreaterThan(0);
  });

  it('resolves against the neutral config when no identity is given', () => {
    // Never a raw `{store}`: a placeholder that reaches a page reads as a bug
    // to a customer, a generic store name reads as an unconfigured store.
    const strings = getChromeStrings('en');
    for (const leaf of leaves(strings)) {
      expect(leaf, leaf).not.toMatch(/\{(store|country)\}/);
    }
    expect(strings.brand.name).toBe(NEUTRAL_CHROME_IDENTITY.storeName);
  });

  it('never leaks a placeholder for any catalogue or any identity', () => {
    for (const locale of ['fr', 'en', 'ar']) {
      for (const identity of [NEUTRAL_CHROME_IDENTITY, ACME]) {
        for (const leaf of leaves(getChromeStrings(locale, identity))) {
          expect(leaf, `${locale}: ${leaf}`).not.toMatch(/\{(store|country)\}/);
        }
      }
    }
  });

  it('memoises per locale and per identity', () => {
    expect(getChromeStrings('en', ACME)).toBe(getChromeStrings('en', { ...ACME }));
    expect(getChromeStrings('en', ACME)).not.toBe(getChromeStrings('fr', ACME));
    expect(getChromeStrings('en', ACME)).not.toBe(
      getChromeStrings('en', { storeName: 'Other', country: 'PT' }),
    );
  });

  it('falls back to the default catalogue for a locale the build does not ship', () => {
    expect(getChromeStrings('de', ACME)).toBe(getChromeStrings('fr', ACME));
    expect(getChromeStrings(null, ACME)).toBe(getChromeStrings('fr', ACME));
  });
});

function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(leaves);
}

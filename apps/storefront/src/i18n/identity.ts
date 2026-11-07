import { NEUTRAL_STORE_CONFIG } from '@common/store-config';

import type { ChromeStrings } from './types';

/**
 * The store values chrome copy interpolates (DR-31, plan E2.5).
 *
 * The catalogues used to spell one store's name into every meta title, the
 * footer copyright and the trust heading, and one market into the delivery and
 * address copy. They now carry `{store}` and `{country}` and this is what fills
 * them, so the same build serves any install.
 */
export interface ChromeIdentity {
  /** Store name, already resolved for the locale being rendered. */
  storeName: string;
  /** ISO 3166-1 alpha-2 country of the store, or `''` when unconfigured. */
  country: string;
}

/**
 * What the chrome renders before the config endpoint answers, taken from the
 * one committed neutral config rather than restated, so the gap before the
 * first read shows the same store an unconfigured engine shows.
 */
export const NEUTRAL_CHROME_IDENTITY: ChromeIdentity = Object.freeze({
  storeName: NEUTRAL_STORE_CONFIG.identity.storeName.default,
  country: NEUTRAL_STORE_CONFIG.identity.address.country,
});

/** The placeholders the catalogues may carry. Anything else is left alone. */
const PLACEHOLDER = /\{(store|country)\}/g;

/**
 * The country's name in the reader's language.
 *
 * `Intl.DisplayNames` rather than a shipped table: the engine serves any
 * market, a table would be three hundred rows in three languages, and the
 * runtime already carries the data. A code the runtime does not know comes
 * back as the code itself, which is a wrong-looking label rather than a crash.
 */
export function countryName(code: string, locale: string): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Substitute the identity placeholders through a whole catalogue.
 *
 * Memoised on the caller's side (`getChromeStrings`), because every component
 * reads the catalogue inside a `computed()` and a fresh deep copy per change
 * detection would allocate the whole chrome on every tick.
 */
export function applyChromeIdentity(
  strings: ChromeStrings,
  identity: ChromeIdentity,
  locale: string,
): ChromeStrings {
  const country = countryName(identity.country, locale);
  const fill = (leaf: string): string =>
    // A sentence built around the country reads as a bare full stop without
    // one, so it is dropped and the template hides the empty line.
    !country && leaf.includes('{country}')
      ? ''
      : leaf.replace(PLACEHOLDER, (_match, key: string) =>
          key === 'store' ? identity.storeName : country,
        );
  return substitute(strings, fill);
}

function substitute<T>(value: T, fill: (leaf: string) => string): T {
  if (typeof value === 'string') return fill(value) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = substitute(child, fill);
  }
  return out as T;
}

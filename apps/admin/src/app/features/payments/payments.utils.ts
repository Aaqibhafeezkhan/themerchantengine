import type { BadgeTone } from '@admin-ui';
import type {
  PaymentMethod,
  PaymentProvider,
  PaymentProviderCatalogueEntry,
} from '@admin-services';
import { pickTranslation, type Translatable } from '@admin-types';

export function findProvider(
  provider: PaymentProvider | string,
  catalogue: readonly PaymentProviderCatalogueEntry[],
): PaymentProviderCatalogueEntry | null {
  return catalogue.find((entry) => entry.id === provider) ?? null;
}

/** The label comes from the API catalogue, so a new provider needs no admin change. */
export function providerLabel(
  provider: PaymentProvider | string,
  catalogue: readonly PaymentProviderCatalogueEntry[] = [],
): string {
  return findProvider(provider, catalogue)?.label ?? provider;
}

export function activeTone(isActive: boolean): BadgeTone {
  return isActive ? 'success' : 'neutral';
}

export function testModeTone(isTestMode: boolean): BadgeTone | null {
  return isTestMode ? 'warning' : null;
}

export function methodLabel(
  method: Pick<PaymentMethod, 'name' | 'code'>,
  locale: string,
  defaultLocale: string,
): string {
  return pickTranslation(
    method.name as Translatable | string | null | undefined,
    locale,
    method.code,
    defaultLocale,
  );
}

const MASKED_VALUE = '***';
/** Same legacy names the API masks for rows whose provider has no catalogue entry. */
const LEGACY_SECRET_KEYS = new Set([
  'apiKey',
  'webhookSecret',
  'clientSecret',
  'privateKey',
  'signingSecret',
]);

export function isSecretKey(
  key: string,
  entry?: Pick<PaymentProviderCatalogueEntry, 'secretFields'> | null,
): boolean {
  return LEGACY_SECRET_KEYS.has(key) || (entry?.secretFields.includes(key) ?? false);
}

export function isMasked(value: unknown): boolean {
  return value === MASKED_VALUE;
}

/** Display helper — mask-aware preview for a config value. */
export function displayConfigValue(
  key: string,
  value: unknown,
  entry?: Pick<PaymentProviderCatalogueEntry, 'secretFields'> | null,
): string {
  if (value === null || value === undefined) return '—';
  if (isSecretKey(key, entry) && typeof value === 'string') {
    return value === MASKED_VALUE ? 'Stored (hidden)' : value;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '—';
  }
}

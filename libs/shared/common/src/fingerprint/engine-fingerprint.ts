/**
 * The markers technology detectors (Wappalyzer, BuiltWith, httpx) match to
 * name the engine behind a site (DR-36).
 *
 * Constants on purpose, never read from the store config: a store renamed to
 * anything must still read as the engine (DR-31 keeps identity runtime config,
 * so nothing in it can be the marker).
 *
 * No imports, so the Nitro server and the admin entrypoint can load this file
 * by relative path.
 */
export const ENGINE_FINGERPRINT_NAME = 'themerchantengine';

/** Kept equal to the root `package.json` version by the spec. */
export const ENGINE_VERSION = '1.0.1';

export const ENGINE_FINGERPRINT_HEADER = 'X-Powered-By';
export const ENGINE_FINGERPRINT_META_NAME = 'generator';
export const ENGINE_FINGERPRINT_APP_ATTRIBUTE = 'data-tme-app';
export const ENGINE_FINGERPRINT_GLOBAL = 'themerchantengine';

export type EngineApp = 'storefront' | 'admin' | 'api';

/** `TME_FINGERPRINT` values that remove every marker. */
const OFF_VALUES = new Set(['off', 'false', '0', 'no']);

export type FingerprintEnv = Record<string, string | undefined>;

export function isEngineFingerprintEnabled(env: FingerprintEnv): boolean {
  const flag = env['TME_FINGERPRINT']?.trim().toLowerCase();
  return !flag || !OFF_VALUES.has(flag);
}

/**
 * The marker value, or `null` when the operator turned the markers off.
 *
 * Name only by default. `TME_FINGERPRINT_VERSION=major` adds the major
 * version. The full version is never emitted: it maps a site to known CVEs.
 */
export function engineFingerprintValue(env: FingerprintEnv): string | null {
  if (!isEngineFingerprintEnabled(env)) return null;
  const versionMode = env['TME_FINGERPRINT_VERSION']?.trim().toLowerCase();
  if (versionMode === 'major') {
    return `${ENGINE_FINGERPRINT_NAME} ${ENGINE_VERSION.split('.')[0]}`;
  }
  return ENGINE_FINGERPRINT_NAME;
}

interface FingerprintDocument {
  querySelector(selectors: string): unknown;
}

/**
 * Sets the JS global detectors read from a running page, only when the
 * generator meta is present. The meta is the one switch: an operator who
 * strips it turns this marker off too.
 */
export function exposeEngineFingerprint(
  doc: FingerprintDocument,
  win: object,
  app: EngineApp,
): void {
  if (
    !doc.querySelector(
      `meta[name="${ENGINE_FINGERPRINT_META_NAME}"][content^="${ENGINE_FINGERPRINT_NAME}"]`,
    )
  ) {
    return;
  }
  Object.defineProperty(win, ENGINE_FINGERPRINT_GLOBAL, {
    value: Object.freeze({ app }),
    configurable: true,
  });
}

import { ErrorHandler, Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';

/**
 * Storefront global error handler.
 *
 * Logs unhandled errors with platform context. Does NOT auto-redirect
 * to `/{locale}/error`. That would route any minor lifecycle / template
 * exception through the error UI, masking the actual bug and hijacking
 * the user's current route. The `/error` page is reached via:
 *   - Direct user navigation.
 *   - Per-feature error handlers that decide their own UX (e.g. the
 *     catalog page surfaces a load-error CTA in-place).
 *   - The `sanitizeFromParam` retry flow when a feature explicitly
 *     redirects there.
 *
 * SSR: writes to console.error so the failure is captured in server
 * logs. Re-throwing would surface to the Nitro 500 path; the current
 * framework default already handles that boundary.
 *
 * The raw error stack is NOT echoed to the browser console in
 * production builds (the production logger trims it).
 *
 * Leaving the page makes WebKit reject every in-flight lazy import. Those
 * failures are dropped once the page is unloading; a lazy import that fails
 * on a live page is still logged. The same goes for an HTTP request the
 * browser aborts because the page is going away (status 0).
 */
@Injectable()
export class StorefrontErrorHandler implements ErrorHandler {
  private readonly platformId = inject(PLATFORM_ID);
  private unloading = false;

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;
    let stay: ReturnType<typeof setTimeout> | undefined;
    // beforeunload also fires for a download link or a cancelled leave, so
    // it only holds the flag for a short window; pagehide holds it for good.
    window.addEventListener('beforeunload', () => {
      this.unloading = true;
      clearTimeout(stay);
      stay = setTimeout(() => {
        this.unloading = false;
      }, BEFOREUNLOAD_WINDOW_MS);
    });
    window.addEventListener('pagehide', () => {
      clearTimeout(stay);
      this.unloading = true;
    });
    window.addEventListener('pageshow', () => {
      clearTimeout(stay);
      this.unloading = false;
    });
  }

  handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);

    if (!isPlatformBrowser(this.platformId)) {
      // eslint-disable-next-line no-console
      console.error('[storefront-ssr]', message);
      return;
    }

    if (this.unloading && (isFailedLazyImport(error) || isAbortedRequest(error))) return;

    // eslint-disable-next-line no-console
    console.error('[storefront]', message, error);
  }
}

const BEFOREUNLOAD_WINDOW_MS = 3_000;

// WebKit, Chromium and Firefox wording for a rejected dynamic import().
const FAILED_LAZY_IMPORT =
  /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/;

function isFailedLazyImport(error: unknown): boolean {
  return error instanceof TypeError && FAILED_LAZY_IMPORT.test(error.message);
}

function isAbortedRequest(error: unknown): boolean {
  return error instanceof HttpErrorResponse && error.status === 0;
}

/**
 * Sanitize a candidate `from=` value: only same-origin path-only URLs are
 * accepted. Anything else (cross-origin, `javascript:`, protocol-relative
 * `//evil.com`, malformed) returns `null` so the caller can fall back to
 * the locale home.
 *
 * This runs at the error page render time (browser-side only). The page
 * passes `window.location.origin` as the second arg.
 */
export function sanitizeFromParam(from: string | null, originBase: string): string | null {
  if (!from) return null;
  // Reject obvious schemes before URL parsing — `javascript:foo` parses as
  // a valid URL with that protocol.
  if (/^[a-z]+:/i.test(from)) return null;
  // Reject protocol-relative (`//evil.com/path`).
  if (from.startsWith('//')) return null;
  // Must start with a single slash.
  if (!from.startsWith('/')) return null;

  try {
    const candidate = new URL(from, originBase);
    const base = new URL(originBase);
    if (candidate.origin !== base.origin) return null;
    // Strip the origin — return path + search + hash only.
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return null;
  }
}

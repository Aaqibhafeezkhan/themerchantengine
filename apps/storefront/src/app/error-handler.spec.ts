import { Injector, PLATFORM_ID } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StorefrontErrorHandler, sanitizeFromParam } from './error-handler';

function browserHandler(): StorefrontErrorHandler {
  return Injector.create({
    providers: [{ provide: PLATFORM_ID, useValue: 'browser' }, StorefrontErrorHandler],
  }).get(StorefrontErrorHandler);
}

describe('StorefrontErrorHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // WebKit rejects every in-flight lazy import with this TypeError when the
  // user navigates away, so it says nothing about the page being left.
  const cancelledImport = new TypeError('Importing a module script failed.');

  it('logs a failed lazy import while the page is live', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    browserHandler().handleError(cancelledImport);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('drops a failed lazy import once the page is unloading', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = browserHandler();
    window.dispatchEvent(new Event('beforeunload'));
    handler.handleError(cancelledImport);
    handler.handleError(new TypeError('Failed to fetch dynamically imported module: /x.js'));
    expect(log).not.toHaveBeenCalled();
  });

  it('drops an aborted HTTP request once the page is unloading', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = browserHandler();
    window.dispatchEvent(new Event('beforeunload'));
    handler.handleError(new HttpErrorResponse({ status: 0, url: '/v1/cart' }));
    expect(log).not.toHaveBeenCalled();
  });

  it('logs an aborted HTTP request while the page is live', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    browserHandler().handleError(new HttpErrorResponse({ status: 0, url: '/v1/cart' }));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs a real HTTP failure while the page is unloading', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = browserHandler();
    window.dispatchEvent(new Event('beforeunload'));
    handler.handleError(new HttpErrorResponse({ status: 500, url: '/v1/cart' }));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('still logs any other error while the page is unloading', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = browserHandler();
    window.dispatchEvent(new Event('beforeunload'));
    handler.handleError(new Error('boom'));
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs a failed lazy import again when beforeunload did not unload the page', () => {
    // A download link or a cancelled leave fires beforeunload and the page stays.
    vi.useFakeTimers();
    try {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const handler = browserHandler();
      window.dispatchEvent(new Event('beforeunload'));
      vi.advanceTimersByTime(5_000);
      handler.handleError(cancelledImport);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failed lazy import again after a back-forward cache restore', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = browserHandler();
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('pageshow'));
    handler.handleError(cancelledImport);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('sanitizeFromParam', () => {
  const origin = 'https://store.example';

  it('accepts same-origin path-only candidates', () => {
    expect(sanitizeFromParam('/fr/catalog', origin)).toBe('/fr/catalog');
    expect(sanitizeFromParam('/en/account/orders/AKL-1', origin)).toBe('/en/account/orders/AKL-1');
  });

  it('preserves search and hash on accepted paths', () => {
    expect(sanitizeFromParam('/en/search?q=foo&page=2', origin)).toBe('/en/search?q=foo&page=2');
    expect(sanitizeFromParam('/fr/catalog#anchor', origin)).toBe('/fr/catalog#anchor');
  });

  it('rejects null / empty input', () => {
    expect(sanitizeFromParam(null, origin)).toBeNull();
    expect(sanitizeFromParam('', origin)).toBeNull();
  });

  it('rejects non-leading-slash candidates', () => {
    expect(sanitizeFromParam('relative/path', origin)).toBeNull();
    expect(sanitizeFromParam('catalog', origin)).toBeNull();
  });

  it('rejects javascript: scheme even when wrapped', () => {
    expect(sanitizeFromParam('javascript:alert(1)', origin)).toBeNull();
    expect(sanitizeFromParam('JavaScript:void(0)', origin)).toBeNull();
  });

  it('rejects data: and vbscript: schemes', () => {
    expect(sanitizeFromParam('data:text/html,<script>x</script>', origin)).toBeNull();
    expect(sanitizeFromParam('vbscript:msgbox', origin)).toBeNull();
  });

  it('rejects protocol-relative URLs (//evil.com)', () => {
    expect(sanitizeFromParam('//evil.example/path', origin)).toBeNull();
  });

  it('rejects cross-origin absolute URLs', () => {
    expect(sanitizeFromParam('https://evil.example/path', origin)).toBeNull();
    expect(sanitizeFromParam('http://store.example.evil.com/path', origin)).toBeNull();
  });

  it('rejects non-leading-slash garbage', () => {
    expect(sanitizeFromParam('not even a url', origin)).toBeNull();
    expect(sanitizeFromParam('foo bar', origin)).toBeNull();
  });
});

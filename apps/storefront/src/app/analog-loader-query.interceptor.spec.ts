import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { requestContextInterceptor } from '@analogjs/router';
import { API_PREFIX, BASE_URL } from '@analogjs/router/tokens';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { analogLoaderQueryInterceptor } from './analog-loader-query.interceptor';
import { LOADER_QUERY_HEADER, loaderSearchParams } from '../lib/loader-query';

/**
 * The seam this guards is the one that shipped the defect: a page-endpoint
 * resolve leaving the Angular side WITH a query and arriving at the Nitro
 * endpoint WITHOUT one.
 *
 * These tests drive the real `requestContextInterceptor` from
 * `@analogjs/router`, on the real branch production takes (`global.$fetch`
 * present, `BASE_URL` provided, server platform) and assert what the endpoint
 * would actually receive. `ssr-loaders-query.spec.ts` covers the other half:
 * that the loaders read what arrives.
 *
 * The first case is a canary on the upstream bug. It went red when Analog
 * 2.9 started forwarding the query on this branch, and now asserts the fixed
 * behavior. The interceptor and `lib/loader-query.ts` are redundant on that
 * Analog version and can be deleted in a follow-up.
 */

const BASE = 'http://ssr.test';
const ENDPOINT = `${BASE}/api/_analog/pages/fr/catalog/index`;

interface CapturedFetch {
  url: string;
  headers: Record<string, string>;
}

const captured: CapturedFetch[] = [];

/**
 * Minimal stand-in for Nitro's `$fetch`. Only `.raw` is used by the branch
 * under test; it answers the shape Analog reads (`_data`, `headers`).
 */
function stubNitroFetch(): void {
  const raw = async (
    url: string,
    options: { headers?: Record<string, string> },
  ): Promise<{ _data: unknown; headers: Record<string, string> }> => {
    captured.push({ url, headers: options?.headers ?? {} });
    return { _data: { ok: true }, headers: {} };
  };
  vi.stubGlobal(
    '$fetch',
    Object.assign(async () => ({}), { raw }),
  );
}

function makeClient(platform: 'server' | 'browser'): HttpClient {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: API_PREFIX, useValue: 'api' },
      { provide: BASE_URL, useValue: BASE },
      provideHttpClient(
        withFetch(),
        withInterceptors([analogLoaderQueryInterceptor, requestContextInterceptor]),
      ),
    ],
  });
  return TestBed.inject(HttpClient);
}

beforeEach(() => {
  captured.length = 0;
  stubNitroFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

describe('analogLoaderQueryInterceptor over the real Analog resolve path', () => {
  it("now keeps the search on the fetched url (canary on Analog's fix)", async () => {
    await firstValueFrom(makeClient('server').get(`${ENDPOINT}?brand=Nike&sortBy=price`));

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('/api/_analog/pages/fr/catalog/index?brand=Nike&sortBy=price');
  });

  it('carries the search on the header the internal fetch does forward', async () => {
    await firstValueFrom(
      makeClient('server').get(`${ENDPOINT}?brand=Nike&sortBy=price&sortOrder=asc`),
    );

    expect(captured[0].headers[LOADER_QUERY_HEADER]).toBe('brand=Nike&sortBy=price&sortOrder=asc');
  });

  it('lands a query the loader can read back off the endpoint request', async () => {
    await firstValueFrom(
      makeClient('server').get(`${ENDPOINT}?brand=Nike&minPrice=50&specs=colour%3Ared`),
    );

    // The exact shape a loader sees: the url Nitro routed, plus the headers.
    const recovered = loaderSearchParams({
      url: captured[0].url,
      headers: captured[0].headers,
    });
    expect(recovered.get('brand')).toBe('Nike');
    expect(recovered.get('minPrice')).toBe('50');
    expect(recovered.get('specs')).toBe('colour:red');
  });

  it('drops the route fragment from the header', async () => {
    await firstValueFrom(makeClient('server').get(`${ENDPOINT}?brand=Nike#reviews`));

    expect(captured[0].headers[LOADER_QUERY_HEADER]).toBe('brand=Nike');
  });

  it('does not read a query out of a fragment', async () => {
    // `injectRouteEndpointURL` writes the route fragment onto the same href and
    // the hash setter leaves `?` alone, so a fragment can carry something that
    // looks like a query. Reading it would hand the loader filters the customer
    // never asked for.
    await firstValueFrom(makeClient('server').get(`${ENDPOINT}#tab?brand=Ghost`));

    expect(captured[0].headers[LOADER_QUERY_HEADER]).toBeUndefined();
  });

  it('sets no header when the resolve carries no query', async () => {
    await firstValueFrom(makeClient('server').get(ENDPOINT));

    expect(captured[0].headers[LOADER_QUERY_HEADER]).toBeUndefined();
  });

  it('sets no header in the browser, where the url reaches the endpoint intact', async () => {
    // Analog's own branch is chosen on `global.$fetch`, not on the platform, so
    // this still lands on the stub under vitest. What must differ is ours: in a
    // real browser the request goes out over HTTP with its search, and a header
    // on every navigation would be noise.
    await firstValueFrom(makeClient('browser').get(`${ENDPOINT}?brand=Nike`));

    expect(captured[0].headers[LOADER_QUERY_HEADER]).toBeUndefined();
  });
});

/**
 * Everything above builds its own injector, so it would pass even if nothing
 * registered the interceptor at all. The one line that arms the fix lives in
 * `app.config.ts`, no spec imports that file, and no e2e run can see it: the
 * suite runs against the dev server, which never takes the branch. Deleting one
 * token there restores the production outage with a fully green build. So the
 * registration is asserted on the source itself.
 */
describe('app.config.ts arms the interceptor', () => {
  const source = readFileSync(resolve(__dirname, 'app.config.ts'), 'utf8');
  const registered = /withInterceptors\(\[([\s\S]*?)\]\)/.exec(source);

  it('still calls withInterceptors with a literal list', () => {
    expect(registered, 'app.config.ts no longer registers interceptors as a list').toBeTruthy();
  });

  it('puts analogLoaderQueryInterceptor ahead of requestContextInterceptor', () => {
    const names = (registered?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const ours = names.indexOf('analogLoaderQueryInterceptor');
    const analog = names.indexOf('requestContextInterceptor');

    expect(
      ours,
      'analogLoaderQueryInterceptor is not registered, so a production build ' +
        'drops every catalogue and search query again.',
    ).toBeGreaterThanOrEqual(0);
    expect(analog, 'requestContextInterceptor is not registered').toBeGreaterThanOrEqual(0);
    expect(
      ours,
      `interceptor order is ${names.join(', ')}. requestContextInterceptor answers a ` +
        'page-endpoint resolve itself and never calls next, so anything after it ' +
        'never runs on the branch that drops the query.',
    ).toBeLessThan(analog);
  });
});

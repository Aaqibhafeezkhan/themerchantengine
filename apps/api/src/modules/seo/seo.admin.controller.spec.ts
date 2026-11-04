import { PERMISSIONS_KEY, IS_PUBLIC_KEY } from '@common/decorators';
import { SeoAdminController } from './seo.controller';

/**
 * Decorator security audit for SeoAdminController.
 *
 * Verifies every admin endpoint carries the correct @Permissions('seo:*') and
 * none is @Public(). The write endpoints (createRedirect, deleteRedirect,
 * submitSeo) must NOT be readable with the view permission. submitSeo is the
 * quota-spending manual reindex (DR-17 D2) — it must require seo:manage.
 */
describe('SeoAdminController — decorator audit', () => {
  const getMetadata = <T>(key: string, target: object, method: string): T | undefined =>
    Reflect.getMetadata(key, (target as Record<string, object>)[method]) as T | undefined;

  const proto = SeoAdminController.prototype;

  const cases: Array<{ method: string; permission: string }> = [
    { method: 'listRedirects', permission: 'seo:view' },
    { method: 'createRedirect', permission: 'seo:create' },
    { method: 'deleteRedirect', permission: 'seo:delete' },
    { method: 'getHealth', permission: 'seo:view' },
    { method: 'listSubmissions', permission: 'seo:view' },
    { method: 'submitSeo', permission: 'seo:manage' },
    { method: 'getCoverage', permission: 'seo:view' },
    { method: 'getQuota', permission: 'seo:view' },
    { method: 'getAnalytics', permission: 'seo:view' },
    { method: 'inspectUrl', permission: 'seo:view' },
    { method: 'recheckHealth', permission: 'seo:manage' },
  ];

  for (const { method, permission } of cases) {
    describe(`${method}`, () => {
      it(`requires ${permission}`, () => {
        expect(getMetadata<string[]>(PERMISSIONS_KEY, proto, method)).toContain(permission);
      });
      it('is NOT @Public()', () => {
        expect(getMetadata<boolean>(IS_PUBLIC_KEY, proto, method)).toBeUndefined();
      });
    });
  }

  it('submitSeo does not accept the view permission (write must not be view-readable)', () => {
    expect(getMetadata<string[]>(PERMISSIONS_KEY, proto, 'submitSeo')).not.toContain('seo:view');
  });

  // ── submitSeo D2-specific decorators (quota + idempotency gates) ───────────

  describe('submitSeo decorators', () => {
    // @nestjs/throttler v6 metadata keys (string literals, not exported). The ttl is in milliseconds.
    it('uses the tighter @RateLimit.SeoSubmit() group (10 / 60s), not Admin (200)', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.submitSeo)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto.submitSeo)).toBe(60_000);
      // Contrast: a read handler stays on the default Admin group (200/min).
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.listSubmissions)).toBe(200);
    });

    it('returns 200 (action endpoint, not 201 resource-creation)', () => {
      expect(Reflect.getMetadata('__httpCode__', proto.submitSeo)).toBe(200);
    });

    it('binds a custom param decorator (the X-Idempotency-Key reader) on the handler', () => {
      const args = Reflect.getMetadata('__routeArguments__', SeoAdminController, 'submitSeo') as
        | Record<string, unknown>
        | undefined;
      expect(args).toBeDefined();
      expect(Object.keys(args ?? {}).some((k) => k.includes('__customRouteArgs__'))).toBe(true);
    });
  });

  // ── recheckHealth D3-specific decorators (live-probe throttle) ──────────────

  describe('recheckHealth decorators', () => {
    it('uses the dedicated @RateLimit.SeoHealthRecheck() group (1 / 5 min), not Admin', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.recheckHealth)).toBe(1);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto.recheckHealth)).toBe(300_000);
    });

    it('returns 200 (action endpoint, not 201 resource-creation)', () => {
      expect(Reflect.getMetadata('__httpCode__', proto.recheckHealth)).toBe(200);
    });

    it('is not view-readable (live probe + snapshot write requires seo:manage)', () => {
      expect(getMetadata<string[]>(PERMISSIONS_KEY, proto, 'recheckHealth')).not.toContain(
        'seo:view',
      );
    });
  });

  // ── coverage / quota / analytics stay on the read group ─────────────────────

  describe('coverage + quota + analytics + url-inspection decorators', () => {
    it('the read handlers stay on the Admin read group (200 / min)', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.getCoverage)).toBe(200);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.getQuota)).toBe(200);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.getAnalytics)).toBe(200);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.inspectUrl)).toBe(200);
    });

    it('getAnalytics is read-only — must not require seo:manage', () => {
      expect(getMetadata<string[]>(PERMISSIONS_KEY, proto, 'getAnalytics')).not.toContain(
        'seo:manage',
      );
    });

    it('inspectUrl is read-only — must not require seo:manage', () => {
      expect(getMetadata<string[]>(PERMISSIONS_KEY, proto, 'inspectUrl')).not.toContain(
        'seo:manage',
      );
    });
  });
});

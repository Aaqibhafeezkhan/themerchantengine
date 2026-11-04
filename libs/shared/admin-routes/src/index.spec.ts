import { ADMIN_API_ROUTES, adminRoute, fillRoute } from './index';

describe('adminRoute', () => {
  it('joins base and sub with a slash', () => {
    expect(adminRoute('v1/admin/seo', 'submissions')).toBe('v1/admin/seo/submissions');
  });

  it('returns the base alone when sub is empty or omitted', () => {
    expect(adminRoute('v1/admin/countries', '')).toBe('v1/admin/countries');
    expect(adminRoute('v1/admin/countries')).toBe('v1/admin/countries');
  });
});

describe('fillRoute', () => {
  it('substitutes a single param', () => {
    expect(fillRoute('redirects/:id', { id: 'abc' })).toBe('redirects/abc');
  });

  it('substitutes multiple params', () => {
    expect(fillRoute(':id/shipments/:sid', { id: 'o1', sid: 's2' })).toBe('o1/shipments/s2');
  });

  it('URL-encodes param values', () => {
    expect(fillRoute('admin/products/:id', { id: 'a/b c' })).toBe('admin/products/a%2Fb%20c');
  });

  it('coerces numeric params to strings', () => {
    expect(fillRoute('templates/:id', { id: 42 })).toBe('templates/42');
  });

  it('strips a NestJS matcher suffix on the placeholder', () => {
    expect(fillRoute('pages/:pageSlug/sections', { pageSlug: 'home' })).toBe('pages/home/sections');
  });

  it('throws on a missing param rather than emitting a malformed URL', () => {
    expect(() => fillRoute('redirects/:id', {})).toThrow(/missing route param ":id"/);
  });

  it('leaves a template without params unchanged', () => {
    expect(fillRoute('admin/categories', {})).toBe('admin/categories');
  });
});

describe('ADMIN_API_ROUTES — behaviour-preservation pins (full path === legacy literal)', () => {
  it('base-only controller (countries)', () => {
    expect(adminRoute(ADMIN_API_ROUTES.countries.base)).toBe('v1/admin/countries');
  });

  it('dedicated module base + sub (seo)', () => {
    const R = ADMIN_API_ROUTES.seo;
    expect(adminRoute(R.base, R.submissions)).toBe('v1/admin/seo/submissions');
    expect(adminRoute(R.base, R.submit)).toBe('v1/admin/seo/submit');
    expect(adminRoute(R.base, R.coverage)).toBe('v1/admin/seo/coverage');
    expect(adminRoute(R.base, R.quota)).toBe('v1/admin/seo/quota');
    expect(adminRoute(R.base, R.analytics)).toBe('v1/admin/seo/analytics');
    expect(adminRoute(R.base, R.urlInspection)).toBe('v1/admin/seo/url-inspection');
    expect(adminRoute(R.base, R.health)).toBe('v1/admin/seo/health');
    expect(adminRoute(R.base, R.healthRecheck)).toBe('v1/admin/seo/health/recheck');
    expect(adminRoute(R.base, fillRoute(R.redirectById, { id: 'x' }))).toBe(
      'v1/admin/seo/redirects/x',
    );
  });

  it("base 'v1' controller with admin/<module> in the sub (products)", () => {
    const R = ADMIN_API_ROUTES.products;
    expect(adminRoute(R.base, R.list)).toBe('v1/admin/products');
    expect(adminRoute(R.base, fillRoute(R.variantById, { id: 'p', variantId: 'v' }))).toBe(
      'v1/admin/products/p/variants/v',
    );
  });

  it("base 'v1/admin' controller (payment-methods, reviews)", () => {
    expect(
      adminRoute(ADMIN_API_ROUTES.paymentMethods.base, ADMIN_API_ROUTES.paymentMethods.list),
    ).toBe('v1/admin/payment-methods');
    expect(
      adminRoute(
        ADMIN_API_ROUTES.reviews.base,
        fillRoute(ADMIN_API_ROUTES.reviews.reviewApprove, { id: 'r1' }),
      ),
    ).toBe('v1/admin/reviews/r1/approve');
  });

  it('wildcard-matcher param resolves for the client (storefront-config)', () => {
    const R = ADMIN_API_ROUTES.storefrontConfig;
    expect(adminRoute(R.base, fillRoute(R.pageSections, { pageSlug: 'home' }))).toBe(
      'v1/admin/storefront/pages/home/sections',
    );
  });

  it('multi-param nested route (orders shipment)', () => {
    const R = ADMIN_API_ROUTES.orders;
    expect(adminRoute(R.base, fillRoute(R.shipmentById, { id: 'o', sid: 's' }))).toBe(
      'v1/admin/orders/o/shipments/s',
    );
  });
});

import { IS_OPTIONAL_AUTH_KEY } from '@common/decorators/optional-auth.decorator';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, OWNER_GUARD_KEY } from '@common/decorators';
import { RequestMethod } from '@nestjs/common';
import { OrdersStorefrontController, OrdersAdminController } from './orders.controller';

/**
 * Decorator security audit for Orders controllers.
 *
 * Verifies:
 *  - Storefront endpoints use @OwnerGuard() for ownership verification
 *  - Storefront endpoints carry no @Permissions() decorators
 *  - Track endpoint is @Public() (no auth required)
 *  - Admin endpoints all carry @Permissions('orders:*')
 */
describe('OrdersStorefrontController — decorator audit', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = OrdersStorefrontController.prototype as any;

  const getPermissions = (method: string): string[] | undefined =>
    Reflect.getMetadata(PERMISSIONS_KEY, proto[method]) as string[] | undefined;

  const isOptionalAuth = (method: string): boolean =>
    !!(Reflect.getMetadata(IS_OPTIONAL_AUTH_KEY, proto[method]) as boolean | undefined);

  const isPublic = (method: string): boolean =>
    !!(Reflect.getMetadata(IS_PUBLIC_KEY, proto[method]) as boolean | undefined);

  const hasOwnerGuard = (method: string): boolean =>
    !!(Reflect.getMetadata(OWNER_GUARD_KEY, proto[method]) as boolean | undefined);

  const storefrontHandlers = [
    'createOrder',
    'listOrders',
    'findOne',
    'getInvoice',
    'getInvoicePdf',
    'cancelOrder',
    'retryPayment',
    'confirmPayment',
    'trackOrder',
  ];

  it('no storefront endpoint carries @Permissions()', () => {
    for (const handler of storefrontHandlers) {
      expect(getPermissions(handler)).toBeUndefined();
    }
  });

  it('trackOrder is @Public() (no auth required for order tracking)', () => {
    expect(isPublic('trackOrder')).toBe(true);
  });

  /**
   * Finding K10. The track lookup used to be `GET :orderNumber/track?email=`,
   * which put a customer's email address into the URL and therefore into the
   * access log, the referrer header and the browser history. It is a POST with
   * a body now. The route also has to be declared before `:id`, or Nest
   * matches `track` as an order id and the request never reaches this handler.
   */
  it('trackOrder is a POST that answers 200, not a GET', () => {
    expect(Reflect.getMetadata('method', proto['trackOrder'])).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', proto['trackOrder'])).toBe(200);
  });

  it('trackOrder is mounted on the bare `track` path', () => {
    expect(Reflect.getMetadata('path', proto['trackOrder'])).toBe('track');
  });

  it('declares trackOrder before the :id route that would otherwise shadow it', () => {
    const handlers = Object.getOwnPropertyNames(proto);
    expect(handlers.indexOf('trackOrder')).toBeLessThan(handlers.indexOf('findOne'));
  });

  it('retryTrackedPayment is a public POST on `track/payment`, declared before :id', () => {
    expect(isPublic('retryTrackedPayment')).toBe(true);
    expect(getPermissions('retryTrackedPayment')).toBeUndefined();
    expect(Reflect.getMetadata('method', proto['retryTrackedPayment'])).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', proto['retryTrackedPayment'])).toBe(200);
    expect(Reflect.getMetadata('path', proto['retryTrackedPayment'])).toBe('track/payment');
    const handlers = Object.getOwnPropertyNames(proto);
    expect(handlers.indexOf('retryTrackedPayment')).toBeLessThan(handlers.indexOf('findOne'));
  });

  it('listOrders has @OwnerGuard()', () => {
    expect(hasOwnerGuard('listOrders')).toBe(true);
  });

  /**
   * `findOne` and `createOrder` deliberately dropped `@OwnerGuard()` at plan F
   * phase F3, and gained `@OptionalAuth()`. They are the two guest-capable
   * routes.
   *
   * The guard is not a formality that could be left on: `OwnerGuardGuard` is a
   * real global `CanActivate` that throws `OWNER_GUARD_USER_MISSING` whenever
   * `req.user.id` is absent, so keeping it would reject every anonymous request
   * one guard after the session guard let it through. The cart controller
   * records the same precedent for the same reason.
   *
   * Ownership is enforced in `OrdersService`, which is where §3.3 puts it in
   * any case, and which is the only layer that can tell an account order
   * (matched on `userId`) from a guest order (matched on the anonymous cart
   * cookie recorded in `guestSessionId`).
   */
  it('findOne is @OptionalAuth() and NOT @OwnerGuard() — it serves guests too', () => {
    expect(isOptionalAuth('findOne')).toBe(true);
    expect(hasOwnerGuard('findOne')).toBe(false);
  });

  it('findOne is still not @Public() — a guest needs their own cart cookie', () => {
    expect(isPublic('findOne')).toBe(false);
  });

  it('getInvoice has @OwnerGuard()', () => {
    expect(hasOwnerGuard('getInvoice')).toBe(true);
  });

  it('getInvoicePdf has @OwnerGuard()', () => {
    expect(hasOwnerGuard('getInvoicePdf')).toBe(true);
  });

  it('cancelOrder has @OwnerGuard()', () => {
    expect(hasOwnerGuard('cancelOrder')).toBe(true);
  });

  it('retryPayment is a POST on `:id/payment`, @OptionalAuth() and NOT @OwnerGuard()', () => {
    expect(Reflect.getMetadata('method', proto['retryPayment'])).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('path', proto['retryPayment'])).toBe(':id/payment');
    expect(Reflect.getMetadata('__httpCode__', proto['retryPayment'])).toBe(200);
    expect(isOptionalAuth('retryPayment')).toBe(true);
    expect(hasOwnerGuard('retryPayment')).toBe(false);
    expect(isPublic('retryPayment')).toBe(false);
    expect(getPermissions('retryPayment')).toBeUndefined();
  });

  it('confirmPayment is a POST on `:id/payment/confirm`, @OptionalAuth() and NOT @OwnerGuard()', () => {
    expect(Reflect.getMetadata('method', proto['confirmPayment'])).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('path', proto['confirmPayment'])).toBe(':id/payment/confirm');
    expect(Reflect.getMetadata('__httpCode__', proto['confirmPayment'])).toBe(200);
    expect(isOptionalAuth('confirmPayment')).toBe(true);
    expect(hasOwnerGuard('confirmPayment')).toBe(false);
    expect(isPublic('confirmPayment')).toBe(false);
    expect(getPermissions('confirmPayment')).toBeUndefined();
  });

  it('createOrder is not @Public() (requires authentication)', () => {
    expect(isPublic('createOrder')).toBe(false);
  });

  it('createOrder is @OptionalAuth() and NOT @OwnerGuard() — guest checkout', () => {
    expect(isOptionalAuth('createOrder')).toBe(true);
    expect(hasOwnerGuard('createOrder')).toBe(false);
  });

  it('every other storefront order route keeps @OwnerGuard()', () => {
    // The two guest-capable routes are the exception, not a new default. If a
    // later change drops the guard from the account-only routes as well, the
    // service-layer ownership check becomes the only thing standing between a
    // customer and someone else's invoice.
    for (const handler of ['listOrders', 'getInvoice', 'getInvoicePdf', 'cancelOrder']) {
      expect(hasOwnerGuard(handler)).toBe(true);
    }
  });
});

describe('OrdersAdminController — decorator audit', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = OrdersAdminController.prototype as any;

  const getPermissions = (method: string): string[] | undefined =>
    Reflect.getMetadata(PERMISSIONS_KEY, proto[method]) as string[] | undefined;

  const viewHandlers = [
    'getStats',
    'exportCsv',
    'listOrders',
    'findOne',
    'getInvoice',
    'getInvoicePdf',
  ];
  const updateHandlers = [
    'updateStatus',
    'editOrder',
    'createShipment',
    'updateShipment',
    'addNote',
  ];

  it('all view-only handlers require orders:view permission', () => {
    for (const handler of viewHandlers) {
      expect(getPermissions(handler)).toEqual(['orders:view']);
    }
  });

  it('all mutation handlers require orders:update permission', () => {
    for (const handler of updateHandlers) {
      expect(getPermissions(handler)).toEqual(['orders:update']);
    }
  });

  it('no admin handler is @Public()', () => {
    const allHandlers = [...viewHandlers, ...updateHandlers];
    for (const handler of allHandlers) {
      const meta = Reflect.getMetadata(IS_PUBLIC_KEY, proto[handler]);
      expect(meta).toBeUndefined();
    }
  });
});

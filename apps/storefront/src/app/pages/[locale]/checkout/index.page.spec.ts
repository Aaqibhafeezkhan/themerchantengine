import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CartService,
  CheckoutService,
  OrdersService,
  STOREFRONT_API_CLIENT,
  UsersService,
  type ApiClient,
} from '@storefront-services';
import {
  StorefrontConflictError,
  StorefrontError,
  StorefrontValidationError,
} from '@storefront-types';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { renderComponent } from '../../../ui/testing';
import CheckoutPage from './index.page';
import { getChromeStrings } from '../../../../i18n';
import { buildStepSummary } from '../../../sections/checkout/step-summary';
import { fixtureMoney, fixtureRuntimeConfig } from '../../../../test-support/store-config-fixtures';

/**
 * Money assertions run under the `maghreb-ltr` scenario fixture: a
 * three-decimal currency with the narrow no-break space as its group
 * separator. The precision is the load-bearing part, because a rule that only
 * breaks at three decimals passes untested under a two-decimal store.
 */
const FIXTURE_MONEY = fixtureMoney('maghreb-ltr');

const noopApi: ApiClient = {
  get: async () => ({}) as never,
  post: async () => ({}) as never,
  patch: async () => ({}) as never,
  delete: async () => ({}) as never,
  request: async () => ({}) as never,
};

const seedCart = {
  id: 'cart-1',
  items: [
    {
      id: 'line-1',
      variantId: 'v-1',
      productSlug: 'fx-laptop',
      productName: { fr: 'Ordinateur portable', en: 'Laptop' },
      unitPrice: '1500.00',
      quantity: 1,
    },
  ],
  subtotal: '1500.00',
  discounts: [],
  total: '1500.00',
};

const emptyCart = {
  ...seedCart,
  items: [],
  subtotal: '0',
  total: '0',
};

const seedAddress = {
  id: 'addr-1',
  fullName: 'Jane Customer',
  phone: '+97412345678',
  addressLine1: '12 Pearl St',
  city: 'Lyon',
  country: 'QA',
  isDefaultShipping: true,
};

const seedRates = [
  { methodId: 'sm-standard', name: 'Standard delivery', price: '8.000', isDefault: true },
  { methodId: 'sm-express', name: 'Express delivery', price: '5.000', isDefault: false },
];

class StubCartService extends CartService {
  override async get(): Promise<never> {
    return this.cart as never;
  }
  override async estimate(query: unknown): Promise<never> {
    this.estimateCalls.push(query);
    if (this.estimateFails) throw new Error('estimate down');
    return { rates: this.rates, taxEstimate: '304.000' } as never;
  }
  cart: unknown = seedCart;
  rates: unknown = seedRates;
  estimateFails = false;
  estimateCalls: unknown[] = [];
}

class StubUsersService extends UsersService {
  meCalls = 0;
  override async getMe(): Promise<never> {
    this.meCalls += 1;
    return this.user as never;
  }
  user: unknown = {
    id: 'u-1',
    email: 'jane@example.test',
    firstName: 'Jane',
    lastName: 'Customer',
    addresses: [seedAddress],
  };
}

class StubOrdersService extends OrdersService {
  override async create(input: unknown, key: string): Promise<never> {
    this.calls.push({ input, key });
    if (this.failure === 'out-of-stock') {
      const err = new StorefrontConflictError({
        code: 'CONFLICT',
        message: 'Some items are out of stock',
        correlationId: 'c',
      });
      throw err;
    }
    return {
      id: 'ord-1',
      orderNumber: 'AKL-0001',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      items: [],
      subtotal: '1500',
      total: '1500',
      currency: 'AED',
      createdAt: '2026-04-27T00:00:00Z',
      paymentAction: this.paymentAction,
    } as never;
  }
  paymentAction: { type: string; [k: string]: unknown } = { type: 'none' };
  calls: { input: unknown; key: string }[] = [];
  failure: 'none' | 'out-of-stock' = 'none';
}

const seedSettings = {
  checkout: {
    guestCheckoutEnabled: true,
    requiredFields: ['email'],
    termsOfServiceUrl: null,
    postPurchaseRedirectUrl: null,
    checkoutMessage: null,
  },
  paymentMethods: [
    {
      code: 'cod',
      name: 'Paiement à la livraison',
      description: null,
      provider: 'cod',
      sortOrder: 0,
    },
  ],
};

class StubCheckoutService extends CheckoutService {
  override async getSettings(): Promise<never> {
    this.calls += 1;
    if (this.fails) throw new Error('settings down');
    return this.settings as never;
  }
  settings: unknown = seedSettings;
  fails = false;
  calls = 0;
}

@Component({ standalone: true, template: '<div data-testid="route-stub"></div>' })
class RouteStub {}

describe('CheckoutPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      (globalThis as unknown as { crypto: Crypto }).crypto = {
        ...globalThis.crypto,
        randomUUID: () => 'fixed-uuid' as `${string}-${string}-${string}-${string}-${string}`,
      } as Crypto;
    }
  });
  afterEach(() => TestBed.resetTestingModule());

  function commonProviders(opts: { authed?: boolean } = { authed: true }) {
    const auth = new AuthStateService();
    if (opts.authed !== false) {
      auth.setSession({
        user: { id: 'u-1', email: 'a@b.co' } as never,
      });
    }
    // The layout shell settles the boot in the app; without it here the
    // checkout bootstrap would wait forever on `whenBooted()` (finding N4).
    auth.markBooted();
    return [
      provideRouter([
        { path: 'ar/auth/login', component: RouteStub },
        { path: 'en/auth/login', component: RouteStub },
        { path: 'ar/cart', component: RouteStub },
        { path: 'en/cart', component: RouteStub },
        { path: 'ar/order-confirmation/:orderNumber', component: RouteStub },
        { path: 'en/order-confirmation/:orderNumber', component: RouteStub },
        { path: '**', component: RouteStub },
      ]),
      LocaleService,
      { provide: AuthStateService, useValue: auth },
      { provide: STOREFRONT_API_CLIENT, useValue: noopApi },
      { provide: CartService, useClass: StubCartService },
      { provide: UsersService, useClass: StubUsersService },
      { provide: OrdersService, useClass: StubOrdersService },
      { provide: CheckoutService, useClass: StubCheckoutService },
    ];
  }

  /**
   * Render and let the bootstrap settle deterministically.
   *
   * `whenStable()` alone stopped being enough once the page awaited the public
   * checkout settings before deciding anything: the boot is a chain of
   * promises, not a single tick. Awaiting the bootstrap itself pins the point
   * the page is actually ready rather than guessing at a number of flushes.
   */
  async function renderAndBoot(providers: unknown[]) {
    const fixture = await renderComponent(CheckoutPage, {}, providers);
    const cmp = fixture.componentInstance as CheckoutPage;
    await cmp['bootstrap']();
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, cmp };
  }

  it('redirects to /auth/login when anonymous and guest checkout is off', async () => {
    const providers = commonProviders({ authed: false });
    TestBed.configureTestingModule({ providers });
    const fixture = TestBed.createComponent(CheckoutPage);
    (TestBed.inject(CheckoutService) as StubCheckoutService).settings = {
      ...seedSettings,
      checkout: { ...seedSettings.checkout, guestCheckoutEnabled: false },
    };
    fixture.detectChanges();
    await (fixture.componentInstance as CheckoutPage)['bootstrap']();
    // The redirect is a `navigateByUrl` the bootstrap does not await.
    await fixture.whenStable();
    const router = TestBed.inject(Router);
    expect(router.url).toContain('/auth/login');
    expect(router.url).toContain('from=');
  });

  /**
   * Plan F phase F6, finding K3 / pass-2 D1. `guestCheckoutEnabled` was stored,
   * round-tripped by admin, and read by nothing: the storefront bounced every
   * anonymous visitor to login regardless, and `POST /v1/orders` refused them
   * one layer down.
   */
  it('lets an anonymous visitor stay on checkout when guest checkout is on', async () => {
    const fixture = await renderComponent(CheckoutPage, {}, commonProviders({ authed: false }));
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    const cmp = fixture.componentInstance as CheckoutPage;
    expect(cmp['isGuest']()).toBe(true);
    expect(cmp['state']()).toBe('ready');
    expect(TestBed.inject(Router).url).not.toContain('/auth/login');
    expect(fixture.nativeElement.querySelector('[data-testid="guest-email"]')).not.toBeNull();
  });

  it('never asks an anonymous visitor for their account', async () => {
    // `GET /v1/users/me` is `@OwnerGuard()`; calling it anonymously would 401
    // and drop the guest onto the session-expired branch.
    const providers = commonProviders({ authed: false });
    TestBed.configureTestingModule({ providers });
    const fixture = await renderComponent(CheckoutPage, {}, providers);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    expect((TestBed.inject(UsersService) as StubUsersService).meCalls).toBe(0);
  });

  it('redirects an anonymous visitor when the settings read fails', async () => {
    // Unknown is not "allowed": without the flag the page cannot tell a store
    // that permits guests from one that does not, and today's behaviour is the
    // safe direction.
    const providers = commonProviders({ authed: false });
    TestBed.configureTestingModule({ providers });
    const fixture = TestBed.createComponent(CheckoutPage);
    (TestBed.inject(CheckoutService) as StubCheckoutService).fails = true;
    fixture.detectChanges();
    await (fixture.componentInstance as CheckoutPage)['bootstrap']();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toContain('/auth/login');
  });

  it('sends the guest contact and the inline address, never an address id', async () => {
    const providers = commonProviders({ authed: false });
    TestBed.configureTestingModule({ providers });
    const { cmp } = await renderAndBoot(providers);
    cmp['onGuestContactChanged']({ email: 'buyer@example.test' });
    await cmp['onAddressSelected']({
      id: '',
      fullName: 'Guest Buyer',
      phone: '+21620123456',
      addressLine1: '12 rue de la Republique',
      city: 'Tripoli',
      postalCode: '1001',
      country: 'TN',
    } as never);
    await cmp['placeOrder']();
    const payload = (TestBed.inject(OrdersService) as StubOrdersService).calls[0]?.input as {
      guestEmail?: string;
      shippingAddressId?: string;
      shippingAddress?: { city?: string };
    };
    expect(payload.guestEmail).toBe('buyer@example.test');
    expect(payload.shippingAddressId).toBeUndefined();
    expect(payload.shippingAddress?.city).toBe('Tripoli');
  });

  it('will not place a guest order before the contact email is valid', async () => {
    const providers = commonProviders({ authed: false });
    TestBed.configureTestingModule({ providers });
    const { cmp } = await renderAndBoot(providers);
    await cmp['onAddressSelected']({ id: '', country: 'TN', city: 'Tripoli' } as never);
    await cmp['placeOrder']();
    expect((TestBed.inject(OrdersService) as StubOrdersService).calls.length).toBe(0);
  });

  it('renders the empty-cart panel when the fetched cart has zero items', async () => {
    class EmptyCartService extends StubCartService {
      override cart: unknown = emptyCart;
    }
    const providers = commonProviders().map((p) =>
      typeof p === 'object' && p !== null && 'provide' in p && p.provide === CartService
        ? { provide: CartService, useClass: EmptyCartService }
        : p,
    );
    const { fixture } = await renderAndBoot(providers);
    expect(fixture.nativeElement.querySelector('[data-testid="checkout-empty"]')).not.toBeNull();
  });

  it('renders the five accordion steps when cart + addresses load', async () => {
    const { fixture } = await renderAndBoot(commonProviders());
    const steps = fixture.nativeElement.querySelectorAll('[data-step]');
    expect(steps.length).toBe(5);
  });

  /**
   * Plan F phase F5, findings K2 (payment half), D2 and D3. The payment
   * methods an operator enables in admin reached nothing: checkout hardcoded a
   * cash-on-delivery note and placed the order whatever was configured, or
   * whether anything was.
   */
  it('preselects the single enabled method and sends its code', async () => {
    const providers = commonProviders();
    const { cmp } = await bootWithAddress(providers);
    expect(cmp['selectedPaymentCode']()).toBe('cod');
    await cmp['placeOrder']();
    const orders = TestBed.inject(OrdersService) as StubOrdersService;
    expect((orders.calls[0]?.input as { paymentMethodCode?: string }).paymentMethodCode).toBe(
      'cod',
    );
  });

  it('requires a choice when the operator enabled more than one method', async () => {
    const providers = commonProviders();
    TestBed.configureTestingModule({ providers });
    const fixture = await renderComponent(CheckoutPage, {}, providers);
    const checkout = TestBed.inject(CheckoutService) as StubCheckoutService;
    checkout.settings = {
      ...seedSettings,
      paymentMethods: [
        ...seedSettings.paymentMethods,
        { code: 'bank', name: 'Virement', description: null, provider: 'manual', sortOrder: 1 },
      ],
    };
    const cmp = fixture.componentInstance as CheckoutPage;
    await cmp['bootstrap']();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(cmp['selectedPaymentCode']()).toBeNull();
    expect(cmp['canPlaceOrder']()).toBe(false);
    cmp['onPaymentMethodSelected']('bank');
    expect(cmp['canPlaceOrder']()).toBe(true);
  });

  it('blocks the order and says so when the operator enabled no method', async () => {
    const providers = commonProviders();
    TestBed.configureTestingModule({ providers });
    const fixture = await renderComponent(CheckoutPage, {}, providers);
    const checkout = TestBed.inject(CheckoutService) as StubCheckoutService;
    checkout.settings = { ...seedSettings, paymentMethods: [] };
    const cmp = fixture.componentInstance as CheckoutPage;
    await cmp['bootstrap']();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(cmp['canPlaceOrder']()).toBe(false);
    // Not a silent cash-on-delivery order: the page says why, at the top,
    // before the customer fills in an address (finding D2).
    expect(
      fixture.nativeElement.querySelector('[data-testid="checkout-payment-unavailable"]'),
    ).not.toBeNull();
    await cmp['placeOrder']();
    expect((TestBed.inject(OrdersService) as StubOrdersService).calls.length).toBe(0);
  });

  it('does not strand checkout when the settings fetch fails', async () => {
    // The settings read is an enhancement to the page, not a precondition for
    // rendering it; the API validates the tender again on create anyway.
    const providers = commonProviders();
    TestBed.configureTestingModule({ providers });
    const fixture = await renderComponent(CheckoutPage, {}, providers);
    const checkout = TestBed.inject(CheckoutService) as StubCheckoutService;
    checkout.fails = true;
    const cmp = fixture.componentInstance as CheckoutPage;
    await cmp['bootstrap']();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(cmp['state']()).toBe('ready');
    expect(cmp['settingsFailed']()).toBe(true);
    // A failed settings read is not a store with no tender: the blocking
    // banner must not fire on it.
    expect(
      fixture.nativeElement.querySelector('[data-testid="checkout-payment-unavailable"]'),
    ).toBeNull();
  });

  /**
   * Finding D3. `GET /v1/cart/estimate` was already called on address select
   * and its `rates` array thrown on the floor, so a zone with two active
   * methods offered neither and every order silently recorded the zone
   * default. These pin the four halves of the fix: keep the rates, preselect
   * the default, re-quote when the address changes, and send the choice.
   */
  async function bootWithAddress(providers: unknown[]) {
    const { fixture, cmp } = await renderAndBoot(providers);
    await cmp['onAddressSelected'](seedAddress as never);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, cmp };
  }

  it('keeps the quoted rates and preselects the default method', async () => {
    const { cmp } = await bootWithAddress(commonProviders());
    expect((cmp['shippingRates']() as { methodId: string }[]).map((r) => r.methodId)).toEqual([
      'sm-standard',
      'sm-express',
    ]);
    expect(cmp['selectedShippingMethodId']()).toBe('sm-standard');
  });

  it('sends the chosen shippingMethodId on POST /v1/orders', async () => {
    const providers = commonProviders();
    const { cmp } = await bootWithAddress(providers);
    cmp['onShippingMethodSelected']('sm-express');
    await cmp['placeOrder']();
    const orders = TestBed.inject(OrdersService) as StubOrdersService;
    expect((orders.calls[0]?.input as { shippingMethodId?: string }).shippingMethodId).toBe(
      'sm-express',
    );
  });

  it('adds a freshly saved address to the picker list so it shows as a card', async () => {
    const { cmp } = await bootWithAddress(commonProviders());
    const added = { ...seedAddress, id: 'addr-new', isDefaultShipping: false };
    cmp['onAddressSaved'](added as never);
    const ids = (cmp['addresses']() as { id: string }[]).map((a) => a.id);
    expect(ids).toContain('addr-new');
    expect(ids.filter((id) => id === 'addr-new').length).toBe(1);
    cmp['onAddressSaved'](added as never);
    expect((cmp['addresses']() as { id: string }[]).length).toBe(ids.length);
  });

  it('re-quotes and drops a stale selection when the address changes', async () => {
    const providers = commonProviders();
    const { cmp } = await bootWithAddress(providers);
    cmp['onShippingMethodSelected']('sm-express');
    const cart = TestBed.inject(CartService) as StubCartService;
    // The picker auto-selects the default address on init, so the baseline
    // call count is whatever the boot already made.
    const before = cart.estimateCalls.length;
    cart.rates = [{ methodId: 'sm-other', name: 'Other', price: '12.000', isDefault: true }];
    await cmp['onAddressSelected']({ ...seedAddress, id: 'addr-2', country: 'FR' } as never);
    expect(cart.estimateCalls.length).toBe(before + 1);
    expect((cart.estimateCalls.at(-1) as { country: string }).country).toBe('FR');
    expect(cmp['selectedShippingMethodId']()).toBe('sm-other');
  });

  it('surfaces a retry state instead of a silent default when the quote fails', async () => {
    const providers = commonProviders();
    TestBed.configureTestingModule({ providers });
    const fixture = await renderComponent(CheckoutPage, {}, providers);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    const cart = TestBed.inject(CartService) as StubCartService;
    cart.estimateFails = true;
    const cmp = fixture.componentInstance as CheckoutPage;
    await cmp['onAddressSelected'](seedAddress as never);
    expect(cmp['shippingQuoteFailed']()).toBe(true);
    expect(cmp['selectedShippingMethodId']()).toBeNull();
  });

  it('threads a stable idempotency-key through orders.create on submit', async () => {
    const providers = commonProviders();
    TestBed.configureTestingModule({ providers });
    const { fixture, cmp } = await renderAndBoot(providers);
    cmp['advanceFromStep'](1);
    cmp['advanceFromStep'](2);
    fixture.detectChanges();
    await cmp['placeOrder']();
    const orders = TestBed.inject(OrdersService) as StubOrdersService;
    expect(orders.calls.length).toBe(1);
    expect(orders.calls[0]?.key).toBe(cmp['idempotencyKey']());
    expect(typeof orders.calls[0]?.key).toBe('string');
  });

  it('surfaces an inline OUT_OF_STOCK error and does not navigate on 409', async () => {
    const providers = commonProviders();
    TestBed.configureTestingModule({ providers });
    const { cmp } = await renderAndBoot(providers);
    const orders = TestBed.inject(OrdersService) as StubOrdersService;
    orders.failure = 'out-of-stock';
    cmp['advanceFromStep'](1);
    cmp['advanceFromStep'](2);
    await cmp['placeOrder']();
    expect(cmp['errorMessage']()).not.toBeNull();
    const router = TestBed.inject(Router);
    expect(router.url).not.toContain('/order-confirmation');
  });

  it('surfaces a generic payment-refused error for non-stock 409 conflicts', async () => {
    class GenericConflictOrders extends StubOrdersService {
      override async create(): Promise<never> {
        throw new StorefrontConflictError({
          code: 'CONFLICT',
          message: 'something else went wrong',
          correlationId: 'c',
        });
      }
    }
    const providers = commonProviders().map((p) =>
      typeof p === 'object' && p !== null && 'provide' in p && p.provide === OrdersService
        ? { provide: OrdersService, useClass: GenericConflictOrders }
        : p,
    );
    const { cmp } = await renderAndBoot(providers);
    cmp['advanceFromStep'](1);
    cmp['advanceFromStep'](2);
    await cmp['placeOrder']();
    expect(cmp['errorMessage']()).not.toBeNull();
    const router = TestBed.inject(Router);
    expect(router.url).not.toContain('/order-confirmation');
  });

  /**
   * Full-stack audit B1 rows #6-8 — backend now emits typed order codes on
   * the three failure surfaces. `placeOrderErrorMessageFor` maps each to a
   * dedicated localized message instead of routing every 409 through the
   * paymentRefused string. The three tests pin: cart-empty (400), insufficient-
   * stock (409 with the new code), and idempotency-in-flight (409 with the
   * new code). The payment-refused test above keeps its meaning as the
   * fallback path for generic 409s with `code: 'CONFLICT'`.
   */
  async function placeOrderWithError(failure: StorefrontConflictError | Error): Promise<string> {
    class ErrorOrders extends StubOrdersService {
      override async create(): Promise<never> {
        throw failure;
      }
    }
    const providers = commonProviders().map((p) =>
      typeof p === 'object' && p !== null && 'provide' in p && p.provide === OrdersService
        ? { provide: OrdersService, useClass: ErrorOrders }
        : p,
    );
    const { cmp } = await renderAndBoot(providers);
    cmp['advanceFromStep'](1);
    cmp['advanceFromStep'](2);
    await cmp['placeOrder']();
    return cmp['errorMessage']() ?? '';
  }

  /**
   * Plan F phase F7, finding D1. `checkoutMessage` and `termsOfServiceUrl` are
   * the last two settings the admin wrote into a void: the DTO documents the
   * message as "shown above the payment methods block", and nothing rendered
   * it anywhere.
   */
  it('renders the operator checkout message above the payment methods', async () => {
    const providers = commonProviders();
    TestBed.configureTestingModule({ providers });
    const fixture = await renderComponent(CheckoutPage, {}, providers);
    (TestBed.inject(CheckoutService) as StubCheckoutService).settings = {
      ...seedSettings,
      checkout: { ...seedSettings.checkout, checkoutMessage: 'Paiement uniquement en dinars.' },
    };
    const cmp = fixture.componentInstance as CheckoutPage;
    await cmp['bootstrap']();
    cmp['goToStep'](4);
    fixture.detectChanges();
    await fixture.whenStable();
    const note = fixture.nativeElement.querySelector('[data-testid="checkout-message"]');
    expect(note?.textContent?.trim()).toBe('Paiement uniquement en dinars.');
  });

  it('renders no operator message when the setting is unset', async () => {
    const { fixture, cmp } = await renderAndBoot(commonProviders());
    cmp['goToStep'](4);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="checkout-message"]')).toBeNull();
  });

  it('hands the configured terms URL to the consent line, and null when unset', async () => {
    const providers = commonProviders();
    TestBed.configureTestingModule({ providers });
    const fixture = await renderComponent(CheckoutPage, {}, providers);
    const checkout = TestBed.inject(CheckoutService) as StubCheckoutService;
    const cmp = fixture.componentInstance as CheckoutPage;

    await cmp['bootstrap']();
    expect(cmp['termsHref']()).toBeNull();

    checkout.settings = {
      ...seedSettings,
      checkout: { ...seedSettings.checkout, termsOfServiceUrl: 'https://example.test/cgv' },
    };
    await cmp['bootstrap']();
    expect(cmp['termsHref']()).toBe('https://example.test/cgv');
  });

  it('maps ORDER_INSUFFICIENT_STOCK to the localized outOfStock error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontConflictError({
        code: 'ORDER_INSUFFICIENT_STOCK',
        message: 'Some items are out of stock',
      }),
    );
    // The checkout suite renders in the default FR locale; assert against
    // the FR i18n string for `checkout.errors.outOfStock` so the test
    // covers the surface the audit specifically tracks.
    expect(msg).toBe('Un ou plusieurs articles de votre panier viennent de passer en rupture.');
  });

  it('maps ORDER_CART_EMPTY to the localized cartEmpty error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontValidationError({
        code: 'ORDER_CART_EMPTY',
        message: 'Cart is empty',
      }),
    );
    expect(msg).toBe('Votre panier est vide. Ajoutez un article avant de commander.');
  });

  it('maps ORDER_IDEMPOTENCY_IN_PROGRESS to the localized idempotencyInFlight error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontConflictError({
        code: 'ORDER_IDEMPOTENCY_IN_PROGRESS',
        message: 'Order creation already in progress for this idempotency key',
      }),
    );
    expect(msg).toBe(
      'Nous traitons encore votre tentative précédente. Patientez un instant et réessayez.',
    );
  });

  it('maps SHIPPING_METHOD_INVALID to its own localized error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontValidationError({
        code: 'SHIPPING_METHOD_INVALID',
        message: 'Shipping method is not valid for this destination',
      }),
    );
    expect(msg).toBe('Ce mode de livraison n’est plus disponible. Choisissez-en un à nouveau.');
  });

  it('maps SHIPPING_UNAVAILABLE to its own localized error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontValidationError({
        code: 'SHIPPING_UNAVAILABLE',
        message: 'No shipping method available',
      }),
    );
    expect(msg).toBe('Nous ne livrons pas encore à cette adresse.');
  });

  it('maps ORDER_PAYMENT_METHOD_INVALID to its own localized error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontValidationError({
        code: 'ORDER_PAYMENT_METHOD_INVALID',
        message: 'Selected payment method is not available',
      }),
    );
    expect(msg).toBe('Ce moyen de paiement n’est plus disponible. Choisissez-en un à nouveau.');
  });

  it('maps ORDER_PAYMENT_METHOD_UNAVAILABLE to its own localized error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontValidationError({
        code: 'ORDER_PAYMENT_METHOD_UNAVAILABLE',
        message: 'No payment method is available',
      }),
    );
    expect(msg).toBe(
      'Aucun moyen de paiement n’est disponible pour le moment, cette commande ne peut pas être validée.',
    );
  });

  it('maps ORDER_GUEST_CHECKOUT_DISABLED to its own localized error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontValidationError({
        code: 'ORDER_GUEST_CHECKOUT_DISABLED',
        message: 'Guest checkout is not available',
      }),
    );
    expect(msg).toBe(
      'La commande sans compte n’est pas disponible. Connectez-vous pour continuer.',
    );
  });

  it('maps ORDER_PAYMENT_NOT_RETRYABLE to its own localized error (fr default)', async () => {
    const msg = await placeOrderWithError(
      new StorefrontConflictError({
        code: 'ORDER_PAYMENT_NOT_RETRYABLE',
        message: 'This order payment cannot be retried',
      }),
    );
    expect(msg).toBe(
      'Le paiement de cette commande ne peut plus être relancé. Contactez-nous si besoin.',
    );
  });

  it.each([
    'PAYMENT_PROVIDER_UNAVAILABLE',
    'PAYMENT_PROVIDER_REJECTED',
    'PAYMENT_CONFIG_ENCRYPTION_UNAVAILABLE',
    'PAYMENT_PROVIDER_UNKNOWN',
    'ORDER_PAYMENT_NOT_OPENED',
  ])('maps %s to the payment provider unavailable error (fr default)', async (code) => {
    const msg = await placeOrderWithError(
      new StorefrontError({ code, message: 'provider down', status: 503 }),
    );
    expect(msg).toBe(
      'Le paiement par carte est momentanément indisponible. Réessayez plus tard ou choisissez un autre moyen de paiement.',
    );
  });

  it('keeps the customer on the page with the embedded payment set for an embedded action', async () => {
    class EmbeddedOrders extends StubOrdersService {
      override paymentAction = { type: 'embedded', clientToken: 'tok_1' };
    }
    const providers = commonProviders().map((p) =>
      typeof p === 'object' && p !== null && 'provide' in p && p.provide === OrdersService
        ? { provide: OrdersService, useClass: EmbeddedOrders }
        : p,
    );
    const { cmp } = await renderAndBoot(providers);
    cmp['advanceFromStep'](1);
    cmp['advanceFromStep'](2);
    await cmp['placeOrder']();
    expect(cmp['embeddedPayment']()).toEqual({
      orderId: 'ord-1',
      orderNumber: 'AKL-0001',
      action: { type: 'embedded', clientToken: 'tok_1' },
    });
  });

  it('leaves embeddedPayment unset when no payment step is needed', async () => {
    const { cmp } = await renderAndBoot(commonProviders());
    cmp['advanceFromStep'](1);
    cmp['advanceFromStep'](2);
    await cmp['placeOrder']();
    expect(cmp['embeddedPayment']()).toBeNull();
  });

  it('reuses the same idempotency-key across a second bootstrap cycle', async () => {
    const providers = commonProviders();
    const { cmp } = await renderAndBoot(providers);
    const firstKey = cmp['idempotencyKey']();
    expect(typeof firstKey).toBe('string');
    expect(firstKey?.length).toBeGreaterThan(0);
    await cmp['bootstrap']();
    expect(cmp['idempotencyKey']()).toBe(firstKey);
  });
});

/**
 * Finding K3. The collapsed step-2 chip read the item count and nothing else,
 * so a shopper who had folded the summary away had no figure in front of them
 * on the step where they commit to paying it. It now carries the count and the
 * tax-inclusive total, which is the number the order will actually charge.
 *
 * Tested through `buildStepSummary`, which is what the page's `step2Summary`
 * computed calls. Driving a whole checkout to read one string would test the
 * fixtures rather than the recap.
 */
describe('CheckoutPage collapsed summary recap (K3)', () => {
  function recapFor(cart: Record<string, unknown> | null): string | null {
    // The fixture's own tax posture, not a literal: the mention the recap
    // renders follows `money.taxDisplay` since plan E2.5 (B2.9).
    return buildStepSummary(
      cart as never,
      getChromeStrings('en'),
      FIXTURE_MONEY,
      fixtureRuntimeConfig('maghreb-ltr').money.taxDisplay,
    );
  }

  it('reads the count and the TTC total for a multi-line cart', () => {
    const recap = recapFor({
      items: [{ id: 'a' }, { id: 'b' }],
      currency: FIXTURE_MONEY.currencyCode,
      grandTotalTtc: 424.5,
    });
    expect(recap).toContain('2 items');
    expect(recap).toContain('424,500');
    expect(recap).toContain(getChromeStrings('en').generic.taxIncluded);
  });

  it('keeps the singular wording for a one-line cart', () => {
    const recap = recapFor({
      items: [{ id: 'a' }],
      currency: FIXTURE_MONEY.currencyCode,
      grandTotalTtc: 99,
    });
    expect(recap).toContain('1 item');
    expect(recap).not.toContain('1 items');
  });

  it('falls back through the pre-tax totals rather than reading zero', () => {
    // `grandTotalTtc` is absent until a tax zone resolves. Same ladder the order
    // summary walks, so the collapsed recap and the open one cannot disagree.
    const recap = recapFor({
      items: [{ id: 'a' }],
      currency: FIXTURE_MONEY.currencyCode,
      grandTotal: 100,
    });
    expect(recap).toContain('100,000');
  });

  it('renders no recap at all without a cart', () => {
    expect(recapFor(null)).toBeNull();
  });
});

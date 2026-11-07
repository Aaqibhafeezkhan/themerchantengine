import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CheckoutService,
  OrdersService,
  STOREFRONT_API_CLIENT,
  type ApiClient,
} from '@storefront-services';
import { StorefrontUnauthorizedError, type PaymentAction } from '@storefront-types';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { renderComponent } from '../../../ui/testing';
import OrderConfirmationPage from './[orderNumber].page';
import { getChromeStrings } from '../../../../i18n';
import {
  fixtureRuntimeConfig,
  provideFixtureStoreConfig,
} from '../../../../test-support/store-config-fixtures';

const noopApi: ApiClient = {
  get: async () => ({}) as never,
  post: async () => ({}) as never,
  patch: async () => ({}) as never,
  delete: async () => ({}) as never,
  request: async () => ({}) as never,
};

const seedOrder = {
  id: 'ord-1',
  orderNumber: 'AKL-0001',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  items: [
    {
      id: 'line-1',
      productId: 'p-1',
      variantId: 'v-1',
      productSlug: 'fx-laptop',
      productName: { fr: 'Ordinateur portable', en: 'Laptop' },
      quantity: 1,
      unitPrice: '1500',
      lineTotal: '1500',
    },
  ],
  subtotal: '1500',
  total: '1500',
  currency: 'AED',
  shippingAddress: {
    fullName: 'Jane Customer',
    addressLine1: '12 Pearl St',
    city: 'Lyon',
    country: 'QA',
  },
  createdAt: '2026-04-27T00:00:00Z',
};

class StubOrdersService extends OrdersService {
  override async getById(id: string): Promise<never> {
    if (this.failure === 'not-found' && id === 'ord-missing') {
      throw new Error('not found');
    }
    return this.order as never;
  }
  order: unknown = seedOrder;
  confirmCalls: string[] = [];
  retryCalls: string[] = [];
  confirmResult: string | Error = 'CAPTURED';
  retryResult: PaymentAction | Error = { type: 'redirect', url: 'https://pay.example/retry' };
  override async confirmPayment(id: string, key: string): Promise<string> {
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    this.confirmCalls.push(id);
    if (this.confirmResult instanceof Error) throw this.confirmResult;
    return this.confirmResult;
  }
  override async retryPayment(id: string, key: string): Promise<PaymentAction> {
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    this.retryCalls.push(id);
    if (this.retryResult instanceof Error) throw this.retryResult;
    return this.retryResult;
  }
  override async list(): Promise<never> {
    return { data: [seedOrder], meta: { page: 1, pageSize: 5, total: 1, totalPages: 1 } } as never;
  }
  failure: 'none' | 'not-found' = 'none';
}

const seedSettings = {
  checkout: {
    guestCheckoutEnabled: true,
    requiredFields: ['email'],
    termsOfServiceUrl: null,
    postPurchaseRedirectUrl: null,
    checkoutMessage: null,
  },
  paymentMethods: [],
};

class StubCheckoutService extends CheckoutService {
  override async getSettings(): Promise<never> {
    if (this.fails) throw new Error('settings down');
    return this.settings as never;
  }
  settings: unknown = seedSettings;
  fails = false;
}

@Component({ standalone: true, template: '<div data-testid="route-stub"></div>' })
class RouteStub {}

function makeRoute(orderNumber: string | null): ActivatedRoute {
  return {
    snapshot: {
      paramMap: convertToParamMap(orderNumber ? { orderNumber } : {}),
      url: [{ path: 'order-confirmation' }, { path: orderNumber ?? '' }],
    },
  } as unknown as ActivatedRoute;
}

describe('OrderConfirmationPage', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  function commonProviders(orderNumber: string | null = 'AKL-0001', authed = true) {
    const auth = new AuthStateService();
    if (authed) {
      auth.setSession({
        user: { id: 'u-1', email: 'a@b.co' } as never,
      });
    }
    // The page waits on the boot OUTCOME before deciding who the visitor is
    // (finding N4); without this the bootstrap would wait forever here.
    auth.markBooted();
    return [
      provideRouter([
        { path: 'ar/auth/login', component: RouteStub },
        { path: 'en/auth/login', component: RouteStub },
        { path: 'ar/account/orders/:id', component: RouteStub },
        { path: 'en/account/orders/:id', component: RouteStub },
        { path: '**', component: RouteStub },
      ]),
      LocaleService,
      { provide: AuthStateService, useValue: auth },
      { provide: STOREFRONT_API_CLIENT, useValue: noopApi },
      { provide: OrdersService, useClass: StubOrdersService },
      { provide: CheckoutService, useClass: StubCheckoutService },
      { provide: ActivatedRoute, useValue: makeRoute(orderNumber) },
    ];
  }

  it('renders the order summary after fetch resolves', async () => {
    const fixture = await renderComponent(OrderConfirmationPage, {}, commonProviders('AKL-0001'));
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    const number = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-number"]',
    ) as HTMLElement;
    expect(number?.textContent).toContain('AKL-0001');
    const total = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-total"]',
    ) as HTMLElement;
    expect(total?.textContent).toMatch(/AED|د\.إ/);
  });

  it('renders the not-found panel when the orderNumber param is missing', async () => {
    const fixture = await renderComponent(OrderConfirmationPage, {}, commonProviders(null));
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('[data-testid="order-confirmation-not-found"]'),
    ).not.toBeNull();
  });

  /**
   * Plan F phase F6, finding K3. This page hard-redirected every anonymous
   * visitor to login, so a guest landed on a login wall one second after
   * paying. It no longer does: with the order id from the create navigation it
   * reads the order back through the now guest-capable `GET /v1/orders/:id`,
   * and without one it offers the public track page instead of a login form.
   */
  it('renders a guest order from the create-navigation hint, with no login wall', async () => {
    history.replaceState({ orderId: 'ord-1' }, '');
    const fixture = await renderComponent(
      OrderConfirmationPage,
      {},
      commonProviders('AKL-0001', false),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).not.toContain('/auth/login');
    const number = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-number"]',
    ) as HTMLElement;
    expect(number?.textContent).toContain('AKL-0001');
    history.replaceState({}, '');
  });

  // Finding C24/C30. Stripe appends the PaymentIntent client secret to the
  // return URL; it must not stay in the address bar, history or a shared link.
  it('removes the provider return params from the address bar and keeps the rest', async () => {
    history.replaceState(
      { orderId: 'ord-1' },
      '',
      '/en/order-confirmation/AKL-0001?payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x&redirect_status=succeeded&ref=mail',
    );
    const fixture = await renderComponent(OrderConfirmationPage, {}, commonProviders('AKL-0001'));
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(window.location.search).toBe('?ref=mail');
    expect(history.state).toMatchObject({ orderId: 'ord-1' });
    history.replaceState({}, '', '/');
  });

  it('offers the public track page to an anonymous visitor with no hint', async () => {
    history.replaceState({}, '');
    const fixture = await renderComponent(
      OrderConfirmationPage,
      {},
      commonProviders('AKL-0001', false),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).not.toContain('/auth/login');
    const panel = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-guest-track"]',
    ) as HTMLElement;
    expect(panel).not.toBeNull();
    // The order number is in the URL, so the link carries it rather than
    // asking the customer to retype it.
    const link = panel.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('AKL-0001');
  });

  it('still sends an anonymous visitor to login when the order is not a guest order', async () => {
    // A 401 from the order read means the row belongs to an account. Login is
    // the right remedy for that one, and only that one.
    history.replaceState({ orderId: 'ord-1' }, '');
    class UnauthorizedOrders extends StubOrdersService {
      override async getById(): Promise<never> {
        throw new StorefrontUnauthorizedError({ code: 'UNAUTHORIZED', message: 'no' });
      }
    }
    const providers = commonProviders('AKL-0001', false).map((p) =>
      typeof p === 'object' && p !== null && 'provide' in p && p.provide === OrdersService
        ? { provide: OrdersService, useClass: UnauthorizedOrders }
        : p,
    );
    const fixture = await renderComponent(OrderConfirmationPage, {}, providers);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toContain('/auth/login');
    history.replaceState({}, '');
  });

  /**
   * Plan F phase F7, finding D1. `postPurchaseRedirectUrl` was the last setting
   * with no consumer at all. It overrides the continue-shopping CTA and nothing
   * more: an automatic redirect would destroy the confirmation surface, the
   * order-number handoff and this page's whole e2e contract (decision K-F6).
   */
  it('points the continue-shopping CTA at the operator URL when one is set', async () => {
    const providers = commonProviders('AKL-0001');
    TestBed.configureTestingModule({ providers });
    const fixture = TestBed.createComponent(OrderConfirmationPage);
    (TestBed.inject(CheckoutService) as StubCheckoutService).settings = {
      ...seedSettings,
      checkout: { ...seedSettings.checkout, postPurchaseRedirectUrl: 'https://example.test/merci' },
    };
    fixture.detectChanges();
    await (fixture.componentInstance as OrderConfirmationPage)['bootstrap']();
    fixture.detectChanges();
    await fixture.whenStable();
    const cta = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-home"]',
    ) as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('https://example.test/merci');
    // An off-site URL cannot go through routerLink, which would read it as an
    // in-app path.
    expect(cta.getAttribute('rel')).toBe('noopener');
  });

  it('keeps the home CTA when the operator set no redirect', async () => {
    const fixture = await renderComponent(OrderConfirmationPage, {}, commonProviders('AKL-0001'));
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    const cta = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-home"]',
    ) as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/fr');
  });

  it('never redirects on its own, whatever the setting says', async () => {
    const providers = commonProviders('AKL-0001');
    TestBed.configureTestingModule({ providers });
    const fixture = TestBed.createComponent(OrderConfirmationPage);
    (TestBed.inject(CheckoutService) as StubCheckoutService).settings = {
      ...seedSettings,
      checkout: { ...seedSettings.checkout, postPurchaseRedirectUrl: 'https://example.test/merci' },
    };
    fixture.detectChanges();
    await (fixture.componentInstance as OrderConfirmationPage)['bootstrap']();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('[data-testid="order-confirmation-number"]'),
    ).not.toBeNull();
  });

  it('exposes a tracking link to /account/orders/:id and a continue-shopping link', async () => {
    const fixture = await renderComponent(OrderConfirmationPage, {}, commonProviders('AKL-0001'));
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    const tracking = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-tracking"]',
    ) as HTMLAnchorElement;
    expect(tracking?.getAttribute('href')).toContain('/account/orders/ord-1');
    const home = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-home"]',
    ) as HTMLAnchorElement;
    expect(home?.getAttribute('href')).toMatch(/^\/(fr|en)\/?$/);
  });

  /**
   * Finding N3. The public track page had zero inbound links anywhere in the
   * app. The confirmation page is the one surface that has the order number in
   * hand and serves the person most likely to lose their session, so it is the
   * page's legitimate entrance. The existing tracking CTA goes to the authed
   * order-detail route and stays there.
   */
  /**
   * Finding K7. The confirmation is the page a customer reads seconds after
   * placing the order, and it did not say how they were paying.
   */
  it('names the payment method in the summary', async () => {
    const fixture = await renderComponent(OrderConfirmationPage, {}, commonProviders('AKL-0001'));
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();

    const row = fixture.nativeElement.querySelector('[data-testid="order-confirmation-payment"]');
    expect(row).not.toBeNull();
    // Read through the locale the suite actually renders under, rather than
    // pinning `fr`: this file uses the real LocaleService and its default is
    // the store's, not this test's business.
    const locale = TestBed.inject(LocaleService).locale();
    expect(row.textContent).toContain(
      getChromeStrings(locale).account.orderDetail.payment.cashOnDelivery,
    );
  });

  describe('payment state', () => {
    const pendingOrder = {
      ...seedOrder,
      paymentStatus: 'PENDING',
      paymentMethodCode: 'card',
      paymentRetryable: true,
    };

    async function render(stub: StubOrdersService) {
      const fixture = await renderComponent(OrderConfirmationPage, {}, [
        ...commonProviders('AKL-0001'),
        { provide: OrdersService, useValue: stub },
      ]);
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      return fixture;
    }

    function makeStub(order: unknown): StubOrdersService {
      const stub = new StubOrdersService(noopApi);
      stub.order = order;
      return stub;
    }

    it('re-reads the payment status once when the order is still payable', async () => {
      const stub = makeStub(pendingOrder);
      const fixture = await render(stub);
      expect(stub.confirmCalls).toEqual(['ord-1']);
      const status = fixture.nativeElement.querySelector(
        '[data-testid="order-confirmation-payment-status"]',
      ) as HTMLElement;
      const locale = TestBed.inject(LocaleService).locale();
      expect(status.textContent).toContain(
        getChromeStrings(locale).orderConfirmation.paymentStatus.CAPTURED,
      );
    });

    it('does not ask the provider again for an order that is not retryable', async () => {
      const stub = makeStub({ ...seedOrder, paymentStatus: 'CAPTURED', paymentRetryable: false });
      await render(stub);
      expect(stub.confirmCalls).toEqual([]);
    });

    it('does not call a cancelled order confirmed and offers no pay again', async () => {
      const stub = makeStub({ ...pendingOrder, status: 'CANCELLED', paymentRetryable: false });
      const fixture = await render(stub);
      const strings = getChromeStrings(TestBed.inject(LocaleService).locale());
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('.heading')?.textContent).toContain(
        strings.orderConfirmation.cancelledHeading,
      );
      expect(root.querySelector('.heading')?.textContent).not.toContain(
        strings.orderConfirmation.heading,
      );
      expect(root.querySelector('[data-testid="order-confirmation-pay-again"]')).toBeNull();
    });

    it('says pay on delivery, not waiting for payment, for an offline method', async () => {
      const stub = makeStub({
        ...seedOrder,
        paymentStatus: 'PENDING',
        paymentMethodCode: 'cod',
        paymentRetryable: false,
      });
      const fixture = await render(stub);
      const strings = getChromeStrings(TestBed.inject(LocaleService).locale());
      const text = (
        fixture.nativeElement.querySelector(
          '[data-testid="order-confirmation-payment-status"]',
        ) as HTMLElement
      ).textContent;
      expect(text).toContain(strings.orderConfirmation.paymentOnDelivery);
      expect(text).not.toContain(strings.orderConfirmation.paymentStatus.PENDING);
    });

    it('shows the pay again button only while the order is retryable', async () => {
      const stub = makeStub(pendingOrder);
      stub.confirmResult = 'PENDING';
      const fixture = await render(stub);
      expect(
        fixture.nativeElement.querySelector('[data-testid="order-confirmation-pay-again"]'),
      ).not.toBeNull();

      const paid = makeStub({
        ...pendingOrder,
        paymentStatus: 'CAPTURED',
        paymentRetryable: false,
      });
      TestBed.resetTestingModule();
      const paidFixture = await render(paid);
      expect(
        paidFixture.nativeElement.querySelector('[data-testid="order-confirmation-pay-again"]'),
      ).toBeNull();
    });

    it.each(['AUTHORIZED', 'CAPTURED'])(
      'hides pay again once the return confirmation says %s',
      async (confirmed) => {
        const stub = makeStub(pendingOrder);
        stub.confirmResult = confirmed;
        const fixture = await render(stub);
        expect(stub.confirmCalls).toEqual(['ord-1']);
        expect(
          fixture.nativeElement.querySelector('[data-testid="order-confirmation-pay-again"]'),
        ).toBeNull();
      },
    );

    it('keeps pay again when the return confirmation says FAILED', async () => {
      const stub = makeStub(pendingOrder);
      stub.confirmResult = 'FAILED';
      const fixture = await render(stub);
      expect(
        fixture.nativeElement.querySelector('[data-testid="order-confirmation-pay-again"]'),
      ).not.toBeNull();
    });

    it('runs the retry result through the payment action handler', async () => {
      const stub = makeStub(pendingOrder);
      stub.confirmResult = 'FAILED';
      stub.retryResult = { type: 'embedded', clientToken: 'tok', publicConfig: {} } as never;
      const fixture = await render(stub);
      (
        fixture.nativeElement.querySelector(
          '[data-testid="order-confirmation-pay-again"]',
        ) as HTMLButtonElement
      ).click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(stub.retryCalls).toEqual(['ord-1']);
      expect(
        fixture.nativeElement.querySelector('[data-testid="order-confirmation-embedded"]'),
      ).not.toBeNull();
    });

    it('maps ORDER_PAYMENT_NOT_RETRYABLE to a localized message', async () => {
      const stub = makeStub(pendingOrder);
      stub.confirmResult = 'PENDING';
      stub.retryResult = Object.assign(new Error('nope'), { code: 'ORDER_PAYMENT_NOT_RETRYABLE' });
      const fixture = await render(stub);
      (
        fixture.nativeElement.querySelector(
          '[data-testid="order-confirmation-pay-again"]',
        ) as HTMLButtonElement
      ).click();
      await fixture.whenStable();
      fixture.detectChanges();
      const locale = TestBed.inject(LocaleService).locale();
      const alert = fixture.nativeElement.querySelector(
        '[data-testid="order-confirmation-payment-error"]',
      ) as HTMLElement;
      expect(alert.textContent).toContain(
        getChromeStrings(locale).checkout.errors.paymentNotRetryable,
      );
    });

    it('maps PAYMENT_PROVIDER_UNAVAILABLE to a localized message', async () => {
      const stub = makeStub(pendingOrder);
      stub.confirmResult = 'PENDING';
      stub.retryResult = Object.assign(new Error('down'), { code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
      const fixture = await render(stub);
      (
        fixture.nativeElement.querySelector(
          '[data-testid="order-confirmation-pay-again"]',
        ) as HTMLButtonElement
      ).click();
      await fixture.whenStable();
      fixture.detectChanges();
      const locale = TestBed.inject(LocaleService).locale();
      const alert = fixture.nativeElement.querySelector(
        '[data-testid="order-confirmation-payment-error"]',
      ) as HTMLElement;
      expect(alert.textContent).toContain(
        getChromeStrings(locale).checkout.errors.paymentProviderUnavailable,
      );
    });
  });

  it('links the public track page by order number, alongside the authed order link', async () => {
    const fixture = await renderComponent(OrderConfirmationPage, {}, commonProviders('AKL-0001'));
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();

    const publicTrack = fixture.nativeElement.querySelector(
      '[data-testid="order-confirmation-public-track"]',
    ) as HTMLAnchorElement;
    expect(publicTrack).not.toBeNull();
    // The public page at `/{locale}/track`, with the order NUMBER prefilling
    // the form. Not the internal id, and not an account route: the lookup is
    // public behind the email challenge (findings K9, K10).
    const href = publicTrack.getAttribute('href') ?? '';
    expect(href).toMatch(/^\/(fr|en)\/track\?order=AKL-0001$/);
    // The internal id would never resolve, and this is not an account route.
    expect(href).not.toContain('ord-1');
    expect(href).not.toContain('/account/');
    // A percent-encoded `?` here means the query was baked into the path.
    expect(href).not.toContain('%3F');
    expect(publicTrack.textContent?.trim().length).toBeGreaterThan(0);
  });

  describe('tax mention source', () => {
    // The catalogue rows labelled themselves tax-exclusive for every store
    // that showed a mention at all, so a tax-inclusive store told its customer
    // the rows excluded tax. The total row was already correct.
    it('labels the line rows the way the store displays its catalogue', async () => {
      const fixture = await renderComponent(OrderConfirmationPage, {}, [
        ...commonProviders('AKL-0001'),
        provideFixtureStoreConfig('demo'),
      ]);
      // The order loads asynchronously, so the rows that carry the mentions
      // are not in the DOM until it settles. Without this the `none` case
      // below passed on an empty page rather than on a rendered one.
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(fixtureRuntimeConfig('demo').money.taxDisplay).toBe('TTC');
      const mentions = [...fixture.nativeElement.querySelectorAll('.tax-mention')].map(
        (el: Element) => el.textContent?.trim(),
      );
      expect(mentions.length).toBeGreaterThan(0);
      expect(mentions).not.toContain(getChromeStrings('fr').generic.taxExcluded);
    });

    it('renders no mention at all for a store that displays none', async () => {
      const fixture = await renderComponent(OrderConfirmationPage, {}, [
        ...commonProviders('AKL-0001'),
        provideFixtureStoreConfig('gulf-rtl'),
      ]);
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();

      // The rows are on the page; none of them carries a mention.
      expect(fixture.nativeElement.querySelectorAll('.items .item').length).toBeGreaterThan(0);
      expect(fixture.nativeElement.querySelectorAll('.tax-mention').length).toBe(0);
    });
  });
});

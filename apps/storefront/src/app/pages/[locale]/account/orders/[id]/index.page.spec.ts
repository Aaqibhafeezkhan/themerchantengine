import { ChangeDetectionStrategy, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrdersService } from '@storefront-services';
import {
  StorefrontConflictError,
  StorefrontForbiddenError,
  StorefrontNotFoundError,
  type Order,
} from '@storefront-types';

import { LocaleService } from '../../../../../locale.service';
import { AuthStateService } from '../../../../../services/auth-state.service';
import { getChromeStrings } from '../../../../../../i18n';
import { type Locale } from '../../../../../../i18n/types';
import OrderDetailPage from './index.page';
import { fixtureChromeIdentity } from '../../../../../../test-support/store-config-fixtures';

class StubLocaleService {
  private readonly _locale: WritableSignal<Locale>;
  constructor(initial: Locale) {
    this._locale = signal<Locale>(initial);
  }
  readonly locale = () => this._locale();
  readonly chromeIdentity = () => fixtureChromeIdentity('demo', this._locale());
  readonly strings = () => getChromeStrings(this._locale(), this.chromeIdentity());
  // The shared account nav derives `aria-current` from the live URL.
  readonly currentUrl = () => `/${this._locale()}/account`;
}

function makeAuth(authed: boolean) {
  return {
    isAuthed: () => authed,
    // The page awaits the boot outcome before deciding (finding N4); these
    // stubs model a boot that has already settled.
    whenBooted: async () => undefined,
    bootState: () => 'booted',
    currentUser: () => null,
    clearSession: vi.fn(),
  } as unknown as AuthStateService;
}

const sampleOrder: Order = {
  id: 'o1',
  orderNumber: 'AKL-0001',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  items: [
    {
      id: 'oi1',
      productId: 'p1',
      variantId: 'v1',
      productSlug: 'fx-laptop',
      productName: { default: 'Laptop', en: 'Laptop', fr: 'Ordinateur portable' },
      quantity: 1,
      unitPrice: '1000.00',
      lineTotal: '1000.00',
    },
  ],
  subtotal: '1000.00',
  total: '1010.00',
  shippingAmount: '10.00',
  currency: 'AED',
  shippingAddress: {
    id: 'a1',
    fullName: 'Test User',
    phone: '+97412345678',
    addressLine1: '1 Pearl',
    city: 'Lyon',
    country: 'QA',
  },
  billingAddress: {
    id: 'a1',
    fullName: 'Test User',
    phone: '+97412345678',
    addressLine1: '1 Pearl',
    city: 'Lyon',
    country: 'QA',
  },
  createdAt: '2026-04-25T10:00:00Z',
  cancellable: true,
} as unknown as Order;

interface RenderOpts {
  locale: Locale;
  authed: boolean;
  paramId?: string | null;
  getByIdResult?: Order;
  getByIdThrows?: unknown;
  cancelResult?: Order;
  cancelThrows?: unknown;
  invoiceResult?: unknown;
  invoiceThrows?: unknown;
}

interface RenderResult {
  fixture: ComponentFixture<OrderDetailPage>;
  navigateSpy: ReturnType<typeof vi.fn>;
  ordersSvc: {
    getById: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    invoice: ReturnType<typeof vi.fn>;
  };
}

async function renderDetail(opts: RenderOpts): Promise<RenderResult> {
  const stub = new StubLocaleService(opts.locale);
  const auth = makeAuth(opts.authed);
  const ordersSvc = {
    getById: vi.fn(async () => {
      if (opts.getByIdThrows) throw opts.getByIdThrows;
      return opts.getByIdResult ?? sampleOrder;
    }),
    cancel: vi.fn(async () => {
      if (opts.cancelThrows) throw opts.cancelThrows;
      return opts.cancelResult ?? { ...sampleOrder, status: 'CANCELLED' as const };
    }),
    invoice: vi.fn(async () => {
      if (opts.invoiceThrows) throw opts.invoiceThrows;
      return opts.invoiceResult ?? { downloadUrl: 'https://example.test/invoice.pdf' };
    }),
  };

  TestBed.overrideComponent(OrderDetailPage, {
    set: { changeDetection: ChangeDetectionStrategy.Default },
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: LocaleService, useValue: stub },
      { provide: AuthStateService, useValue: auth },
      { provide: OrdersService, useValue: ordersSvc },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            paramMap: convertToParamMap({
              id: opts.paramId === undefined ? sampleOrder.id : (opts.paramId ?? ''),
            }),
          },
        },
      },
    ],
  });
  const router = TestBed.inject(Router);
  const navigateSpy = vi.fn(async () => true);
  router.navigateByUrl = navigateSpy as never;
  router.navigate = navigateSpy as never;

  const fixture = TestBed.createComponent(OrderDetailPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  // Second flush: the page now awaits the session boot outcome before it even
  // reaches its data load (finding N4), so the load settles one turn later.
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, navigateSpy, ordersSvc };
}

describe('AccountOrderDetailPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });

  it('renders the SSR shell + heading + items table on happy path', async () => {
    const { fixture } = await renderDetail({ locale: 'en', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="account-order-detail-page"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="account-order-heading"]')?.textContent?.trim()).toBe(
      'Order AKL-0001',
    );
    expect(root.querySelector('[data-testid="account-order-items-table"]')).not.toBeNull();
  });

  it('keeps the items table header cells in one row (S2-18)', async () => {
    // A grouped selector gave the header cells `display: block`, so Items, Qty,
    // Unit price and Line total stacked in one column over the rows.
    const { fixture } = await renderDetail({ locale: 'en', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    const cells = root.querySelectorAll('[data-testid="account-order-items-table"] thead th');
    expect(cells.length).toBe(4);
    for (const cell of Array.from(cells)) {
      expect(getComputedStyle(cell).display).not.toBe('block');
    }
  });

  it('links an order item to the product it was bought from', async () => {
    // The name cell was plain text, so an order was a dead end: nothing led
    // back to the product. The storefront schema already tolerated
    // `productSlug`; the API simply never sent one.
    const { fixture } = await renderDetail({ locale: 'en', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    const link = root.querySelector(
      '[data-testid="account-order-items-table"] a',
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/en/catalog/product/fx-laptop');
    expect(link?.textContent?.trim()).toBe('Laptop');
  });

  it('invites a review on a delivered line, and links it to the reviews section', async () => {
    // The one moment a customer is both eligible and motivated had no path to
    // the review form.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: { ...sampleOrder, status: 'DELIVERED' } as Order,
    });
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-order-review-link-oi1"]',
    ) as HTMLAnchorElement | null;

    expect(link).not.toBeNull();
    // Path-prefixed, not a bare fragment: `href="#reviews"` resolves against
    // <base href="/"> and navigates home.
    expect(link?.getAttribute('href')).toBe('/en/catalog/product/fx-laptop#reviews');
  });

  it('invites a review on a completed order too', async () => {
    // COMPLETED is the legal successor of DELIVERED; closing the order does
    // not un-receive the product.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: { ...sampleOrder, status: 'COMPLETED' } as Order,
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-order-review-link-oi1"]',
      ),
    ).not.toBeNull();
  });

  it('offers no review link before the order is received', async () => {
    const { fixture } = await renderDetail({ locale: 'en', authed: true });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-order-review-link-oi1"]',
      ),
    ).toBeNull();
  });

  it('offers no review link for a product that no longer exists', async () => {
    // A link into a 404 is worse than plain text.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: {
        ...sampleOrder,
        status: 'DELIVERED',
        items: [{ ...sampleOrder.items![0], productSlug: undefined }],
      } as Order,
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-order-review-link-oi1"]',
      ),
    ).toBeNull();
  });

  it('renders a bought-then-deleted product as plain text, not a broken link', async () => {
    const order: Order = {
      ...sampleOrder,
      items: [{ ...sampleOrder.items![0], productSlug: undefined }],
    } as Order;
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: order,
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="account-order-items-table"] a')).toBeNull();
    expect(
      root.querySelector('[data-testid="account-order-items-table"] tbody td')?.textContent,
    ).toContain('Laptop');
  });

  it('renders the discount as one unbreakable negative amount', async () => {
    // The row was a text-node minus followed by `<app-price>`, a flex host, so
    // the sign sat alone on its line and the amount wrapped below it. The
    // confirmation page already did this correctly with a single `<bdi>`.
    const order: Order = { ...sampleOrder, discountAmount: '50.000' } as Order;
    const { fixture } = await renderDetail({ locale: 'en', authed: true, getByIdResult: order });
    const root = fixture.nativeElement as HTMLElement;
    const row = root.querySelector('[data-testid="account-order-discount"]');
    expect(row).not.toBeNull();
    const bdi = row?.querySelector('bdi');
    expect(bdi).not.toBeNull();
    // The sign and the amount are one text node, so they cannot be split.
    expect(bdi?.textContent?.trim().startsWith('-')).toBe(true);
    expect(bdi?.textContent).toContain('50');
    expect(row?.querySelector('app-price')).toBeNull();
  });

  it('renders the not-yours surface when the API returns 403 (OwnerGuard)', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdThrows: new StorefrontForbiddenError({ code: 'FORBIDDEN', message: 'Not your order' }),
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-order-not-yours"]',
      ),
    ).not.toBeNull();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-order-not-found"]',
      ),
    ).toBeNull();
  });

  it('renders the not-found surface when the API returns 404', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdThrows: new StorefrontNotFoundError({ code: 'NOT_FOUND', message: 'Order missing' }),
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-order-not-found"]',
      ),
    ).not.toBeNull();
  });

  it('redirects an anonymous visitor to /auth/login', async () => {
    const { navigateSpy } = await renderDetail({ locale: 'fr', authed: false });
    expect(navigateSpy).toHaveBeenCalled();
    const target = navigateSpy.mock.calls[0][0];
    expect(target).toContain('/fr/auth/login');
  });

  it('shows the cancel CTA only on cancellable statuses (CONFIRMED counts)', async () => {
    const { fixture } = await renderDetail({ locale: 'en', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(root.querySelectorAll('button')).map(
      (b) => b.textContent?.trim() ?? '',
    );
    expect(buttons.some((t) => t.toLowerCase().includes('cancel order'))).toBe(true);
  });

  it('hides the cancel CTA when the server says the order is no longer cancellable', async () => {
    // Plan M phase M1: the page used to keep its own status allowlist, which
    // was wider than the API rule and offered a button the endpoint refused.
    // A PENDING order with a shipment is exactly that case.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: { ...sampleOrder, status: 'PENDING', cancellable: false } as Order,
    });
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).map((b) => b.textContent?.trim().toLowerCase() ?? '');

    expect(buttons.some((t) => t.includes('cancel order'))).toBe(false);
  });

  it('shows the cancel CTA on a status it would never have guessed, when the server allows it', async () => {
    // The mirror of the test above: the flag decides, not the status list.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: { ...sampleOrder, status: 'ON_HOLD', cancellable: true } as Order,
    });
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).map((b) => b.textContent?.trim().toLowerCase() ?? '');

    expect(buttons.some((t) => t.includes('cancel order'))).toBe(true);
  });

  it('opens the cancel confirm dialog and posts a cancel call on confirm', async () => {
    const { fixture, ordersSvc } = await renderDetail({ locale: 'en', authed: true });
    const root = fixture.nativeElement as HTMLElement;

    const cancelBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').toLowerCase().includes('cancel order'),
    ) as HTMLButtonElement;
    cancelBtn.click();
    fixture.detectChanges();

    const confirm = root.querySelector('[data-testid="account-order-cancel-confirm"]');
    expect(confirm).not.toBeNull();

    const yesBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').toLowerCase().includes('yes, cancel'),
    ) as HTMLButtonElement;
    yesBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(ordersSvc.cancel).toHaveBeenCalledWith(sampleOrder.id);
  });

  it('tells the shopper a card hold is released when cancelling an authorized order', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: { ...sampleOrder, paymentStatus: 'AUTHORIZED' } as Order,
    });
    const root = fixture.nativeElement as HTMLElement;
    (
      Array.from(root.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').toLowerCase().includes('cancel order'),
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    const body = root.querySelector('#account-order-cancel-body')?.textContent ?? '';
    expect(body).toContain(getChromeStrings('en').account.orderDetail.cancel.confirmCardHold);
  });

  it('does not mention a card hold when the order has no authorized payment', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: { ...sampleOrder, paymentStatus: 'PENDING' } as Order,
    });
    const root = fixture.nativeElement as HTMLElement;
    (
      Array.from(root.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').toLowerCase().includes('cancel order'),
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    const body = root.querySelector('#account-order-cancel-body')?.textContent ?? '';
    expect(body).not.toContain(getChromeStrings('en').account.orderDetail.cancel.confirmCardHold);
  });

  it('renders the cancel error inline when cancel returns 409 conflict', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      cancelThrows: new StorefrontConflictError({
        code: 'CONFLICT',
        message: 'Cannot cancel a shipped order',
      }),
    });
    const root = fixture.nativeElement as HTMLElement;

    const cancelBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').toLowerCase().includes('cancel order'),
    ) as HTMLButtonElement;
    cancelBtn.click();
    fixture.detectChanges();

    const yesBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').toLowerCase().includes('yes, cancel'),
    ) as HTMLButtonElement;
    yesBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(root.querySelector('[data-testid="account-order-cancel-error"]')).not.toBeNull();
  });

  it('explains a HAS_SHIPMENT refusal with the being-prepared copy', async () => {
    // The generic "can no longer be cancelled" leaves the customer with no next
    // step. The server names the reason, so the page can say what to do.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      cancelThrows: new StorefrontConflictError({
        code: 'ORDER_CANCEL_INELIGIBLE',
        message: 'This order is already being prepared',
        details: { reason: 'HAS_SHIPMENT' },
      }),
    });
    const root = fixture.nativeElement as HTMLElement;

    const cancelBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').toLowerCase().includes('cancel order'),
    ) as HTMLButtonElement;
    cancelBtn.click();
    fixture.detectChanges();

    const yesBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').toLowerCase().includes('yes, cancel'),
    ) as HTMLButtonElement;
    yesBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const error = root.querySelector('[data-testid="account-order-cancel-error"]');
    expect(error?.textContent ?? '').toContain('being prepared');
  });

  it('renders one timeline row per recorded transition, each with its own time', async () => {
    // Finding AD6: the page used to fall back to a single row stamped with the
    // time the order was placed, whatever had happened since.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: {
        ...sampleOrder,
        status: 'CANCELLED',
        statusHistory: [
          { status: 'PENDING', at: '2026-04-25T10:00:00Z' },
          { status: 'CONFIRMED', at: '2026-04-25T14:00:00Z' },
          { status: 'CANCELLED', at: '2026-04-26T09:00:00Z' },
        ],
      } as unknown as Order,
    });
    const root = fixture.nativeElement as HTMLElement;

    const rows = root.querySelectorAll('[data-testid="order-status-timeline"] li');
    expect(rows.length).toBe(3);

    const stamps = Array.from(rows).map((li) => li.querySelector('time')?.getAttribute('datetime'));
    expect(new Set(stamps).size).toBe(3);
  });

  it('renders an empty timeline rather than inventing one row from the status', async () => {
    // The old fallback made a not-yet-loaded history look like a real event.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: { ...sampleOrder, statusHistory: [] } as unknown as Order,
    });

    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="order-status-timeline"] li',
      ).length,
    ).toBe(0);
  });

  it('renders the no-tracking placeholder when shipments[] is empty', async () => {
    const { fixture } = await renderDetail({ locale: 'en', authed: true });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-order-no-tracking"]',
      ),
    ).not.toBeNull();
  });
});

/**
 * Plan M phase M4. Four things on this page told the customer something that
 * was not true.
 *
 * The invoice button was enabled on a status guess rather than on whether an
 * invoice exists, so it offered a download for a DELIVERED order that has none
 * and refused one for a CANCELLED order that does (K12, prior K7). There was no
 * payment row at all (K7). The country rendered as a raw ISO code and the
 * discount sign could wrap away from its amount (K8, prior K6). And a DELIVERED
 * order with no shipment row was told its tracking would appear once it ships.
 */
describe('AccountOrderDetailPage honest invoice, payment, tracking and totals (M4)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });

  function orderWith(overrides: Record<string, unknown>): Order {
    return { ...sampleOrder, ...overrides } as unknown as Order;
  }

  const INVOICE = {
    id: 'inv1',
    invoiceNumber: 'INV-2026-000002',
    issuedAt: '2026-04-26T10:00:00Z',
  };

  function invoiceButton(fixture: ComponentFixture<OrderDetailPage>): HTMLButtonElement {
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ) as HTMLButtonElement[];
    const label = getChromeStrings('en').account.orderDetail.invoice.downloadCta;
    const found = buttons.find((b) => b.textContent?.trim().startsWith(label));
    if (!found) throw new Error('invoice button not rendered');
    return found;
  }

  function reasonText(fixture: ComponentFixture<OrderDetailPage>): string {
    return (
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="account-order-invoice-reason"]')
        ?.textContent?.trim() ?? ''
    );
  }

  // K12 / prior K7: the invoice button follows the invoice, not the status.

  it('enables the invoice download exactly when an invoice exists', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ status: 'CONFIRMED', invoice: INVOICE }),
    });
    expect(invoiceButton(fixture).disabled).toBe(false);
    expect(reasonText(fixture)).toBe('');
  });

  it('offers the invoice on a CANCELLED order that has one', async () => {
    // Red before M4: the status allowlist refused CANCELLED outright, even
    // though cancelling after confirmation leaves the invoice in place.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ status: 'CANCELLED', invoice: INVOICE }),
    });
    expect(invoiceButton(fixture).disabled).toBe(false);
  });

  it('refuses and explains itself on a DELIVERED order with no invoice', async () => {
    // Red before M4: the status allowlist enabled the button, the endpoint had
    // nothing to give, and the customer got a generic error.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ status: 'DELIVERED', invoice: null }),
    });
    expect(invoiceButton(fixture).disabled).toBe(true);
    expect(reasonText(fixture)).toBe(
      getChromeStrings('en').account.orderDetail.invoice.reasonPreparing,
    );
  });

  it('says a cancelled order with no invoice will not get one', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ status: 'CANCELLED', invoice: null }),
    });
    expect(invoiceButton(fixture).disabled).toBe(true);
    expect(reasonText(fixture)).toBe(
      getChromeStrings('en').account.orderDetail.invoice.reasonCancelled,
    );
  });

  it('refuses and explains itself on a PENDING order with no invoice', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ status: 'PENDING', invoice: null }),
    });
    expect(invoiceButton(fixture).disabled).toBe(true);
    expect(reasonText(fixture)).toBe(
      getChromeStrings('en').account.orderDetail.invoice.reasonNotConfirmed,
    );
  });

  // K7: the payment row.

  it('names the payment method and its status', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ paymentMethodName: 'Carte bancaire', paymentStatus: 'CAPTURED' }),
    });
    const row = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-order-payment"]',
    );
    expect(row?.textContent).toContain('Carte bancaire');
    expect(row?.textContent).toContain(
      getChromeStrings('en').account.orderDetail.payment.statusLabels.CAPTURED,
    );
  });

  it('falls back to cash on delivery when no method was recorded', async () => {
    // Every order placed before plan F phase F5 has a null here, and the store
    // is COD-only today, so null is a real answer rather than a gap.
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ paymentMethodName: null, paymentStatus: 'PENDING' }),
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="account-order-payment"]')
        ?.textContent,
    ).toContain(getChromeStrings('en').account.orderDetail.payment.cashOnDelivery);
  });

  // K8 / prior K6: country name, discount sign.

  it('renders the country as a localized name, not a raw ISO code', async () => {
    const address = { ...(sampleOrder.shippingAddress as object), country: 'LY' };
    for (const [locale, expected] of [
      ['en', 'Libya'],
      ['fr', 'Libye'],
    ] as const) {
      TestBed.resetTestingModule();
      const { fixture } = await renderDetail({
        locale,
        authed: true,
        getByIdResult: orderWith({ shippingAddress: address, billingAddress: address }),
      });
      const block = (fixture.nativeElement as HTMLElement).querySelector('.address-block');
      expect(block?.textContent).toContain(expected);
      expect(block?.textContent).not.toMatch(/\bTN\b/);
    }
  });

  it('keeps an unmapped country code readable rather than blanking the line', async () => {
    // `QQ` is unassigned, so CLDR has no name for it. (`ZZ` would not prove
    // this: CLDR maps it to the literal "Unknown Region".)
    const address = { ...(sampleOrder.shippingAddress as object), country: 'QQ' };
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ shippingAddress: address, billingAddress: address }),
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.address-block')?.textContent,
    ).toContain('QQ');
  });

  it('keeps the discount sign on the same line as its amount', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ discountAmount: '50.000' }),
    });
    const dd = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-order-discount"] dd',
    ) as HTMLElement;
    expect(dd).not.toBeNull();
    // One flex row: the minus and the price are siblings that cannot wrap apart.
    expect(dd.classList.contains('signed-amount')).toBe(true);
  });

  // prior K6: tracking copy is status-aware.

  it('says when a DELIVERED order without a shipment row was delivered', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({
        status: 'DELIVERED',
        deliveredAt: '2026-04-28T14:00:00Z',
        shipments: [],
      }),
    });
    const copy = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-order-no-tracking"]',
    )?.textContent;
    expect(copy).not.toContain(getChromeStrings('en').account.orderDetail.tracking.noneYet);
    expect(copy).toMatch(/Delivered on/);
  });

  it('says a SHIPPED order without a shipment row is on its way', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ status: 'SHIPPED', shipments: [] }),
    });
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="account-order-no-tracking"]')
        ?.textContent?.trim(),
    ).toBe(getChromeStrings('en').account.orderDetail.tracking.shippedNoDetails);
  });

  it('keeps the not-yet-shipped copy for an order that has not shipped', async () => {
    const { fixture } = await renderDetail({
      locale: 'en',
      authed: true,
      getByIdResult: orderWith({ status: 'CONFIRMED', shipments: [] }),
    });
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="account-order-no-tracking"]')
        ?.textContent?.trim(),
    ).toBe(getChromeStrings('en').account.orderDetail.tracking.noneYet);
  });
});

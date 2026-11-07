import { ApiForbiddenError, ApiNotFoundError, ApiServerError } from '@admin-types';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { OrdersService, ReturnsService } from '@admin-services';
import { convertToParamMap, ParamMap } from '@angular/router';
import { axe, toHaveNoViolations } from 'jest-axe';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { BOOTSTRAP_LOCALE } from '../../core/tokens';
import { AuthStore } from '../../core/stores/auth.store';
import { OrderDetailPage } from './order-detail.page';
import { provideStoreSettingsStub } from '../../../testing/store-settings.mock';

expect.extend(toHaveNoViolations);

describe('OrderDetailPage', () => {
  let fixture: ComponentFixture<OrderDetailPage>;
  let page: OrderDetailPage;
  let getSpy: jest.Mock;
  let listReturnsSpy: jest.Mock;
  let paramMap$: BehaviorSubject<ParamMap>;

  const orderFixture = {
    id: 'order-1',
    orderNumber: 'ORD-2026-000001',
    status: 'DELIVERED',
    paymentStatus: 'CAPTURED',
    subtotal: 480,
    shippingAmount: 10,
    taxAmount: 10,
    total: 500,
    discountAmount: 0,
    currency: 'USD',
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-01T10:00:00.000Z',
    userId: 'u-1',
  };

  function configure(
    id: string | null,
    opts: {
      returnsResponse?: ReturnType<jest.Mock>;
      permissions?: readonly string[];
    } = {},
  ) {
    const {
      returnsResponse = of({ data: [], meta: { page: 1, pageSize: 20, total: 0 } }),
      permissions = ['orders:view', 'orders:manage', 'returns:view'],
    } = opts;
    listReturnsSpy = jest.fn(() => returnsResponse);
    paramMap$ = new BehaviorSubject<ParamMap>(convertToParamMap(id ? { id } : {}));
    // `locale` feeds the `| translatable` pipe the items table binds through.
    const authStoreStub = {
      hasPermission: (perm: string) => permissions.includes(perm),
      locale: signal('fr'),
    };
    TestBed.configureTestingModule({
      providers: [
        provideStoreSettingsStub(),
        provideRouter([{ path: '**', children: [] }]),
        { provide: BOOTSTRAP_LOCALE, useValue: 'fr' },
        { provide: OrdersService, useValue: { get: getSpy } },
        { provide: ReturnsService, useValue: { list: listReturnsSpy } },
        { provide: AuthStore, useValue: authStoreStub },
        { provide: ActivatedRoute, useValue: { paramMap: paramMap$.asObservable() } },
      ],
    });
    fixture = TestBed.createComponent(OrderDetailPage);
    page = fixture.componentInstance;
    fixture.detectChanges();
  }

  it('loads the order matching the :id param', () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1');
    expect(getSpy).toHaveBeenCalledWith('order-1');
    expect(page.order()?.id).toBe('order-1');
    expect(page.loading()).toBe(false);
  });

  it('surfaces ApiNotFoundError as a permission-safe message', () => {
    getSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'missing' })),
    );
    configure('order-bogus');
    expect(page.error()).toBe('Order not found.');
  });

  it('surfaces ApiForbiddenError as a permission-safe message', () => {
    getSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure('order-1');
    expect(page.error()).toContain('permission');
  });

  // ── QA C3: the edit page is a dead end outside EDITABLE_STATUSES ────────────

  it('hides the Edit link on a DELIVERED order', () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1');
    expect(fixture.nativeElement.querySelector('[data-testid=order-edit-link]')).toBeNull();
  });

  it('shows the Edit link on a CONFIRMED order', () => {
    getSpy = jest.fn(() => of({ ...orderFixture, status: 'CONFIRMED' }));
    configure('order-1');
    expect(fixture.nativeElement.querySelector('[data-testid=order-edit-link]')).not.toBeNull();
  });

  it('still respects the orders:manage gate on an editable order', () => {
    getSpy = jest.fn(() => of({ ...orderFixture, status: 'CONFIRMED' }));
    configure('order-1', { permissions: ['orders:view'] });
    expect(fixture.nativeElement.querySelector('[data-testid=order-edit-link]')).toBeNull();
  });

  it('shows the payment actions with payments:manage', () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1', { permissions: ['orders:view', 'payments:manage'] });
    expect(
      fixture.nativeElement.querySelector('[data-testid=order-payment-refund]'),
    ).not.toBeNull();
  });

  it('hides the payment actions without payments:manage even with orders:manage', () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1');
    expect(fixture.nativeElement.querySelector('[data-testid=order-payment-actions]')).toBeNull();
  });

  it('records an error when the route has no :id', () => {
    getSpy = jest.fn();
    configure(null);
    expect(getSpy).not.toHaveBeenCalled();
    expect(page.error()).toBe('Missing order id.');
  });

  it('has no axe violations on the loaded detail view', async () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1');
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations when the related-return link is present', async () => {
    getSpy = jest.fn(() => of(orderFixture));
    const returnRecord = {
      id: 'ret-9',
      returnNumber: 'RET-2026-0009',
      orderId: 'order-1',
      status: 'REQUESTED',
      createdAt: '2026-04-02T10:00:00.000Z',
    };
    configure('order-1', {
      returnsResponse: of({
        data: [returnRecord],
        meta: { page: 1, pageSize: 50, total: 1 },
      }),
    });
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });

  it('renders the related-return link when returns exist for this order', () => {
    getSpy = jest.fn(() => of(orderFixture));
    const returnRecord = {
      id: 'ret-9',
      returnNumber: 'RET-2026-0009',
      orderId: 'order-1',
      status: 'REQUESTED',
      createdAt: '2026-04-02T10:00:00.000Z',
    };
    configure('order-1', {
      returnsResponse: of({
        data: [returnRecord],
        meta: { page: 1, pageSize: 50, total: 1 },
      }),
    });
    expect(listReturnsSpy).toHaveBeenCalled();
    expect(page.relatedReturn()?.id).toBe('ret-9');
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector(
      '[data-testid="order-related-return"]',
    ) as HTMLElement | null;
    expect(el).not.toBeNull();
    const link = el?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/returns/ret-9');
    expect(el?.textContent).toContain('RET-2026-0009');
  });

  it('renders the related-return status as a label with no stray space before the stop', () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1', {
      returnsResponse: of({
        data: [
          {
            id: 'ret-2',
            returnNumber: 'RET-2026-0001',
            orderId: 'order-1',
            status: 'REFUND_PROCESSED',
            createdAt: '2026-04-02T10:00:00.000Z',
          },
        ],
        meta: { page: 1, pageSize: 50, total: 1 },
      }),
    });
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector(
      '[data-testid="order-related-return"]',
    ) as HTMLElement;
    const text = el.textContent?.replace(/\s+/g, ' ').trim();
    expect(text).toBe('A return for this order is RET-2026-0001 · Refund Processed.');
    expect(text).not.toContain('REFUND_PROCESSED');
  });

  it('omits the related-return link when no return matches the order', () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1', {
      returnsResponse: of({ data: [], meta: { page: 1, pageSize: 50, total: 0 } }),
    });
    expect(page.relatedReturn()).toBeNull();
    const el = fixture.nativeElement.querySelector('[data-testid="order-related-return"]');
    expect(el).toBeNull();
  });

  it('skips the returns fetch entirely when the viewer lacks returns:view', () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1', { permissions: ['orders:view'] });
    expect(listReturnsSpy).not.toHaveBeenCalled();
    expect(page.relatedReturn()).toBeNull();
  });

  it('gracefully handles a returns list error without blocking the order view', () => {
    getSpy = jest.fn(() => of(orderFixture));
    configure('order-1', {
      returnsResponse: throwError(
        () => new ApiServerError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' }),
      ),
    });
    expect(page.relatedReturn()).toBeNull();
    expect(page.order()?.id).toBe('order-1');
  });

  // ── QA D1: the read surface the payload already carried ────────────────────

  /**
   * The first item carries an OBJECT-shaped `productName` on purpose: admin
   * reads send `X-Resolve-Locale: false`, so binding it raw renders
   * "[object Object]" (the entity-rendering Class A defect).
   */
  const contentOrderFixture = {
    ...orderFixture,
    currency: 'EUR',
    couponCode: 'WELCOME10',
    paymentMethodName: 'Credit card',
    items: [
      {
        id: 'item-1',
        productName: { default: 'Fraise dentaire', fr: 'Fraise dentaire', en: 'Dental bur' },
        variantLabel: '500 g',
        sku: 'HON-SIDR-500',
        unitPrice: 240,
        quantity: 2,
        total: 480,
      },
      {
        id: 'item-2',
        productName: 'Gift Wrap',
        sku: 'GEN-WRAP',
        unitPrice: 20,
        quantity: 1,
        total: 20,
      },
    ],
    shippingAddress: {
      fullName: 'Sara Hassan',
      phone: '+97455551234',
      addressLine1: 'Building 12, Street 840',
      city: 'Al Wakrah',
      country: 'QA',
    },
    billingAddress: {
      fullName: 'Sara Hassan',
      phone: '+97455551234',
      addressLine1: 'Building 12, Street 840',
      city: 'Lyon',
      country: 'QA',
    },
    invoice: {
      id: 'inv-1',
      invoiceNumber: 'INV-2026-0007',
      issuedAt: '2026-04-01T11:00:00.000Z',
    },
  };

  function textOf(testId: string): string {
    const el = fixture.nativeElement.querySelector(
      `[data-testid="${testId}"]`,
    ) as HTMLElement | null;
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  it('renders one line-item row per ordered item', () => {
    getSpy = jest.fn(() => of(contentOrderFixture));
    configure('order-1');
    const rows = fixture.nativeElement.querySelectorAll('[data-testid=order-items] tbody tr');
    expect(rows.length).toBe(2);
  });

  it('resolves an object-shaped productName through the translatable pipe', () => {
    getSpy = jest.fn(() => of(contentOrderFixture));
    configure('order-1');
    const text = textOf('order-items');
    expect(text).toContain('Fraise dentaire');
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('Gift Wrap');
  });

  it('renders quantity, unit price and line total in the order currency', () => {
    getSpy = jest.fn(() => of(contentOrderFixture));
    configure('order-1');
    const text = textOf('order-items');
    expect(text).toContain('HON-SIDR-500');
    expect(text).toContain('500 g');
    expect(text).toContain('EUR 240.00');
    expect(text).toContain('EUR 480.00');
    expect(text).not.toContain('USD');
  });

  it('shows an empty-state row when the order carries no line items', () => {
    getSpy = jest.fn(() => of({ ...contentOrderFixture, items: [] }));
    configure('order-1');
    expect(textOf('order-items')).toContain('No line items recorded.');
  });

  it('renders the shipping and billing address snapshots', () => {
    getSpy = jest.fn(() => of(contentOrderFixture));
    configure('order-1');
    expect(textOf('order-shipping-address')).toContain('Al Wakrah');
    expect(textOf('order-shipping-address')).toContain('Sara Hassan');
    expect(textOf('order-billing-address')).toContain('Lyon');
  });

  it('falls back to a placeholder when an address snapshot is missing', () => {
    getSpy = jest.fn(() => of({ ...contentOrderFixture, billingAddress: null }));
    configure('order-1');
    expect(textOf('order-billing-address')).toContain('No billing address recorded.');
  });

  it('renders the payment card with status, currency, coupon and invoice number', () => {
    getSpy = jest.fn(() => of(contentOrderFixture));
    configure('order-1');
    const text = textOf('order-payment');
    expect(text).toContain('Captured');
    expect(text).toContain('EUR');
    expect(text).toContain('WELCOME10');
    expect(text).toContain('INV-2026-0007');
  });

  it('names the payment method the customer chose in the payment card', () => {
    getSpy = jest.fn(() => of(contentOrderFixture));
    configure('order-1');
    expect(textOf('order-payment-method')).toContain('Credit card');
  });

  it('keeps the payment card honest when no invoice has been generated', () => {
    getSpy = jest.fn(() => of({ ...contentOrderFixture, invoice: null }));
    configure('order-1');
    expect(textOf('order-payment')).toContain('Not generated yet');
  });

  // Finding AD3. The totals region showed Subtotal, Shipping, Tax and Total, so
  // on any discounted order the four tiles did not add up and the missing
  // figure sat in the Metadata block far below. A staff member reconciling a
  // refund had to hunt for it, or concluded the total was wrong.

  const DISCOUNTED = {
    subtotal: 700,
    discountAmount: 350,
    shippingAmount: 8,
    taxAmount: 66.5,
    total: 424.5,
    currency: 'XTS',
  };

  function totalsTiles(): HTMLElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="order-totals"] > div'),
    ) as HTMLElement[];
  }

  it('renders a discount tile so the totals region sums to the total', () => {
    getSpy = jest.fn(() => of({ ...contentOrderFixture, ...DISCOUNTED }));
    configure('order-1');

    const tiles = totalsTiles();
    expect(tiles).toHaveLength(5);
    expect(tiles.map((t) => t.querySelector('dt')?.textContent?.trim())).toEqual([
      'Subtotal',
      'Discount',
      'Shipping',
      'Tax',
      'Total',
    ]);

    // The arithmetic the region is there to show.
    const { subtotal, discountAmount, shippingAmount, taxAmount, total } = DISCOUNTED;
    expect(subtotal - discountAmount + shippingAmount + taxAmount).toBeCloseTo(total, 3);
  });

  it('signs the discount so it reads as a subtraction', () => {
    getSpy = jest.fn(() => of({ ...contentOrderFixture, ...DISCOUNTED }));
    configure('order-1');

    const discount = totalsTiles()[1];
    expect(discount.querySelector('dd')?.textContent?.trim()).toMatch(/^-/);
    expect(discount.textContent).toContain('350');
  });

  it('keeps the tile in place on an undiscounted order rather than hiding it', () => {
    // A row that comes and goes makes the grid jump and makes "no discount"
    // indistinguishable from "discount not shown".
    getSpy = jest.fn(() => of({ ...contentOrderFixture, discountAmount: 0 }));
    configure('order-1');
    expect(totalsTiles()).toHaveLength(5);
  });

  it('lays the five tiles out on a five-column grid at desktop width', () => {
    getSpy = jest.fn(() => of(contentOrderFixture));
    configure('order-1');
    const grid = fixture.nativeElement.querySelector('[data-testid="order-totals"]') as HTMLElement;
    expect(grid.className).toContain('lg:grid-cols-5');
    expect(grid.className).not.toContain('lg:grid-cols-4');
  });

  it('no longer repeats the discount in the metadata block', () => {
    getSpy = jest.fn(() => of({ ...contentOrderFixture, ...DISCOUNTED }));
    configure('order-1');
    const metadata = fixture.nativeElement.querySelector(
      '[data-testid="order-metadata"]',
    ) as HTMLElement | null;
    expect(metadata).not.toBeNull();
    expect(
      Array.from(metadata!.querySelectorAll('dt')).map((d) => d.textContent?.trim()),
    ).not.toContain('Discount');
  });

  it('has no axe violations with the full content surface rendered', async () => {
    getSpy = jest.fn(() => of(contentOrderFixture));
    configure('order-1');
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});

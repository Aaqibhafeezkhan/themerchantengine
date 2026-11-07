import { ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { PaymentMethodsService } from '@admin-services';
import { axe, toHaveNoViolations } from 'jest-axe';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { BOOTSTRAP_LOCALE } from '../../core/tokens';
import { PaymentMethodsListPage } from './payment-methods-list.page';

expect.extend(toHaveNoViolations);

const methods = [
  {
    id: 'pm-1',
    code: 'stripe_live',
    name: { default: 'Stripe', en: 'Stripe' },
    provider: 'stripe',
    isActive: true,
    isTestMode: false,
    sortOrder: 0,
    config: { publishableKey: 'pk_xxx', apiKey: '***' },
  },
  {
    id: 'pm-2',
    code: 'cod',
    name: { default: 'Cash', en: 'Cash on delivery' },
    provider: 'cod',
    isActive: false,
    isTestMode: false,
    sortOrder: 1,
    config: {},
  },
];

describe('PaymentMethodsListPage', () => {
  let fixture: ComponentFixture<PaymentMethodsListPage>;
  let page: PaymentMethodsListPage;
  let listSpy: jest.Mock;
  let reorderSpy: jest.Mock;
  let providersSpy: jest.Mock;

  function configure(
    perms: string[] = ['payment_methods:view', 'payment_methods:create', 'payment_methods:update'],
  ) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: BOOTSTRAP_LOCALE, useValue: 'fr' },
        {
          provide: PaymentMethodsService,
          useValue: { list: listSpy, reorder: reorderSpy, providers: providersSpy },
        },
      ],
    });
    TestBed.inject(AuthStore).setSession({
      user: {
        id: 'u',
        email: 'a@b',
        permissions: perms,
        roles: [],
        status: 'active',
      },
    });
    fixture = TestBed.createComponent(PaymentMethodsListPage);
    page = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    listSpy = jest.fn(() => of({ data: methods, meta: { page: 1, pageSize: 20, total: 2 } }));
    reorderSpy = jest.fn(() => of(undefined));
    providersSpy = jest.fn(() =>
      of([
        {
          id: 'stripe',
          label: 'Stripe',
          actionTypes: ['embedded', 'redirect'],
          secretFields: ['secretKey'],
          configJsonSchema: {},
        },
        {
          id: 'cod',
          label: 'Canary Pay',
          actionTypes: ['none'],
          secretFields: [],
          configJsonSchema: {},
        },
      ]),
    );
  });

  it('loads methods', () => {
    configure();
    expect(page.rows()).toHaveLength(2);
  });

  it('renders the provider label from the API catalogue', () => {
    configure();
    const row = fixture.nativeElement.querySelector('[data-testid="payment-row-pm-2"]');
    expect(row.textContent).toContain('Canary Pay');
  });

  it('falls back to the raw provider id and keeps the list when the catalogue fails', () => {
    providersSpy = jest.fn(() => throwError(() => new ApiError({ code: 'X', message: 'down' })));
    configure();
    const row = fixture.nativeElement.querySelector('[data-testid="payment-row-pm-2"]');
    expect(row.textContent).toContain('cod');
    expect(page.rows()).toHaveLength(2);
    expect(page.error()).toBeNull();
  });

  it('renders the New payment method CTA when canCreate is true', () => {
    configure();
    const cta = fixture.nativeElement.querySelector('[data-testid="payment-method-new"]');
    expect(cta).toBeTruthy();
  });

  it('hides the New payment method CTA for view-only admin', () => {
    configure(['payment_methods:view']);
    const cta = fixture.nativeElement.querySelector('[data-testid="payment-method-new"]');
    expect(cta).toBeFalsy();
  });

  it('renders drag-handles when canReorder is true', () => {
    configure();
    const handle = fixture.nativeElement.querySelector('[data-testid="drag-handle-pm-1"]');
    expect(handle).toBeTruthy();
  });

  it('hides drag-handles for view-only admin', () => {
    configure(['payment_methods:view']);
    const handle = fixture.nativeElement.querySelector('[data-testid="drag-handle-pm-1"]');
    expect(handle).toBeFalsy();
  });

  it('setActiveFilter navigates with the new status + resets page', () => {
    configure();
    const navSpy = jest.spyOn(TestBed.inject(Router), 'navigate');
    page.setActiveFilter('active');
    expect(navSpy).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: expect.objectContaining({ status: 'active', page: null }),
      }),
    );
  });

  it('goToPage is a no-op for out-of-range page numbers', () => {
    configure();
    const navSpy = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    page.goToPage(0);
    page.goToPage(99);
    expect(navSpy).not.toHaveBeenCalled();
  });

  it('goToPage navigates with a valid page number when more than one page exists', () => {
    listSpy = jest.fn(() => of({ data: methods, meta: { page: 1, pageSize: 20, total: 40 } }));
    configure();
    const navSpy = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    page.goToPage(2);
    expect(navSpy).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ queryParams: expect.objectContaining({ page: 2 }) }),
    );
  });

  it('ApiForbiddenError surfaces a permission-safe error', () => {
    listSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    expect(page.error()).toContain('permission');
  });

  it('ApiNotFoundError surfaces the payment-methods-not-found error', () => {
    listSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'missing' })),
    );
    configure();
    expect(page.error()).toBe('Payment methods not found.');
  });

  it('generic ApiError surfaces its message', () => {
    listSpy = jest.fn(() =>
      throwError(() => new ApiError({ code: 'X', message: 'upstream tripped' })),
    );
    configure();
    expect(page.error()).toBe('upstream tripped');
  });

  describe('reorder handler', () => {
    it('drop() calls reorder with the new id order + re-fetches', () => {
      configure();
      listSpy.mockClear();
      page.drop({ previousIndex: 0, currentIndex: 1 } as never);
      expect(reorderSpy).toHaveBeenCalledWith({ ids: ['pm-2', 'pm-1'] });
      // re-fetch after the 204
      expect(listSpy).toHaveBeenCalled();
    });

    it('drop() with same previousIndex + currentIndex is a no-op', () => {
      configure();
      reorderSpy.mockClear();
      page.drop({ previousIndex: 0, currentIndex: 0 } as never);
      expect(reorderSpy).not.toHaveBeenCalled();
    });

    it('reorder error rolls rows back + sets banner', () => {
      reorderSpy = jest.fn(() =>
        throwError(() => new ApiError({ code: 'X', message: 'reorder failed' })),
      );
      configure();
      const before = page.rows();
      page.drop({ previousIndex: 0, currentIndex: 1 } as never);
      expect(page.rows()).toEqual(before);
      expect(page.error()).toBe('reorder failed');
      expect(page.reordering()).toBe(false);
    });

    it('keyboard ArrowDown at last index is a no-op', () => {
      configure();
      reorderSpy.mockClear();
      const evt = { preventDefault: jest.fn(), stopPropagation: jest.fn() } as unknown as Event;
      page.onHandleKey(evt, 'down', page.rows().length - 1);
      expect(reorderSpy).not.toHaveBeenCalled();
    });

    it('keyboard ArrowUp at first index is a no-op', () => {
      configure();
      reorderSpy.mockClear();
      const evt = { preventDefault: jest.fn(), stopPropagation: jest.fn() } as unknown as Event;
      page.onHandleKey(evt, 'up', 0);
      expect(reorderSpy).not.toHaveBeenCalled();
    });

    it('keyboard ArrowUp on a mid row triggers reorder with swapped ids', () => {
      configure();
      const evt = { preventDefault: jest.fn(), stopPropagation: jest.fn() } as unknown as Event;
      page.onHandleKey(evt, 'up', 1);
      expect(reorderSpy).toHaveBeenCalledWith({ ids: ['pm-2', 'pm-1'] });
    });
  });

  it('has no axe violations', async () => {
    configure();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations when the error banner is rendered', async () => {
    listSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    fixture.detectChanges();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});

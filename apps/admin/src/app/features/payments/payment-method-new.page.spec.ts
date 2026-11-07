import { ApiConflictError, ApiError, ApiForbiddenError } from '@admin-types';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { PaymentMethodsService } from '@admin-services';
import { axe, toHaveNoViolations } from 'jest-axe';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { BOOTSTRAP_LOCALE } from '../../core/tokens';
import { PaymentMethodNewPage } from './payment-method-new.page';

expect.extend(toHaveNoViolations);

describe('PaymentMethodNewPage', () => {
  let fixture: ComponentFixture<PaymentMethodNewPage>;
  let page: PaymentMethodNewPage;
  let createSpy: jest.Mock;
  let navigateSpy: jest.SpyInstance;
  let providersSpy: jest.Mock;

  const catalogue = [
    {
      id: 'stripe',
      label: 'Stripe',
      actionTypes: ['embedded', 'redirect'],
      secretFields: ['secretKey'],
      configJsonSchema: {},
    },
    {
      id: 'canary_pay',
      label: 'Canary Pay',
      actionTypes: ['redirect'],
      secretFields: ['merchantPassword'],
      configJsonSchema: {},
    },
  ];

  function configure() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: BOOTSTRAP_LOCALE, useValue: 'fr' },
        {
          provide: PaymentMethodsService,
          useValue: { create: createSpy, providers: providersSpy },
        },
      ],
    });
    TestBed.inject(AuthStore).setSession({
      user: {
        id: 'u',
        email: 'a@b',
        permissions: ['payment_methods:create'],
        roles: [],
        status: 'active',
      },
    });
    fixture = TestBed.createComponent(PaymentMethodNewPage);
    page = fixture.componentInstance;
    navigateSpy = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
  }

  function fillValid() {
    page.form.patchValue({
      code: 'stripe_live',
      name: { default: 'Stripe' },
      provider: 'stripe',
      isActive: true,
      isTestMode: false,
      sortOrder: 0,
    });
  }

  beforeEach(() => {
    providersSpy = jest.fn(() => of(catalogue));
    createSpy = jest.fn(() =>
      of({
        id: 'pm-new',
        code: 'stripe_live',
        name: { default: 'Stripe', en: 'Stripe' },
        provider: 'stripe',
        isActive: true,
        isTestMode: false,
        sortOrder: 0,
        config: {},
      }),
    );
  });

  it('renders with initial empty form', () => {
    configure();
    expect(page.form.controls.code.value).toBe('');
    expect(page.form.controls.provider.value).toBe('');
    expect(page.form.invalid).toBe(true);
  });

  describe('provider catalogue', () => {
    function optionTexts(): string[] {
      const select: HTMLSelectElement = fixture.nativeElement.querySelector(
        '[data-testid="pm-new-provider"]',
      );
      return Array.from(select.options).map((o) => o.textContent?.trim() ?? '');
    }

    it('offers every provider the API catalogue lists, including one admin never heard of', () => {
      configure();
      fixture.detectChanges();
      const texts = optionTexts();
      expect(texts).toContain('Canary Pay');
      expect(texts).toContain('Stripe');
      expect(texts).not.toContain('PayPal');
    });

    it('submits a catalogue-only provider id', () => {
      configure();
      page.form.patchValue({
        code: 'canary_main',
        name: { default: 'Canary' },
        provider: 'canary_pay',
      });
      page.submit();
      expect(createSpy.mock.calls[0][0].provider).toBe('canary_pay');
    });

    it('shows a retryable error when the catalogue fails to load', () => {
      providersSpy = jest.fn(() =>
        throwError(() => new ApiError({ code: 'GENERIC', message: 'down' })),
      );
      configure();
      fixture.detectChanges();
      const err = fixture.nativeElement.querySelector('[data-testid="pm-new-providers-error"]');
      expect(err).not.toBeNull();
      expect(page.form.controls.provider.disabled).toBe(false);
      providersSpy.mockReturnValue(of(catalogue));
      page.reloadProviders();
      fixture.detectChanges();
      expect(optionTexts()).toContain('Canary Pay');
    });

    it('shows an empty state when no provider is registered', () => {
      providersSpy = jest.fn(() => of([]));
      configure();
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="pm-new-providers-empty"]'),
      ).not.toBeNull();
    });
  });

  describe('validators', () => {
    it('codeFormat rejects uppercase characters', () => {
      configure();
      page.form.controls.code.setValue('STRIPE');
      page.form.controls.code.markAsTouched();
      expect(page.form.controls.code.hasError('codeFormat')).toBe(true);
      expect(page.codeError()).toContain('lowercase');
    });

    it('codeFormat rejects spaces and punctuation', () => {
      configure();
      page.form.controls.code.setValue('stripe live');
      page.form.controls.code.markAsTouched();
      expect(page.form.controls.code.hasError('codeFormat')).toBe(true);
    });

    it('codeFormat accepts lowercase + digits + underscores', () => {
      configure();
      page.form.controls.code.setValue('stripe_2024');
      expect(page.form.controls.code.hasError('codeFormat')).toBe(false);
    });

    it('required rejects empty code', () => {
      configure();
      page.form.controls.code.setValue('');
      page.form.controls.code.markAsTouched();
      expect(page.codeError()).toBe('Code is required.');
    });

    it('minLength rejects single-character code', () => {
      configure();
      page.form.controls.code.setValue('a');
      page.form.controls.code.markAsTouched();
      expect(page.codeError()).toContain('at least 2');
    });

    it('maxLength rejects a 51-character code', () => {
      configure();
      page.form.controls.code.setValue('a'.repeat(51));
      page.form.controls.code.markAsTouched();
      expect(page.codeError()).toContain('50 characters or fewer');
    });

    it('translatableRequired rejects empty default locale', () => {
      configure();
      page.form.controls.name.setValue({ default: '' });
      page.form.controls.name.markAsTouched();
      expect(page.nameError()).toContain('Default-locale name');
    });

    it('translatableRequired rejects whitespace-only default', () => {
      configure();
      page.form.controls.name.setValue({ default: '   ' });
      page.form.controls.name.markAsTouched();
      expect(page.form.controls.name.hasError('translatableRequired')).toBe(true);
    });

    it('translatableRequired accepts non-empty default', () => {
      configure();
      page.form.controls.name.setValue({ default: 'Stripe' });
      expect(page.form.controls.name.hasError('translatableRequired')).toBe(false);
    });

    it('provider required rejects empty', () => {
      configure();
      page.form.controls.provider.markAsTouched();
      expect(page.providerError()).toBe('Provider is required.');
    });

    it('sortOrder min rejects negative', () => {
      configure();
      page.form.controls.sortOrder.setValue(-1);
      page.form.controls.sortOrder.markAsTouched();
      expect(page.form.controls.sortOrder.hasError('min')).toBe(true);
    });
  });

  it('submit is a no-op when invalid', () => {
    configure();
    page.submit();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('submit POSTs valid payload and navigates to the detail page', () => {
    configure();
    fillValid();
    page.submit();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const payload = createSpy.mock.calls[0][0];
    expect(payload.code).toBe('stripe_live');
    expect(payload.provider).toBe('stripe');
    expect(payload.isActive).toBe(true);
    expect(navigateSpy).toHaveBeenCalledWith(['/payment-methods', 'pm-new']);
  });

  it('omits description when default-locale is blank', () => {
    configure();
    fillValid();
    page.form.patchValue({ description: { default: '   ' } });
    page.submit();
    const payload = createSpy.mock.calls[0][0];
    expect('description' in payload).toBe(false);
  });

  it('includes description when default-locale has content', () => {
    configure();
    fillValid();
    page.form.patchValue({ description: { default: 'Card payments' } });
    page.submit();
    const payload = createSpy.mock.calls[0][0];
    expect(payload.description).toEqual({ default: 'Card payments' });
  });

  it('ApiConflictError sets conflict flag + code error + focuses code input', () => {
    createSpy = jest.fn(() =>
      throwError(() => new ApiConflictError({ code: 'CONFLICT', message: 'taken' })),
    );
    configure();
    fillValid();
    page.submit();
    expect(page.conflict()).toBe(true);
    expect(page.form.controls.code.hasError('conflict')).toBe(true);
    expect(page.codeError()).toContain('already exists');
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('editing the code clears the conflict flag', () => {
    configure();
    page.conflict.set(true);
    page.form.controls.code.setValue('stripe_live_v2');
    expect(page.conflict()).toBe(false);
  });

  it('ApiForbiddenError surfaces the permission banner', () => {
    createSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    fillValid();
    page.submit();
    expect(page.topError()).toContain('permission');
  });

  it('generic ApiError surfaces its message in the banner', () => {
    createSpy = jest.fn(() =>
      throwError(() => new ApiError({ code: 'GENERIC', message: 'Backend exploded' })),
    );
    configure();
    fillValid();
    page.submit();
    expect(page.topError()).toBe('Backend exploded');
  });

  it('saving flag gates double-submit', () => {
    configure();
    fillValid();
    page.saving.set(true);
    page.submit();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('has no axe violations on mount', async () => {
    configure();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations when the top error banner is rendered', async () => {
    createSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    fillValid();
    page.submit();
    fixture.detectChanges();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});

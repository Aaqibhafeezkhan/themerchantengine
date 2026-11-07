import { ApiConflictError, ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { PaymentMethodsService } from '@admin-services';
import * as adminUi from '@admin-ui';
import { axe, toHaveNoViolations } from 'jest-axe';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { BOOTSTRAP_LOCALE } from '../../core/tokens';
import { PaymentMethodDetailPage } from './payment-method-detail.page';

expect.extend(toHaveNoViolations);

const methodFixture = {
  id: 'pm-1',
  code: 'stripe_live',
  name: { default: 'Stripe', en: 'Stripe' },
  description: { default: 'Card payments via Stripe' },
  provider: 'stripe' as const,
  isActive: true,
  isTestMode: false,
  sortOrder: 0,
  config: { publishableKey: 'pk_live_xxx', apiKey: '***' },
};

describe('PaymentMethodDetailPage', () => {
  let fixture: ComponentFixture<PaymentMethodDetailPage>;
  let page: PaymentMethodDetailPage;
  let getSpy: jest.Mock;
  let updateSpy: jest.Mock;
  let deleteSpy: jest.Mock;
  let providersSpy: jest.Mock;
  let confirmSpy: jest.SpyInstance;
  let paramMap$: BehaviorSubject<ParamMap>;

  function configure(
    id = 'pm-1',
    perms: string[] = ['payment_methods:view', 'payment_methods:update', 'payment_methods:delete'],
  ) {
    paramMap$ = new BehaviorSubject<ParamMap>(convertToParamMap({ id }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: BOOTSTRAP_LOCALE, useValue: 'fr' },
        {
          provide: PaymentMethodsService,
          useValue: {
            get: getSpy,
            update: updateSpy,
            delete: deleteSpy,
            providers: providersSpy,
          },
        },
        { provide: ActivatedRoute, useValue: { paramMap: paramMap$.asObservable() } },
      ],
    });
    TestBed.inject(AuthStore).setSession({
      user: { id: 'u', email: 'a@b', permissions: perms, roles: [], status: 'active' },
    });
    fixture = TestBed.createComponent(PaymentMethodDetailPage);
    page = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    getSpy = jest.fn(() => of(methodFixture));
    updateSpy = jest.fn((_id: string, body: Record<string, unknown>) =>
      of({ ...methodFixture, ...body }),
    );
    deleteSpy = jest.fn(() => of(undefined));
    providersSpy = jest.fn(() => of([]));
    confirmSpy = jest.spyOn(adminUi, 'openConfirmDialog').mockResolvedValue(true);
  });

  afterEach(() => confirmSpy.mockRestore());

  it('seeds the form + config from the loaded method', () => {
    configure();
    expect(page.form.controls.sortOrder.value).toBe(0);
    expect(page.configRows().map((r) => r.key)).toEqual(['apiKey', 'publishableKey']);
  });

  it('addConfigKey stages a new empty row + marks config dirty', () => {
    configure();
    page.newKey.set('webhookUrl');
    page.addConfigKey();
    expect(page.configRows().find((r) => r.key === 'webhookUrl')).toBeDefined();
    expect(page.configDirty()).toBe(true);
  });

  it('removeConfigKey stages null so PATCH deletes the key', () => {
    configure();
    page.removeConfigKey('publishableKey');
    expect(page.configDirty()).toBe(true);
    // The working copy holds null; the save call forwards it as-is.
    expect(page.pendingConfig()['publishableKey']).toBeNull();
  });

  it('save is a no-op when pristine', () => {
    configure();
    page.save();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('save PATCHes only dirty fields + staged config when dirty', () => {
    configure();
    page.form.controls.sortOrder.setValue(5);
    page.form.controls.sortOrder.markAsDirty();
    page.onConfigInput('publishableKey', {
      target: { value: 'pk_test_new' },
    } as unknown as Event);
    page.save();
    const body = updateSpy.mock.calls[0][1];
    expect(body.sortOrder).toBe(5);
    expect(body.config.publishableKey).toBe('pk_test_new');
    // Untouched fields stay out of the body.
    expect('name' in body).toBe(false);
  });

  it('confirmDelete requires confirm + calls service.delete', async () => {
    configure();
    await page.confirmDelete();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith('pm-1');
  });

  it('ApiNotFoundError surfaces a clear error', () => {
    getSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'missing' })),
    );
    configure('zzz');
    expect(page.error()).toBe('Payment method not found.');
  });

  it('ApiForbiddenError surfaces a permission error', () => {
    getSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure('zzz');
    expect(page.error()).toContain('permission');
  });

  it('save surfaces ApiConflictError with the code-conflict message', () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiConflictError({ code: 'CONFLICT', message: 'code in use' })),
    );
    configure();
    page.form.controls.sortOrder.setValue(5);
    page.form.controls.sortOrder.markAsDirty();
    page.save();
    expect(page.error()).toContain('Code conflict');
    expect(page.busy()).toBe(false);
  });

  it('save surfaces a permission banner on 403', () => {
    updateSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    page.form.controls.sortOrder.setValue(5);
    page.form.controls.sortOrder.markAsDirty();
    page.save();
    expect(page.error()).toContain('permission');
  });

  it('save surfaces a generic ApiError message', () => {
    updateSpy = jest.fn(() => throwError(() => new ApiError({ code: 'X', message: 'boom' })));
    configure();
    page.form.controls.sortOrder.setValue(5);
    page.form.controls.sortOrder.markAsDirty();
    page.save();
    expect(page.error()).toBe('boom');
  });

  it('confirmDelete surfaces a permission error on 403', async () => {
    deleteSpy = jest.fn(() =>
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure();
    await page.confirmDelete();
    expect(page.error()).toContain('permission');
    expect(page.busy()).toBe(false);
  });

  it('confirmDelete surfaces ApiNotFoundError when the method vanished', async () => {
    deleteSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'gone' })),
    );
    configure();
    await page.confirmDelete();
    expect(page.error()).toBe('Payment method not found.');
  });

  it('confirmDelete is a no-op when the user cancels the dialog', async () => {
    confirmSpy.mockRestore();
    confirmSpy = jest.spyOn(adminUi, 'openConfirmDialog').mockResolvedValue(false);
    configure();
    await page.confirmDelete();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('save is a no-op while busy', () => {
    configure();
    page.form.controls.sortOrder.setValue(5);
    page.form.controls.sortOrder.markAsDirty();
    page.busy.set(true);
    page.save();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  describe('schema-driven config for a provider admin never heard of', () => {
    const canaryMethod = {
      ...methodFixture,
      id: 'pm-9',
      code: 'canary_main',
      provider: 'canary_pay',
      config: { merchantId: 'm-1', merchantPassword: '***', sandbox: false, legacyNote: 'x' },
    };
    const canaryEntry = {
      id: 'canary_pay',
      label: 'Canary Pay',
      actionTypes: ['redirect'],
      secretFields: ['merchantPassword'],
      configJsonSchema: {
        type: 'object',
        properties: {
          merchantId: { type: 'string', description: 'Id from the Canary dashboard.' },
          merchantPassword: { type: 'string' },
          sandbox: { type: 'boolean' },
          checkoutMode: { type: 'string', enum: ['embedded', 'redirect'] },
          retries: { type: 'number' },
        },
      },
    };

    beforeEach(() => {
      getSpy = jest.fn(() => of(canaryMethod));
      providersSpy.mockReturnValue(of([canaryEntry]));
    });

    function field(key: string): HTMLInputElement | HTMLSelectElement {
      return fixture.nativeElement.querySelector(`[data-testid="pm-field-${key}"]`);
    }

    it('renders one control per schema property with the right kind', () => {
      configure('pm-9');
      expect(field('merchantId').getAttribute('type')).toBe('text');
      expect(field('merchantPassword').getAttribute('type')).toBe('password');
      expect(field('sandbox').getAttribute('type')).toBe('checkbox');
      expect(field('retries').getAttribute('type')).toBe('number');
      const select = field('checkoutMode') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['embedded', 'redirect']);
    });

    it('labels each control with a readable name, not the raw key', () => {
      configure('pm-9');
      const label = (key: string): string =>
        fixture.nativeElement
          .querySelector(`[data-testid="pm-field-label-${key}"]`)
          .textContent.trim();
      expect(label('merchantPassword')).toBe('Merchant password');
      expect(label('sandbox')).toBe('Sandbox');
      expect(label('checkoutMode')).toBe('Checkout mode');
    });

    it('prefers the schema title for the label', () => {
      providersSpy.mockReturnValue(
        of([
          {
            ...canaryEntry,
            configJsonSchema: {
              type: 'object',
              properties: { merchantId: { type: 'string', title: 'Merchant ID' } },
            },
          },
        ]),
      );
      configure('pm-9');
      expect(
        fixture.nativeElement
          .querySelector('[data-testid="pm-field-label-merchantId"]')
          .textContent.trim(),
      ).toBe('Merchant ID');
    });

    it('shows the schema description as helper text', () => {
      configure('pm-9');
      expect(fixture.nativeElement.textContent).toContain('Id from the Canary dashboard.');
    });

    it('never puts the stored secret in the DOM and does not resend the mask', () => {
      configure('pm-9');
      expect((field('merchantPassword') as HTMLInputElement).value).toBe('');
      page.form.controls.sortOrder.setValue(3);
      page.form.controls.sortOrder.markAsDirty();
      page.onConfigInput('merchantId', { target: { value: 'm-2' } } as unknown as Event);
      page.save();
      const body = updateSpy.mock.calls[0][1];
      expect(body.config.merchantId).toBe('m-2');
      expect('merchantPassword' in body.config).toBe(false);
    });

    it('sends a new secret value when the admin types one', () => {
      configure('pm-9');
      page.onConfigInput('merchantPassword', {
        target: { value: 'new-secret' },
      } as unknown as Event);
      page.save();
      expect(updateSpy.mock.calls[0][1].config.merchantPassword).toBe('new-secret');
    });

    it('sends null to delete a stored secret', () => {
      configure('pm-9');
      page.removeConfigKey('merchantPassword');
      page.save();
      expect(updateSpy.mock.calls[0][1].config.merchantPassword).toBeNull();
    });

    it('stages a boolean and an enum as typed values', () => {
      configure('pm-9');
      page.onBooleanInput('sandbox', { target: { checked: true } } as unknown as Event);
      page.onConfigInput('checkoutMode', { target: { value: 'redirect' } } as unknown as Event);
      page.save();
      const cfg = updateSpy.mock.calls[0][1].config;
      expect(cfg.sandbox).toBe(true);
      expect(cfg.checkoutMode).toBe('redirect');
    });

    it('stores a number field as a number', () => {
      configure('pm-9');
      page.onNumberInput('retries', { target: { value: '4' } } as unknown as Event);
      page.save();
      expect(updateSpy.mock.calls[0][1].config.retries).toBe(4);
    });

    it('keeps keys outside the schema in the generic rows', () => {
      configure('pm-9');
      expect(page.configRows().map((r) => r.key)).toEqual(['legacyNote']);
    });

    it('still renders the form when the catalogue fails to load', () => {
      providersSpy.mockReturnValue(throwError(() => new ApiError({ code: 'X', message: 'down' })));
      configure('pm-9');
      expect(page.current()).not.toBeNull();
      expect(page.configRows().map((r) => r.key)).toContain('merchantId');
    });

    it('has no axe violations', async () => {
      configure('pm-9');
      expect(await axe(fixture.nativeElement)).toHaveNoViolations();
    });
  });

  it('hides the delete button for an admin without payment_methods:delete', () => {
    configure('pm-1', ['payment_methods:view', 'payment_methods:update']);
    expect(page.canDelete()).toBe(false);
    const deleteBtn = fixture.nativeElement.querySelector('[data-testid="pm-delete"]');
    expect(deleteBtn).toBeFalsy();
  });

  it('has no axe violations', async () => {
    configure();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations when the error banner is rendered', async () => {
    getSpy = jest.fn(() =>
      throwError(() => new ApiNotFoundError({ code: 'NOT_FOUND', message: 'missing' })),
    );
    configure('zzz');
    fixture.detectChanges();
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});

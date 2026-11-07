import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import {
  FormBuilder,
  ReactiveFormsModule,
  Validators,
  type AbstractControl,
  type ValidationErrors,
} from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  ButtonComponent,
  FormFieldComponent,
  InputComponent,
  TranslatableInputComponent,
  type TranslatableValue,
} from '@admin-ui';
import {
  PaymentMethodsService,
  type CreatePaymentMethodRequest,
  type PaymentProvider,
  type PaymentProviderCatalogueEntry,
} from '@admin-services';
import { ApiConflictError, ApiError, ApiForbiddenError } from '@admin-types';
import { Subject, takeUntil } from 'rxjs';
import { translatableRequired } from '../../shared/validators/translatable-required.validator';

const CODE_REGEX = /^[a-z0-9_]+$/;

function codeFormat(control: AbstractControl): ValidationErrors | null {
  const value = control.value;
  if (typeof value !== 'string' || value.length === 0) return null;
  return CODE_REGEX.test(value) ? null : { codeFormat: true };
}

@Component({
  selector: 'app-payment-method-new-page',
  standalone: true,
  imports: [
    RouterLink,
    ReactiveFormsModule,
    ButtonComponent,
    FormFieldComponent,
    InputComponent,
    TranslatableInputComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="p-6 md:p-10 flex flex-col gap-6" data-testid="payment-method-new-page">
      <nav aria-label="Breadcrumb" class="text-xs text-ink-muted">
        <a routerLink="/payment-methods" class="hover:underline">Payment methods</a>
        <span aria-hidden="true"> / </span>
        <span [attr.aria-current]="'page'">New</span>
      </nav>

      <header>
        <p class="text-xs tracking-widest uppercase text-ink-muted">Commerce</p>
        <h1 class="mt-2 text-3xl md:text-4xl font-bold tracking-tight">New payment method</h1>
        <p class="mt-3 text-sm text-ink-muted max-w-xl">
          Registers a new checkout provider. Secrets and provider-specific config are entered on the
          detail page after creation so they never land in browser history.
        </p>
      </header>

      <div role="alert" aria-atomic="true" data-testid="pm-new-error">
        @if (topError()) {
          <p class="text-xs border border-status-error text-ink p-3">
            {{ topError() }}
          </p>
        }
      </div>

      <form
        [formGroup]="form"
        (ngSubmit)="submit()"
        class="flex flex-col gap-6 border border-line bg-surface p-6 md:p-8 max-w-3xl"
        novalidate
      >
        <app-form-field
          label="Code"
          [fieldId]="codeId"
          [error]="codeError()"
          hint="Lowercase letters, digits, underscores only. Example: stripe_live."
          [required]="true"
        >
          <app-input
            [id]="codeId"
            formControlName="code"
            autocomplete="off"
            [invalid]="!!codeError()"
            data-testid="pm-new-code"
          />
        </app-form-field>

        <app-form-field label="Name" [fieldId]="nameId" [error]="nameError()" [required]="true">
          <app-translatable-input
            [inputId]="nameId"
            testId="pm-new-name"
            idPrefix="pm-new-name"
            label="Payment method name"
            formControlName="name"
            [invalid]="!!nameError()"
          />
        </app-form-field>

        <app-form-field label="Description" [fieldId]="descriptionId">
          <app-translatable-input
            [inputId]="descriptionId"
            testId="pm-new-description"
            idPrefix="pm-new-description"
            label="Payment method description"
            formControlName="description"
          />
        </app-form-field>

        <app-form-field
          label="Provider"
          [fieldId]="providerId"
          [error]="providerError()"
          hint="Drives which upstream integration applies at checkout."
          [required]="true"
        >
          <select
            [id]="providerId"
            formControlName="provider"
            required
            [attr.aria-describedby]="providerDescribedBy()"
            [attr.aria-invalid]="providerError() ? 'true' : null"
            class="min-h-[44px] w-full md:w-96 px-3 py-2 bg-surface border border-line text-ink text-sm focus:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            data-testid="pm-new-provider"
          >
            <option value="" disabled>— Select provider —</option>
            @for (p of providers(); track p.id) {
              <option [value]="p.id">{{ p.label }}</option>
            }
          </select>
          <div role="alert">
            @if (providersError()) {
              <p class="mt-2 text-xs text-ink" data-testid="pm-new-providers-error">
                {{ providersError() }}
                <button
                  type="button"
                  class="underline min-h-[44px] px-2"
                  (click)="reloadProviders()"
                  data-testid="pm-new-providers-retry"
                >
                  Retry
                </button>
              </p>
            }
          </div>
          @if (!providersError() && providersLoaded() && providers().length === 0) {
            <p class="mt-2 text-xs text-ink-muted" data-testid="pm-new-providers-empty">
              No payment provider is registered on this server.
            </p>
          }
        </app-form-field>

        <div class="grid gap-4 md:grid-cols-2 items-start">
          <app-form-field
            label="Sort order"
            [fieldId]="sortId"
            hint="Integer ≥ 0. Lower renders first."
          >
            <app-input
              [id]="sortId"
              type="number"
              formControlName="sortOrder"
              data-testid="pm-new-sort"
            />
          </app-form-field>
          <div class="flex flex-col gap-3 pt-6">
            <label class="inline-flex items-center gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                formControlName="isActive"
                class="h-5 w-5 border border-line bg-surface"
                data-testid="pm-new-active"
              />
              <span class="text-sm text-ink">Offer at checkout</span>
            </label>
            <label class="inline-flex items-center gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                formControlName="isTestMode"
                class="h-5 w-5 border border-line bg-surface"
                data-testid="pm-new-test-mode"
              />
              <span class="text-sm text-ink">Test mode</span>
            </label>
          </div>
        </div>

        <div class="flex items-center justify-end gap-3 pt-2">
          <a
            routerLink="/payment-methods"
            class="inline-flex items-center justify-center gap-2 font-medium tracking-widest uppercase select-none motion-safe:transition-colors motion-safe:duration-75 focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2 bg-transparent text-ink hover:bg-surface-elevated px-5 py-3 text-sm min-h-[44px]"
            data-testid="pm-new-cancel"
          >
            Cancel
          </a>
          <app-button
            type="submit"
            [disabled]="form.invalid || saving()"
            [loading]="saving()"
            data-testid="pm-new-save"
          >
            Create payment method
          </app-button>
        </div>
      </form>
    </section>
  `,
})
export class PaymentMethodNewPage implements OnInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly service = inject(PaymentMethodsService);
  private readonly destroy$ = new Subject<void>();

  readonly codeId = 'pm-new-code';
  readonly nameId = 'pm-new-name-default';
  readonly descriptionId = 'pm-new-description-default';
  readonly providerId = 'pm-new-provider';
  readonly sortId = 'pm-new-sort';

  readonly saving = signal(false);
  readonly topError = signal<string | null>(null);
  readonly conflict = signal(false);

  /** The API catalogue decides which providers exist, so a new one needs no admin change. */
  readonly providers = signal<readonly PaymentProviderCatalogueEntry[]>([]);
  readonly providersLoaded = signal(false);
  readonly providersError = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    code: [
      '',
      [Validators.required, Validators.minLength(2), Validators.maxLength(50), codeFormat],
    ],
    name: this.fb.nonNullable.control<TranslatableValue>({ default: '' }, [translatableRequired]),
    description: this.fb.nonNullable.control<TranslatableValue>({ default: '' }),
    provider: this.fb.nonNullable.control<PaymentProvider | ''>('' as PaymentProvider | '', [
      Validators.required,
    ]),
    isActive: this.fb.nonNullable.control<boolean>(true),
    isTestMode: this.fb.nonNullable.control<boolean>(false),
    sortOrder: this.fb.nonNullable.control<number>(0, [Validators.min(0)]),
  });

  codeError(): string | null {
    const c = this.form.controls.code;
    if (this.conflict()) return 'A payment method with this code already exists.';
    if (!c.touched && !c.dirty) return null;
    if (c.hasError('required')) return 'Code is required.';
    if (c.hasError('minlength')) return 'Code must be at least 2 characters.';
    if (c.hasError('maxlength')) return 'Code must be 50 characters or fewer.';
    if (c.hasError('codeFormat')) {
      return 'Use lowercase letters, digits, and underscores only.';
    }
    return null;
  }

  nameError(): string | null {
    const c = this.form.controls.name;
    if (!c.touched && !c.dirty) return null;
    if (c.hasError('translatableRequired')) return 'Default-locale name is required.';
    return null;
  }

  providerError(): string | null {
    const c = this.form.controls.provider;
    if (!c.touched && !c.dirty) return null;
    if (c.hasError('required')) return 'Provider is required.';
    return null;
  }

  providerDescribedBy(): string | null {
    if (this.providerError()) return `${this.providerId}-error`;
    return `${this.providerId}-hint`;
  }

  ngOnInit(): void {
    this.form.controls.code.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(() => {
      if (this.conflict()) this.conflict.set(false);
    });
    this.reloadProviders();
  }

  reloadProviders(): void {
    this.providersError.set(null);
    this.service
      .providers()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (entries) => {
          this.providers.set(entries);
          this.providersLoaded.set(true);
        },
        error: () => {
          this.providersError.set('Could not load the provider list.');
        },
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  submit(): void {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      queueMicrotask(() => this.focusFirstInvalid());
      return;
    }

    this.saving.set(true);
    this.topError.set(null);
    const raw = this.form.getRawValue();
    const description =
      raw.description && typeof raw.description.default === 'string'
        ? raw.description.default.trim()
        : '';
    const payload: CreatePaymentMethodRequest = {
      code: raw.code,
      name: raw.name,
      provider: raw.provider as PaymentProvider,
      isActive: raw.isActive,
      isTestMode: raw.isTestMode,
      sortOrder: Number(raw.sortOrder),
      ...(description.length > 0 ? { description: raw.description } : {}),
    };

    this.service
      .create(payload)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (created) => {
          this.saving.set(false);
          void this.router.navigate(['/payment-methods', created.id]);
        },
        error: (err: unknown) => {
          this.saving.set(false);
          if (err instanceof ApiConflictError) {
            this.conflict.set(true);
            this.form.controls.code.setErrors({ conflict: true });
            this.form.controls.code.markAsTouched();
            queueMicrotask(() => document.getElementById(this.codeId)?.focus());
            return;
          }
          this.topError.set(this.formatError(err));
        },
      });
  }

  private focusFirstInvalid(): void {
    const order: Array<[string, AbstractControl]> = [
      [this.codeId, this.form.controls.code],
      [this.nameId, this.form.controls.name],
      [this.providerId, this.form.controls.provider],
      [this.sortId, this.form.controls.sortOrder],
    ];
    for (const [id, control] of order) {
      if (control.invalid) {
        document.getElementById(id)?.focus();
        return;
      }
    }
  }

  private formatError(err: unknown): string {
    if (err instanceof ApiForbiddenError)
      return 'You do not have permission to create payment methods.';
    if (err instanceof ApiConflictError) return 'Code conflict — pick a different code.';
    if (err instanceof ApiError && err.message) return err.message;
    return 'Could not create the payment method. Please retry.';
  }
}

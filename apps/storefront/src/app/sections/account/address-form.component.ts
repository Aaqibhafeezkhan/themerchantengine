import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  EventEmitter,
  inject,
  input,
  OnChanges,
  Output,
  signal,
  SimpleChanges,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import {
  createAddressRequestSchema,
  type Address,
  type CreateAddressRequest,
  type UpdateAddressRequest,
} from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { StoreConfigService } from '../../services/store-config.service';
import { countryName } from '../../../i18n';
import { ButtonComponent } from '../../ui/button.component';
import { PHONE_RE } from '../../../lib/phone';

const COUNTRY_RE = /^[A-Z]{2}$/;

let nextHintId = 0;

export interface AddressFormSubmit {
  payload: CreateAddressRequest | UpdateAddressRequest;
  isDefault: boolean;
}

@Component({
  selector: 'app-address-form',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="form"
      [formGroup]="form"
      (ngSubmit)="onSubmit()"
      (input)="formError.set(null)"
      (change)="formError.set(null)"
      novalidate
      [attr.data-testid]="'account-address-form-' + (initialAddress()?.id ?? 'new')"
      data-testid-shared="account-address-form"
    >
      <h2 class="title">
        {{
          initialAddress()
            ? strings().account.addresses.form.editTitle
            : strings().account.addresses.form.addTitle
        }}
      </h2>
      <div class="grid">
        <label class="field">
          <span class="label">{{ strings().account.addresses.form.fullName }}</span>
          <input
            [id]="fieldId('fullName')"
            formControlName="fullName"
            type="text"
            autocomplete="name"
            required
            [attr.aria-describedby]="showError('fullName') ? errorId('fullName') : null"
            [attr.aria-invalid]="showError('fullName') ? 'true' : null"
          />
          <span [id]="errorId('fullName')" class="error" aria-live="polite">
            @if (showError('fullName')) {
              {{ strings().account.addresses.errors.requiredField }}
            }
          </span>
        </label>
        <label class="field">
          <span class="label">{{ strings().account.addresses.form.phone }}</span>
          <input
            [id]="fieldId('phone')"
            formControlName="phone"
            type="tel"
            autocomplete="tel"
            inputmode="tel"
            dir="auto"
            required
            [attr.aria-describedby]="showError('phone') ? errorId('phone') : null"
            [attr.aria-invalid]="showError('phone') ? 'true' : null"
          />
          <span [id]="errorId('phone')" class="error" aria-live="polite">
            @if (showError('phone')) {
              {{ strings().account.addresses.errors.invalidPhone }}
            }
          </span>
        </label>
        <label class="field span-2">
          <span class="label">{{ strings().account.addresses.form.addressLine1 }}</span>
          <input
            [id]="fieldId('addressLine1')"
            formControlName="addressLine1"
            type="text"
            autocomplete="address-line1"
            required
            [attr.aria-describedby]="showError('addressLine1') ? errorId('addressLine1') : null"
            [attr.aria-invalid]="showError('addressLine1') ? 'true' : null"
          />
          <span [id]="errorId('addressLine1')" class="error" aria-live="polite">
            @if (showError('addressLine1')) {
              {{ strings().account.addresses.errors.requiredField }}
            }
          </span>
        </label>
        <label class="field span-2">
          <span class="label">{{ strings().account.addresses.form.addressLine2 }}</span>
          <input
            [id]="fieldId('addressLine2')"
            formControlName="addressLine2"
            type="text"
            autocomplete="address-line2"
          />
        </label>
        <label class="field">
          <span class="label">{{ strings().account.addresses.form.city }}</span>
          <input
            [id]="fieldId('city')"
            formControlName="city"
            type="text"
            autocomplete="address-level2"
            required
            [attr.aria-describedby]="showError('city') ? errorId('city') : null"
            [attr.aria-invalid]="showError('city') ? 'true' : null"
          />
          <span [id]="errorId('city')" class="error" aria-live="polite">
            @if (showError('city')) {
              {{ strings().account.addresses.errors.requiredField }}
            }
          </span>
        </label>
        <label class="field">
          <span class="label">{{ strings().account.addresses.form.state }}</span>
          <input
            [id]="fieldId('state')"
            formControlName="state"
            type="text"
            autocomplete="address-level1"
          />
        </label>
        <label class="field">
          <span class="label">{{ strings().account.addresses.form.postalCode }}</span>
          <input
            [id]="fieldId('postalCode')"
            formControlName="postalCode"
            type="text"
            autocomplete="postal-code"
            inputmode="text"
            dir="auto"
          />
        </label>
        <label class="field">
          <span class="label">{{ strings().account.addresses.form.country }}</span>
          <!-- Finding A3: a free-text two-letter code is wrong or redundant on
               a store that ships to a known set of markets. The set is
               identity.areaServed in the runtime config (DR-31, plan E2.5),
               so the options are the markets this install actually serves. -->
          <select
            [id]="fieldId('country')"
            formControlName="country"
            autocomplete="country"
            required
            [attr.aria-describedby]="
              showError('country') ? countryHintId + ' ' + errorId('country') : countryHintId
            "
            [attr.aria-invalid]="showError('country') ? 'true' : null"
          >
            @for (option of countryOptions(); track option.code) {
              <option [value]="option.code">{{ option.label }}</option>
            }
          </select>
          <!-- Only with a market to name: the copy reads "We deliver within
               {country}." and a store that has configured none would ship a
               sentence ending in a bare full stop. -->
          @if (countryOptions().length && strings().account.addresses.form.countryHint) {
            <span [id]="countryHintId" class="helper">
              {{ strings().account.addresses.form.countryHint }}
            </span>
          }
          <span [id]="errorId('country')" class="error" aria-live="polite">
            @if (showError('country')) {
              {{ strings().account.addresses.errors.invalidCountry }}
            }
          </span>
        </label>
        <label class="checkbox span-2">
          <input
            type="checkbox"
            formControlName="isDefault"
            [attr.data-testid]="'account-address-form-default-' + (initialAddress()?.id ?? 'new')"
          />
          <span>{{ strings().account.addresses.form.isDefaultLabel }}</span>
        </label>
      </div>
      @if (formError()) {
        <p class="form-error" role="alert" data-testid="account-address-form-error">
          {{ formError() }}
        </p>
      }
      <div class="actions">
        <app-button
          type="submit"
          variant="primary"
          [loading]="saving()"
          testId="account-address-form-submit"
        >
          {{
            saving()
              ? strings().account.addresses.form.saving
              : strings().account.addresses.form.save
          }}
        </app-button>
        <button
          type="button"
          class="link"
          (click)="cancel.emit()"
          data-testid="account-address-form-cancel"
        >
          {{ strings().account.addresses.form.cancel }}
        </button>
      </div>
    </form>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        padding-block: 1rem;
        padding-inline: 1rem;
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
        background-color: var(--brand-surface);
      }
      .title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 0.75rem;
      }
      @media (min-width: 768px) {
        .grid {
          grid-template-columns: 1fr 1fr;
        }
        .span-2 {
          grid-column: 1 / -1;
        }
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .label {
        color: var(--brand-text);
        font-size: var(--brand-text-body);
      }
      .field input {
        background-color: var(--brand-surface);
        color: var(--brand-text);
        /* agent_docs/storefront/brand-tokens.md: a control resting boundary is load-bearing. */
        border: 1px solid var(--brand-border-interactive);
        padding-inline: 0.75rem;
        padding-block: 0.5rem;
        font-size: var(--brand-text-body);
        border-radius: var(--brand-radius-sm);
      }
      .field input:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .helper {
        color: var(--brand-text-muted);
        font-size: var(--brand-text-micro);
      }
      .error {
        color: var(--brand-error);
        font-size: var(--brand-text-micro);
        min-block-size: 1rem;
      }
      .checkbox {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: var(--brand-text-body);
        color: var(--brand-text);
      }
      .form-error {
        color: var(--brand-error);
        margin: 0;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 1rem;
      }
      .link {
        background: transparent;
        border: 0;
        color: var(--brand-primary);
        cursor: pointer;
        font: inherit;
        padding: 0;
      }
      .link:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
    `,
  ],
})
export class AddressFormComponent implements OnChanges {
  /** When provided, the form pre-populates and emits as an update. */
  readonly initialAddress = input<Address | null>(null);
  readonly saving = input<boolean>(false);
  readonly externalError = input<string | null>(null);

  @Output() readonly submit = new EventEmitter<AddressFormSubmit>();
  @Output() readonly cancel = new EventEmitter<void>();

  private readonly fb = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  private readonly storeConfig = inject(StoreConfigService);

  /**
   * The markets this store ships to, named in the reader's language.
   *
   * `identity.areaServed` first, the store's own country as the single
   * fallback: an install that configured neither still has to render a
   * selectable option, or the form can never be submitted.
   */
  protected readonly countryOptions = computed(() => {
    const identity = this.storeConfig.identity();
    const codes = identity.areaServed.length
      ? identity.areaServed
      : [identity.address.country].filter((code) => code.length > 0);
    const locale = this.locale.locale();
    return codes.map((code) => ({ code, label: countryName(code, locale) }));
  });

  /** The option a new address starts on: the store's own market. */
  protected readonly defaultCountry = computed(() => this.countryOptions()[0]?.code ?? '');
  protected readonly strings = this.locale.strings;

  protected readonly formError = signal<string | null>(null);
  private readonly instanceId = nextHintId++;

  protected readonly countryHintId = `account-address-country-hint-${this.instanceId}`;
  protected fieldId(name: string): string {
    return `account-address-${name}-${this.instanceId}`;
  }
  protected errorId(name: string): string {
    return `account-address-${name}-error-${this.instanceId}`;
  }

  protected readonly form: FormGroup = this.fb.nonNullable.group({
    fullName: ['', [Validators.required, Validators.maxLength(100)]],
    phone: ['', [Validators.required, Validators.pattern(PHONE_RE)]],
    addressLine1: ['', [Validators.required, Validators.maxLength(255)]],
    addressLine2: ['', [Validators.maxLength(255)]],
    city: ['', [Validators.required, Validators.maxLength(100)]],
    state: ['', [Validators.maxLength(100)]],
    postalCode: ['', [Validators.maxLength(20)]],
    country: [this.defaultCountry(), [Validators.required, Validators.pattern(COUNTRY_RE)]],
    isDefault: [false],
  });

  constructor() {
    /**
     * The config arrives after this component is constructed on the browser
     * pass, so a form built before it would sit on an empty country the reader
     * has to fill in by hand. Seeding it once, and only while the control is
     * still untouched and empty, leaves an address being edited alone.
     */
    effect(() => {
      const fallback = this.defaultCountry();
      const control = this.form.controls['country'];
      if (fallback && control.pristine && !control.value) control.setValue(fallback);
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialAddress']) {
      const a = this.initialAddress();
      if (a) {
        this.form.reset({
          fullName: a.fullName,
          phone: a.phone,
          addressLine1: a.addressLine1,
          addressLine2: a.addressLine2 ?? '',
          city: a.city,
          state: a.state ?? '',
          postalCode: a.postalCode ?? '',
          country: a.country,
          isDefault: a.isDefaultShipping === true,
        });
      } else {
        this.form.reset({ country: this.defaultCountry(), isDefault: false });
      }
    }
    if (changes['externalError']) {
      this.formError.set(this.externalError());
    }
  }

  protected showError(key: string): boolean {
    const ctrl = this.form.get(key);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  /**
   * Mark the controls a Zod issue points at as invalid and touched, so a
   * divergence between the Reactive validators and the shared schema surfaces
   * on the field rather than as a silent no-op.
   */
  private applySchemaIssues(issues: ReadonlyArray<{ path: PropertyKey[] }>): void {
    let matched = false;
    for (const issue of issues) {
      const name = issue.path[0];
      const ctrl = typeof name === 'string' ? this.form.get(name) : null;
      if (!ctrl) continue;
      matched = true;
      ctrl.setErrors({ ...(ctrl.errors ?? {}), schema: true });
      ctrl.markAsTouched();
    }
    // Nothing to pin it on: fall back to the generic banner rather than
    // failing silently, which is what this whole branch is here to prevent.
    if (!matched) {
      this.formError.set(this.strings().account.addresses.errors.generic);
    }
  }

  protected onSubmit(): void {
    if (this.saving()) return;
    // Finding A4: `formError` was cleared only on the success path, so a
    // banner from a previous attempt sat next to the field errors of this one
    // and read as two unrelated failures.
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const raw = this.form.getRawValue() as Record<string, unknown>;
    const trimmed = {
      fullName: String(raw['fullName']).trim(),
      phone: String(raw['phone']).trim(),
      addressLine1: String(raw['addressLine1']).trim(),
      city: String(raw['city']).trim(),
      country: String(raw['country']).trim().toUpperCase(),
      ...(String(raw['addressLine2'] ?? '').trim()
        ? { addressLine2: String(raw['addressLine2']).trim() }
        : {}),
      ...(String(raw['state'] ?? '').trim() ? { state: String(raw['state']).trim() } : {}),
      ...(String(raw['postalCode'] ?? '').trim()
        ? { postalCode: String(raw['postalCode']).trim() }
        : {}),
    };
    const parsed = createAddressRequestSchema.safeParse(trimmed);
    if (!parsed.success) {
      // Finding A4: this used to set the generic "could not save right now"
      // banner and return without emitting, so the customer read a server
      // failure for a request that never left the browser. Push the schema's
      // verdict onto the fields it belongs to instead; the banner is only for
      // outcomes that really did come from the server.
      this.applySchemaIssues(parsed.error.issues);
      return;
    }
    this.submit.emit({ payload: parsed.data, isDefault: raw['isDefault'] === true });
  }
}

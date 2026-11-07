import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  EventEmitter,
  inject,
  input,
  OnInit,
  Output,
  signal,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import { UsersService } from '@storefront-services';
import { createAddressRequestSchema, type Address } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { StoreConfigService } from '../../services/store-config.service';
import { countryName } from '../../../i18n';
import { ButtonComponent } from '../../ui/button.component';
import { PHONE_RE } from '../../../lib/phone';

type Mode = 'pick' | 'add';

const COUNTRY_RE = /^[A-Z]{2}$/;

let nextHintId = 0;

/**
 * S10 address-picker section. Two modes:
 *  - `pick`: list of saved addresses as a radiogroup (when input list is non-empty).
 *  - `add`: reactive form posting `POST /v1/users/me/addresses`.
 *
 * Emits `addressSelected` on every confirmed selection (auto-fires for the
 * default address, then fires again when the customer changes selection or
 * when the new address persists). Always emits the canonical `Address` object.
 */
@Component({
  selector: 'app-address-picker',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="picker" [attr.data-mode]="mode()">
      @if (mode() === 'pick') {
        <fieldset class="list">
          <legend class="visually-hidden">{{ strings().checkout.steps.address.summary }}</legend>
          @for (a of addresses(); track a.id) {
            <label class="row" [class.selected]="selectedId() === a.id">
              <input
                type="radio"
                name="checkout-address"
                [value]="a.id"
                [checked]="selectedId() === a.id"
                (change)="select(a)"
                [attr.aria-label]="radioLabel(a)"
                [attr.data-testid]="'address-radio-' + a.id"
              />
              <span class="row-body">
                <span class="row-name">
                  {{ a.fullName }}
                  @if (a.isDefaultShipping) {
                    <span class="badge">{{ strings().checkout.steps.address.defaultBadge }}</span>
                  }
                </span>
                <span class="row-line">{{ formatLine(a) }}</span>
                <span class="row-line"
                  ><bdi dir="ltr">{{ a.phone }}</bdi></span
                >
              </span>
            </label>
          }
        </fieldset>
        <button type="button" class="link" (click)="setMode('add')" data-testid="address-add-new">
          + {{ strings().checkout.steps.address.addNew }}
        </button>
      } @else {
        <form
          class="form"
          [formGroup]="form"
          (ngSubmit)="onSubmit()"
          (input)="formError.set(null)"
          (change)="formError.set(null)"
          novalidate
          data-testid="address-form"
        >
          <div class="grid">
            <label class="field">
              <span class="label">{{ strings().checkout.steps.address.fields.fullName }}</span>
              <input
                [id]="fieldId('fullName')"
                data-testid="address-field-fullName"
                formControlName="fullName"
                type="text"
                autocomplete="name"
                required
                [attr.aria-describedby]="showError('fullName') ? errorId('fullName') : null"
                [attr.aria-invalid]="showError('fullName') ? 'true' : null"
              />
              <span [id]="errorId('fullName')" class="error" aria-live="polite">
                @if (showError('fullName')) {
                  {{ strings().checkout.errors.requiredField }}
                }
              </span>
            </label>
            <label class="field">
              <span class="label">{{ strings().checkout.steps.address.fields.phone }}</span>
              <input
                [id]="fieldId('phone')"
                data-testid="address-field-phone"
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
                  {{ strings().checkout.errors.invalidPhone }}
                }
              </span>
            </label>
            <label class="field span-2">
              <span class="label">{{ strings().checkout.steps.address.fields.addressLine1 }}</span>
              <input
                [id]="fieldId('addressLine1')"
                data-testid="address-field-addressLine1"
                formControlName="addressLine1"
                type="text"
                autocomplete="address-line1"
                required
                [attr.aria-describedby]="showError('addressLine1') ? errorId('addressLine1') : null"
                [attr.aria-invalid]="showError('addressLine1') ? 'true' : null"
              />
              <span [id]="errorId('addressLine1')" class="error" aria-live="polite">
                @if (showError('addressLine1')) {
                  {{ strings().checkout.errors.requiredField }}
                }
              </span>
            </label>
            <label class="field span-2">
              <span class="label">{{ strings().checkout.steps.address.fields.addressLine2 }}</span>
              <input
                [id]="fieldId('addressLine2')"
                data-testid="address-field-addressLine2"
                formControlName="addressLine2"
                type="text"
                autocomplete="address-line2"
              />
            </label>
            <label class="field">
              <span class="label">{{ strings().checkout.steps.address.fields.city }}</span>
              <input
                [id]="fieldId('city')"
                data-testid="address-field-city"
                formControlName="city"
                type="text"
                autocomplete="address-level2"
                required
                [attr.aria-describedby]="showError('city') ? errorId('city') : null"
                [attr.aria-invalid]="showError('city') ? 'true' : null"
              />
              <span [id]="errorId('city')" class="error" aria-live="polite">
                @if (showError('city')) {
                  {{ strings().checkout.errors.requiredField }}
                }
              </span>
            </label>
            <label class="field">
              <span class="label">{{ strings().checkout.steps.address.fields.state }}</span>
              <input
                [id]="fieldId('state')"
                data-testid="address-field-state"
                formControlName="state"
                type="text"
                autocomplete="address-level1"
              />
            </label>
            <label class="field">
              <span class="label">{{ strings().checkout.steps.address.fields.postalCode }}</span>
              <input
                [id]="fieldId('postalCode')"
                data-testid="address-field-postalCode"
                formControlName="postalCode"
                type="text"
                autocomplete="postal-code"
                inputmode="text"
                dir="auto"
              />
            </label>
            <label class="field">
              <span class="label">{{ strings().checkout.steps.address.fields.country }}</span>
              <!-- The markets this store ships to, from identity.areaServed in
                   the runtime config (DR-31, plan E2.5). It was a free-text
                   two-letter code defaulting to one client's market, so a
                   customer had to know an ISO code and the default was wrong
                   for every other install. -->
              <select
                [id]="fieldId('country')"
                data-testid="address-field-country"
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
              @if (countryOptions().length && strings().checkout.steps.address.fields.countryHint) {
                <span [id]="countryHintId" class="helper">
                  {{ strings().checkout.steps.address.fields.countryHint }}
                </span>
              }
              <span [id]="errorId('country')" class="error" aria-live="polite">
                @if (showError('country')) {
                  {{ strings().checkout.errors.invalidCountry }}
                }
              </span>
            </label>
          </div>
          @if (formError()) {
            <p class="form-error" role="alert" data-testid="address-form-error">
              {{ formError() }}
            </p>
          }
          <div class="actions">
            <app-button
              type="submit"
              variant="primary"
              [loading]="saving()"
              testId="address-form-submit"
            >
              {{
                saving()
                  ? strings().checkout.steps.address.fields.saving
                  : strings().checkout.steps.address.fields.save
              }}
            </app-button>
            @if (addresses().length > 0) {
              <button
                type="button"
                class="link"
                (click)="setMode('pick')"
                data-testid="address-form-cancel"
              >
                {{ strings().checkout.steps.address.fields.cancel }}
              </button>
            }
          </div>
        </form>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .visually-hidden {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .list {
        border: 0;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .row {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        padding-block: 0.75rem;
        padding-inline: 0.75rem;
        border: 1px solid var(--brand-border);
        cursor: pointer;
      }
      .row.selected {
        border-color: var(--brand-primary);
      }
      .row:focus-within {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .row-body {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
      }
      .row-name {
        font-weight: 600;
        color: var(--brand-text);
      }
      .row-line {
        color: var(--brand-text-muted);
        font-size: var(--brand-text-body);
      }
      .badge {
        margin-inline-start: 0.5rem;
        font-size: var(--brand-text-micro);
        padding-inline: 0.5rem;
        padding-block: 0.125rem;
        color: var(--brand-primary);
        border: 1px solid currentColor;
      }
      .link {
        background: transparent;
        border: 0;
        margin-block-start: 0.75rem;
        padding-inline: 0;
        color: var(--brand-primary);
        cursor: pointer;
        font-size: var(--brand-text-body);
      }
      .link:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
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
      }
      .form-error {
        color: var(--brand-error);
        font-size: var(--brand-text-body);
        margin: 0;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 1rem;
      }
    `,
  ],
})
export class AddressPickerComponent implements OnInit {
  readonly addresses = input.required<Address[]>();
  /**
   * Guest checkout: there is no account to save an address on, and
   * `POST /v1/users/me/addresses` is `@OwnerGuard()`, so calling it
   * anonymously is a guaranteed 401. In this mode the confirmed form value is
   * emitted straight to the page, which sends it inline on the order
   * (`CreateOrderDto.shippingAddress`) instead of an id.
   */
  readonly guest = input<boolean>(false);

  @Output() readonly addressSelected = new EventEmitter<Address>();
  @Output() readonly addressSaved = new EventEmitter<Address>();

  private readonly users = inject(UsersService);
  private readonly fb = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  private readonly storeConfig = inject(StoreConfigService);

  /**
   * The markets this store ships to, named in the reader's language, matching
   * `address-form.component.ts` so the two address surfaces cannot disagree.
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
  private readonly host = inject(ElementRef) as ElementRef<HTMLElement>;
  protected readonly strings = this.locale.strings;

  protected readonly mode = signal<Mode>('pick');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  private readonly instanceId = nextHintId++;
  protected readonly countryHintId = `address-country-hint-${this.instanceId}`;
  protected fieldId(name: string): string {
    return `address-${name}-${this.instanceId}`;
  }
  protected errorId(name: string): string {
    return `address-${name}-error-${this.instanceId}`;
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
  });

  protected readonly hasAddresses = computed(() => this.addresses().length > 0);

  ngOnInit(): void {
    const list = this.addresses();
    if (list.length === 0) {
      this.mode.set('add');
      return;
    }
    const def = list.find((a) => a.isDefaultShipping) ?? list[0];
    this.selectedId.set(def.id);
    this.addressSelected.emit(def);
  }

  protected setMode(next: Mode): void {
    this.mode.set(next);
    if (next === 'add') this.formError.set(null);
  }

  protected select(a: Address): void {
    this.selectedId.set(a.id);
    this.addressSelected.emit(a);
  }

  protected showError(key: string): boolean {
    const ctrl = this.form.get(key);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  /**
   * The radio's own accessible name (finding K5). Without it the control
   * inherits whatever the wrapping label's whole text run collapses to, badge
   * and phone number included, so two addresses could announce the same way.
   * Recipient first, then where: a comma separates two facts.
   */
  protected radioLabel(a: Address): string {
    return [a.fullName, this.formatLine(a)].filter(Boolean).join(', ');
  }

  protected formatLine(a: Address): string {
    const parts = [
      a.addressLine1,
      a.addressLine2 ?? null,
      a.city,
      a.state ?? null,
      a.postalCode ?? null,
      a.country,
    ].filter((p): p is string => !!p && p.length > 0);
    return parts.join(', ');
  }

  protected async onSubmit(): Promise<void> {
    if (this.saving()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      // Move keyboard focus to the first invalid field so screen-reader users
      // hear the error context immediately. Without this, focus stays on the
      // submit button and AT only announces the generic alert.
      queueMicrotask(() => {
        const invalid = this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]');
        invalid?.focus();
      });
      return;
    }
    const raw = this.form.getRawValue();
    const trimmedRaw = {
      fullName: raw.fullName.trim(),
      phone: raw.phone.trim(),
      addressLine1: raw.addressLine1.trim(),
      city: raw.city.trim(),
      country: raw.country.trim().toUpperCase(),
      ...(raw.addressLine2?.trim() ? { addressLine2: raw.addressLine2.trim() } : {}),
      ...(raw.state?.trim() ? { state: raw.state.trim() } : {}),
      ...(raw.postalCode?.trim() ? { postalCode: raw.postalCode.trim() } : {}),
    };
    const parsed = createAddressRequestSchema.safeParse(trimmedRaw);
    if (!parsed.success) {
      this.formError.set(this.strings().checkout.errors.generic);
      return;
    }
    if (this.guest()) {
      // The empty id is the page's signal that this address exists nowhere but
      // in the order payload, so `shippingAddressId` must not be sent for it.
      // Mode stays `add`: a guest has no saved list to return to, and resetting
      // the form would discard what they just typed.
      this.addressSelected.emit({ id: '', ...parsed.data } as Address);
      return;
    }
    this.saving.set(true);
    this.formError.set(null);
    try {
      const saved = await this.users.createAddress(parsed.data);
      this.addressSaved.emit(saved);
      this.selectedId.set(saved.id);
      this.addressSelected.emit(saved);
      this.setMode('pick');
      this.form.reset({ country: this.defaultCountry() });
    } catch {
      this.formError.set(this.strings().checkout.errors.generic);
    } finally {
      this.saving.set(false);
    }
  }
}

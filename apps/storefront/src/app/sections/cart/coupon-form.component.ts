import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  ReactiveFormsModule,
  Validators,
  type FormGroup,
} from '@angular/forms';

import type { Decimal } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { ButtonComponent } from '../../ui/button.component';
import { formatMoney } from '../../../lib/money';
import { StoreConfigService } from '../../services/store-config.service';

export interface AppliedCoupon {
  code: string;
  discount: Decimal;
}

export interface CouponFormGroup {
  code: FormControl<string>;
}

@Component({
  selector: 'cart-coupon-form',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="coupon" data-testid="cart-coupon">
      <h2 class="heading">{{ strings().cart.page.couponHeading }}</h2>

      @if (applied()) {
        <div class="applied" data-testid="cart-coupon-applied">
          <p class="applied-text">
            {{ appliedLabel() }}
          </p>
          <p class="applied-savings" aria-live="polite">
            <span>-{{ formatted(Number(applied()!.discount)) }}</span>
          </p>
          <app-button
            variant="tertiary"
            size="sm"
            testId="cart-coupon-remove"
            [disabled]="pending()"
            (clicked)="remove.emit()"
          >
            {{ strings().cart.page.couponRemove }}
          </app-button>
        </div>
      } @else {
        <form
          [formGroup]="form"
          class="form"
          (ngSubmit)="onSubmit()"
          data-testid="cart-coupon-form"
        >
          <div class="field">
            <label [for]="inputId" class="sr-only">{{ strings().cart.page.couponHeading }}</label>
            <input
              [id]="inputId"
              type="text"
              class="input"
              autocomplete="off"
              spellcheck="false"
              maxlength="50"
              [placeholder]="strings().cart.page.couponPlaceholder"
              formControlName="code"
              [attr.aria-invalid]="error() ? 'true' : null"
              [attr.aria-describedby]="describedBy()"
              data-testid="cart-coupon-input"
              (input)="edited.emit()"
            />
            <app-button
              type="submit"
              variant="secondary"
              size="md"
              [disabled]="form.invalid || form.pristine || pending()"
              testId="cart-coupon-submit"
            >
              {{ strings().cart.page.couponApply }}
            </app-button>
          </div>
          <p [id]="hintId" class="hint">{{ strings().cart.page.couponFormatHint }}</p>
          @if (error()) {
            <p [id]="errorId" class="error" role="alert" data-testid="cart-coupon-error">
              {{ error() }}
            </p>
          }
        </form>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .coupon {
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        padding-block: 1rem;
        padding-inline: 1rem;
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
      }
      .heading {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .field {
        display: flex;
        gap: 0.5rem;
        align-items: stretch;
      }
      .input {
        flex: 1;
        font: inherit;
        min-block-size: 44px;
        padding-block: 0.5rem;
        padding-inline: 0.75rem;
        /* agent_docs/storefront/brand-tokens.md: a control resting boundary is load-bearing. */
        border: 1px solid var(--brand-border-interactive);
        border-radius: var(--brand-radius-md);
        background-color: var(--brand-surface);
        color: var(--brand-text);
      }
      .input:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 1px;
        border-color: var(--brand-primary);
      }
      .applied {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.5rem 0.75rem;
        align-items: center;
      }
      .applied-text {
        margin: 0;
        font-size: var(--brand-text-body);
        color: var(--brand-text);
      }
      /* Audit row 7: the success colour means in stock, shipped, or paid.
         A coupon discount and a gift-card balance applied to an unpaid cart
         are neither, so the amount carries no state colour. Weight alone
         distinguishes it, the same as the cart and checkout totals. */
      .applied-savings {
        margin: 0;
        font-size: var(--brand-text-body);
        font-weight: 600;
        color: var(--brand-text);
        text-align: end;
      }
      .applied app-button {
        grid-column: 1 / -1;
        justify-self: start;
      }
      .hint {
        margin: 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-text-muted);
      }
      .error {
        margin: 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-error);
      }
      .sr-only {
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
    `,
  ],
})
export class CouponFormComponent {
  private readonly localeService = inject(LocaleService, { optional: true });
  private readonly fb = inject(FormBuilder);

  readonly applied = input<AppliedCoupon | null | undefined>(null);
  readonly pending = input<boolean>(false);
  readonly error = input<string | null>(null);
  readonly currency = input<string>('');

  private readonly storeConfig = inject(StoreConfigService);
  /**
   * Explicit input first, then the configured store currency, then the baked
   * constant. Orders and gift cards carry their own code and must keep it; a
   * caller that passes nothing gets whatever the operator configured, which is
   * the whole point of finding D5.
   */
  protected readonly resolvedCurrency = computed(
    () => this.currency() || this.storeConfig.currencyCode(),
  );

  readonly apply = output<string>();
  readonly remove = output<void>();
  readonly edited = output<void>();

  protected readonly Number = Number;
  protected readonly inputId = `cart-coupon-input-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly hintId = `${this.inputId}-hint`;
  protected readonly errorId = `${this.inputId}-error`;

  protected readonly form: FormGroup<CouponFormGroup> = this.fb.nonNullable.group({
    code: this.fb.nonNullable.control('', {
      validators: [
        Validators.required,
        Validators.maxLength(50),
        Validators.pattern(/^[A-Za-z0-9_-]+$/),
      ],
    }),
  });

  protected readonly strings = computed(
    () => this.localeService?.strings() ?? ({ cart: { page: {} } } as never),
  );

  protected readonly appliedLabel = computed(() => {
    const a = this.applied();
    return a ? this.strings().cart.page.couponApplied.replace('{code}', a.code) : '';
  });

  protected readonly describedBy = computed(() => (this.error() ? this.errorId : this.hintId));

  protected onSubmit(): void {
    if (this.form.invalid || this.form.pristine || this.pending()) return;
    const value = this.form.controls.code.value.trim();
    if (!value) return;
    this.apply.emit(value);
    this.form.reset({ code: '' });
  }

  protected formatted(value: number): string {
    return formatMoney(value, this.storeConfig.money(), this.resolvedCurrency());
  }
}

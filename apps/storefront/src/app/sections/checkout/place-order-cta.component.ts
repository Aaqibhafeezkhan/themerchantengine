import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  EventEmitter,
  inject,
  input,
  Output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { LocaleService } from '../../locale.service';
import { APP_ROUTES } from '../../../lib/routes';
import { ButtonComponent } from '../../ui/button.component';

/**
 * S10 step 3: terms acknowledgement + COD legal note + the primary
 * "Place Order" CTA. Submit only fires when the form is valid AND the
 * terms checkbox is checked AND `submitting()` is false.
 */
@Component({
  selector: 'app-place-order-cta',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="form"
      [formGroup]="form"
      (ngSubmit)="onSubmit()"
      novalidate
      data-testid="place-order-form"
    >
      @if (isCashOnDelivery()) {
        <p class="cod-note" data-testid="place-order-cod-note">
          {{ strings().checkout.steps.place.codNote }}
        </p>
      }
      <label class="terms">
        <input
          type="checkbox"
          formControlName="acceptTerms"
          data-testid="place-order-accept-terms"
        />
        <span class="terms-label">
          {{ termsLabelStart() }}
          @if (termsIsExternal()) {
            <a
              class="link"
              [href]="resolvedTermsHref()"
              target="_blank"
              rel="noopener"
              data-testid="place-order-terms-link"
            >
              {{ strings().checkout.steps.place.termsLink }}
            </a>
          } @else {
            <a class="link" [routerLink]="resolvedTermsHref()" data-testid="place-order-terms-link">
              {{ strings().checkout.steps.place.termsLink }}
            </a>
          }
          {{ termsLabelMiddle() }}
          @if (privacyIsExternal()) {
            <a
              class="link"
              [href]="resolvedPrivacyHref()"
              target="_blank"
              rel="noopener"
              data-testid="place-order-privacy-link"
            >
              {{ strings().checkout.steps.place.privacyLink }}
            </a>
          } @else {
            <a
              class="link"
              [routerLink]="resolvedPrivacyHref()"
              data-testid="place-order-privacy-link"
            >
              {{ strings().checkout.steps.place.privacyLink }}
            </a>
          }
          {{ termsLabelEnd() }}
        </span>
      </label>
      @if (errorMessage()) {
        <p class="error" role="alert" data-testid="place-order-error">{{ errorMessage() }}</p>
      }
      @if (termsRequiredVisible()) {
        <p class="error" role="alert" data-testid="place-order-terms-required">
          {{ strings().checkout.errors.termsRequired }}
        </p>
      }
      <app-button type="submit" variant="primary" size="lg" [loading]="submitting()">
        {{
          submitting()
            ? strings().checkout.steps.place.submitting
            : strings().checkout.steps.place.submit
        }}
      </app-button>
      <p class="hint">{{ strings().checkout.steps.place.idempotencyTooltip }}</p>
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
      }
      .cod-note {
        margin: 0;
        color: var(--brand-text);
        font-size: var(--brand-text-body);
      }
      .terms {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        cursor: pointer;
      }
      .terms input[type='checkbox'] {
        margin-block-start: 0.25rem;
      }
      .terms-label {
        color: var(--brand-text);
        font-size: var(--brand-text-body);
      }
      .link {
        color: var(--brand-primary);
        text-decoration: underline;
      }
      .error {
        margin: 0;
        color: var(--brand-error);
        font-size: var(--brand-text-body);
      }
      .hint {
        margin: 0;
        color: var(--brand-text-muted);
        font-size: var(--brand-text-micro);
      }
    `,
  ],
})
export class PlaceOrderCtaComponent {
  readonly submitting = input<boolean>(false);
  readonly disabled = input<boolean>(false);
  readonly errorMessage = input<string | null>(null);
  /**
   * The `provider` of the tender the customer picked, from the public
   * payment-method projection. The cash-on-delivery note used to render
   * unconditionally, so a store paid by bank transfer still told every
   * customer they would hand cash to the courier (pass-2 finding D2).
   */
  readonly paymentProvider = input<string | null>(null);

  @Output() readonly placeOrder = new EventEmitter<void>();

  private readonly fb = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;

  protected readonly form: FormGroup = this.fb.nonNullable.group({
    acceptTerms: [false, Validators.requiredTrue],
  });

  private readonly termsAccepted = signal(false);
  protected readonly termsRequiredVisible = signal(false);

  constructor() {
    this.form.controls['acceptTerms'].valueChanges
      .pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((v: unknown) => this.termsAccepted.set(v === true));
  }

  protected readonly isCashOnDelivery = computed(() => this.paymentProvider() === 'cod');

  protected readonly canSubmit = computed(
    () => !this.disabled() && !this.submitting() && this.termsAccepted(),
  );

  /**
   * Consent links. Default to the storefront policy pages; the operator can
   * override the terms link with the `termsOfServiceUrl` the checkout settings
   * already expose, which may point off-site. An absolute URL cannot go
   * through `routerLink`, which would read it as an in-app path, so the
   * template picks the anchor form from `termsIsExternal`.
   */
  readonly termsHref = input<string | null>(null);
  readonly privacyHref = input<string | null>(null);

  protected readonly resolvedTermsHref = computed(
    () => this.termsHref() ?? APP_ROUTES.policy(this.locale.locale(), 'terms'),
  );
  protected readonly resolvedPrivacyHref = computed(
    () => this.privacyHref() ?? APP_ROUTES.policy(this.locale.locale(), 'privacy'),
  );
  protected readonly termsIsExternal = computed(() => isExternalHref(this.resolvedTermsHref()));
  protected readonly privacyIsExternal = computed(() => isExternalHref(this.resolvedPrivacyHref()));

  // The localized terms string is shaped as "I agree to {termsLink} and {privacyLink}".
  // We split it into three static spans around the placeholders so the link tokens
  // render as their own visual elements without [innerHTML] (constitution §3.10).
  protected readonly termsLabelStart = computed(() => this.splitTerms()[0]);
  protected readonly termsLabelMiddle = computed(() => this.splitTerms()[1]);
  protected readonly termsLabelEnd = computed(() => this.splitTerms()[2]);

  private splitTerms(): [string, string, string] {
    const tpl = this.strings().checkout.steps.place.terms;
    const beforeTerms = tpl.split('{termsLink}');
    const start = beforeTerms[0] ?? '';
    const rest = beforeTerms[1] ?? '';
    const beforePrivacy = rest.split('{privacyLink}');
    const middle = beforePrivacy[0] ?? '';
    const end = beforePrivacy[1] ?? '';
    return [start, middle, end];
  }

  protected onSubmit(): void {
    if (!this.canSubmit()) {
      this.form.markAllAsTouched();
      this.termsRequiredVisible.set(!this.termsAccepted());
      return;
    }
    this.termsRequiredVisible.set(false);
    this.placeOrder.emit();
  }
}

/** An operator-configured consent URL may live off-site; a route never does. */
function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

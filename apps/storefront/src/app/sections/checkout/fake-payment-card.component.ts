import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  Injectable,
  input,
  signal,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { LocaleService } from '../../locale.service';

/** Sends the browser to the return url. Kept apart so specs can observe it. */
@Injectable({ providedIn: 'root' })
export class PaymentRedirector {
  private readonly document = inject(DOCUMENT);

  go(url: string): void {
    this.document.defaultView?.location.assign(url);
  }
}

/**
 * Card step of the `fake_embedded` test provider (issue #45). It exists so the
 * embedded flow runs end to end in the storefront journeys without a real PSP.
 * The API only hands out `publicConfig.provider = 'fake'` when
 * PAYMENT_FAKE_PROVIDERS is on, so this component is inert in production.
 */
@Component({
  selector: 'app-fake-payment-card',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label for="fake-card-number">{{ strings().checkout.paymentCardNumber }}</label>
    <input
      id="fake-card-number"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      dir="ltr"
      data-testid="fake-card-number"
      [formControl]="card"
    />
    <button
      type="button"
      class="cta primary"
      data-testid="fake-pay"
      [disabled]="busy()"
      (click)="pay()"
    >
      {{ busy() ? strings().checkout.paymentPayBusy : strings().checkout.paymentPayCta }}
    </button>
    @if (errorMessage(); as message) {
      <p role="alert" data-testid="fake-error">{{ message }}</p>
    }
  `,
})
export class FakePaymentCardComponent {
  readonly clientToken = input.required<string>();
  readonly publicConfig = input<Record<string, string>>({});
  readonly returnUrl = input.required<string>();

  protected readonly strings = inject(LocaleService).strings;
  protected readonly card = new FormControl('4242424242424242', { nonNullable: true });
  protected readonly busy = signal(false);
  protected readonly errorCode = signal<'declined' | null>(null);

  private readonly redirector = inject(PaymentRedirector);

  protected errorMessage(): string | null {
    switch (this.errorCode()) {
      case 'declined':
        return this.strings().checkout.errors.paymentCardDeclined;
      default:
        return null;
    }
  }

  protected pay(): void {
    if (this.busy()) return;
    this.errorCode.set(null);
    const number = this.card.value.replace(/\s+/g, '');
    if (number === this.publicConfig()['declineCard']) {
      this.errorCode.set('declined');
      return;
    }
    this.busy.set(true);
    this.redirector.go(this.returnUrl());
  }
}

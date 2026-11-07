import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, Type } from '@angular/core';

import type { PaymentAction } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { FakePaymentCardComponent } from './fake-payment-card.component';
import { StripePaymentElementComponent } from './stripe-payment-element.component';

/** Inputs every embedded provider component receives. */
export interface EmbeddedPaymentInputs {
  clientToken: string;
  publicConfig: Record<string, string>;
  /** Where the provider sends the shopper after a successful payment. */
  returnUrl: string;
}

/**
 * The one provider-aware spot on the storefront. A provider with an `embedded`
 * action adds one component and one line here, keyed by the provider id it
 * puts in `publicConfig.provider`. Checkout, orders and admin stay untouched.
 */
export const EMBEDDED_PAYMENT_COMPONENTS: Record<string, Type<unknown>> = {
  stripe: StripePaymentElementComponent,
  // Test double for the fake_embedded provider; the API only emits it under PAYMENT_FAKE_PROVIDERS.
  fake: FakePaymentCardComponent,
};

type EmbeddedAction = Extract<PaymentAction, { type: 'embedded' }>;

@Component({
  selector: 'app-embedded-payment-host',
  imports: [NgComponentOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (component(); as c) {
      <ng-container
        [ngComponentOutlet]="c"
        [ngComponentOutletInputs]="{
          clientToken: action().clientToken,
          publicConfig: action().publicConfig ?? {},
          returnUrl: returnUrl(),
        }"
      />
    } @else {
      <p role="alert" data-testid="embedded-payment-unsupported">
        {{ strings().checkout.errors.paymentEmbeddedUnsupported }}
      </p>
    }
  `,
})
export class EmbeddedPaymentHostComponent {
  readonly action = input.required<EmbeddedAction>();
  readonly returnUrl = input.required<string>();

  protected readonly strings = inject(LocaleService).strings;

  protected readonly component = computed(() => {
    const id = this.action().publicConfig?.['provider'];
    return id ? (EMBEDDED_PAYMENT_COMPONENTS[id] ?? null) : null;
  });
}

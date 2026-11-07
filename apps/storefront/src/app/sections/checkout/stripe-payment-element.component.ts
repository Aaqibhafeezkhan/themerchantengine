import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injectable,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { LocaleService } from '../../locale.service';
import { ButtonComponent } from '../../ui/button.component';

const STRIPE_JS_URL = 'https://js.stripe.com/v3';

interface StripeElementLike {
  mount(target: HTMLElement): void;
  on(event: 'change', handler: () => void): void;
  destroy(): void;
}

interface StripeError {
  type?: string;
  code?: string;
  message?: string;
}

/** The slice of Stripe.js this component touches. */
export interface StripeLike {
  elements(options: { clientSecret: string }): {
    create(type: 'payment'): StripeElementLike;
  };
  confirmPayment(options: {
    elements: unknown;
    confirmParams: { return_url: string };
  }): Promise<{ error?: StripeError }>;
}

type StripeFactory = (publishableKey: string) => StripeLike;

/** Loads stripe.js from Stripe's CDN once. It must never be bundled. */
@Injectable({ providedIn: 'root' })
export class StripeJsLoader {
  private readonly document = inject(DOCUMENT);
  private pending: Promise<StripeFactory> | null = null;

  async load(publishableKey: string): Promise<StripeLike> {
    this.pending ??= this.injectScript();
    return (await this.pending)(publishableKey);
  }

  private injectScript(): Promise<StripeFactory> {
    const win = this.document.defaultView as (Window & { Stripe?: StripeFactory }) | null;
    if (win?.Stripe) return Promise.resolve(win.Stripe);
    return new Promise<StripeFactory>((resolve, reject) => {
      const script = this.document.createElement('script');
      script.src = STRIPE_JS_URL;
      script.async = true;
      script.onload = () => {
        const factory = win?.Stripe;
        if (factory) resolve(factory);
        else reject(new Error('stripe.js did not define Stripe'));
      };
      script.onerror = () => {
        this.pending = null;
        reject(new Error('stripe.js failed to load'));
      };
      this.document.head.appendChild(script);
    });
  }
}

/** Stripe error codes that mean the shopper's card was refused. */
const DECLINE_CODES = new Set([
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'incorrect_cvc',
  'incorrect_number',
  'processing_error',
]);

@Component({
  selector: 'app-stripe-payment-element',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent],
  template: `
    @if (!unavailable()) {
      <div #mountPoint data-testid="stripe-payment-element"></div>
      <app-button
        type="button"
        variant="primary"
        [fullWidth]="true"
        testId="stripe-pay"
        [disabled]="!ready()"
        [loading]="busy()"
        (clicked)="pay()"
      >
        {{ busy() ? strings().checkout.paymentPayBusy : strings().checkout.paymentPayCta }}
      </app-button>
    }
    <div class="error-slot">
      @if (errorMessage(); as message) {
        <p role="alert" data-testid="stripe-error">{{ message }}</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      app-button {
        margin-block-start: 1rem;
        display: flex;
      }
      .error-slot {
        min-block-size: 1.5rem;
        margin-block-start: 0.5rem;
      }
    `,
  ],
})
export class StripePaymentElementComponent {
  readonly clientToken = input.required<string>();
  readonly publicConfig = input<Record<string, string>>({});
  readonly returnUrl = input.required<string>();

  protected readonly strings = inject(LocaleService).strings;
  protected readonly busy = signal(false);
  protected readonly ready = signal(false);
  protected readonly unavailable = signal(false);
  protected readonly errorCode = signal<'declined' | 'failed' | 'unavailable' | null>(null);

  private readonly loader = inject(StripeJsLoader);
  private readonly mountPoint = viewChild<ElementRef<HTMLElement>>('mountPoint');
  private stripe: StripeLike | null = null;
  private elements: ReturnType<StripeLike['elements']> | null = null;
  private element: StripeElementLike | null = null;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.element?.destroy();
    });
    afterNextRender(() => void this.init());
  }

  protected errorMessage(): string | null {
    const errors = this.strings().checkout.errors;
    switch (this.errorCode()) {
      case 'declined':
        return errors.paymentCardDeclined;
      case 'failed':
        return errors.paymentFailed;
      case 'unavailable':
        return errors.paymentEmbeddedUnsupported;
      default:
        return null;
    }
  }

  protected async pay(): Promise<void> {
    if (!this.stripe || !this.elements || this.busy()) return;
    this.busy.set(true);
    this.errorCode.set(null);
    try {
      const result = await this.stripe.confirmPayment({
        elements: this.elements,
        confirmParams: { return_url: this.returnUrl() },
      });
      if (result.error) {
        const code = result.error.code ?? '';
        this.errorCode.set(DECLINE_CODES.has(code) ? 'declined' : 'failed');
      }
    } catch {
      this.errorCode.set('failed');
    } finally {
      this.busy.set(false);
    }
  }

  private async init(): Promise<void> {
    const key = this.publicConfig()['publishableKey'];
    if (!key) {
      this.fail();
      return;
    }
    try {
      const stripe = await this.loader.load(key);
      const target = this.mountPoint()?.nativeElement;
      if (this.destroyed || !target) return;
      const elements = stripe.elements({ clientSecret: this.clientToken() });
      const element = elements.create('payment');
      element.mount(target);
      element.on('change', () => {
        if (this.errorCode() === 'declined' || this.errorCode() === 'failed')
          this.errorCode.set(null);
      });
      this.stripe = stripe;
      this.elements = elements;
      this.element = element;
      this.ready.set(true);
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    this.unavailable.set(true);
    this.errorCode.set('unavailable');
  }
}

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleService } from '../../locale.service';
import { renderComponent } from '../../ui/testing';
import { EMBEDDED_PAYMENT_COMPONENTS } from './embedded-payment-host.component';
import {
  StripeJsLoader,
  StripePaymentElementComponent,
  type StripeLike,
} from './stripe-payment-element.component';

function makeStripe(confirm: StripeLike['confirmPayment']) {
  const mount = vi.fn();
  const destroy = vi.fn();
  const handlers: Record<string, () => void> = {};
  const on = vi.fn((event: string, cb: () => void) => {
    handlers[event] = cb;
  });
  const create = vi.fn(() => ({ mount, destroy, on }));
  const elements = vi.fn(() => ({ create }));
  const stripe: StripeLike = { elements, confirmPayment: confirm } as unknown as StripeLike;
  return { stripe, mount, destroy, create, elements, handlers };
}

async function render(stripe: StripeLike, publishableKey: string | null = 'pk_test_1') {
  const load = vi.fn(async () => stripe);
  const fixture = await renderComponent(
    StripePaymentElementComponent,
    {
      clientToken: 'pi_1_secret_x',
      publicConfig: publishableKey
        ? { provider: 'stripe', publishableKey }
        : { provider: 'stripe' },
      returnUrl: 'https://shop.test/en/order-confirmation/ORD-1',
    },
    [LocaleService, { provide: StripeJsLoader, useValue: { load } }],
  );
  fixture.detectChanges();
  return { fixture, load };
}

const query = (fixture: { nativeElement: HTMLElement }, id: string) =>
  fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('StripePaymentElementComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('registers itself under the stripe provider id', () => {
    expect(EMBEDDED_PAYMENT_COMPONENTS['stripe']).toBe(StripePaymentElementComponent);
  });

  it('loads stripe.js with the publishable key and mounts the Payment Element', async () => {
    const fake = makeStripe(vi.fn());
    const { load } = await render(fake.stripe);
    expect(load).toHaveBeenCalledWith('pk_test_1');
    expect(fake.elements).toHaveBeenCalledWith({ clientSecret: 'pi_1_secret_x' });
    expect(fake.create).toHaveBeenCalledWith('payment');
    expect(fake.mount).toHaveBeenCalledTimes(1);
  });

  it('confirms with the return url and shows no error when Stripe redirects', async () => {
    const confirm = vi.fn(async () => ({}));
    const fake = makeStripe(confirm as never);
    const { fixture } = await render(fake.stripe);
    query(fixture, 'stripe-pay')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmParams: { return_url: 'https://shop.test/en/order-confirmation/ORD-1' },
      }),
    );
    expect(query(fixture, 'stripe-error')).toBeNull();
  });

  it('maps a declined card to the localised message, not Stripe text', async () => {
    const confirm = vi.fn(async () => ({
      error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' },
    }));
    const fake = makeStripe(confirm as never);
    const { fixture } = await render(fake.stripe);
    query(fixture, 'stripe-pay')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    const strings = TestBed.inject(LocaleService).strings();
    expect(query(fixture, 'stripe-error')?.textContent?.trim()).toBe(
      strings.checkout.errors.paymentCardDeclined,
    );
    expect(query(fixture, 'stripe-pay')?.hasAttribute('disabled')).toBe(false);
  });

  it('clears a declined-card message once the shopper edits the card', async () => {
    const confirm = vi.fn(async () => ({ error: { type: 'card_error', code: 'card_declined' } }));
    const fake = makeStripe(confirm as never);
    const { fixture } = await render(fake.stripe);
    query(fixture, 'stripe-pay')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query(fixture, 'stripe-error')).not.toBeNull();
    fake.handlers['change']();
    fixture.detectChanges();
    expect(query(fixture, 'stripe-error')).toBeNull();
  });

  it('renders the pay button through the shared button, not a bare element', async () => {
    const fake = makeStripe(vi.fn());
    const { fixture } = await render(fake.stripe);
    expect(
      fixture.nativeElement.querySelector('app-button [data-testid="stripe-pay"]'),
    ).not.toBeNull();
  });

  it('falls back to the generic payment failure for an unknown error code', async () => {
    const confirm = vi.fn(async () => ({ error: { type: 'api_error', code: 'weird' } }));
    const fake = makeStripe(confirm as never);
    const { fixture } = await render(fake.stripe);
    query(fixture, 'stripe-pay')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    const strings = TestBed.inject(LocaleService).strings();
    expect(query(fixture, 'stripe-error')?.textContent?.trim()).toBe(
      strings.checkout.errors.paymentFailed,
    );
  });

  it('shows the unavailable message when the publishable key is missing', async () => {
    const fake = makeStripe(vi.fn());
    const { fixture, load } = await render(fake.stripe, null);
    expect(load).not.toHaveBeenCalled();
    const strings = TestBed.inject(LocaleService).strings();
    expect(query(fixture, 'stripe-error')?.textContent?.trim()).toBe(
      strings.checkout.errors.paymentEmbeddedUnsupported,
    );
  });

  it('shows the unavailable message when stripe.js fails to load', async () => {
    const load = vi.fn(async () => {
      throw new Error('blocked');
    });
    const fixture = await renderComponent(
      StripePaymentElementComponent,
      {
        clientToken: 't',
        publicConfig: { provider: 'stripe', publishableKey: 'pk_test_1' },
        returnUrl: 'https://shop.test/x',
      },
      [LocaleService, { provide: StripeJsLoader, useValue: { load } }],
    );
    fixture.detectChanges();
    const strings = TestBed.inject(LocaleService).strings();
    expect(query(fixture, 'stripe-error')?.textContent?.trim()).toBe(
      strings.checkout.errors.paymentEmbeddedUnsupported,
    );
  });

  it('destroys the element when the component goes away', async () => {
    const fake = makeStripe(vi.fn());
    const { fixture } = await render(fake.stripe);
    fixture.destroy();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });
});

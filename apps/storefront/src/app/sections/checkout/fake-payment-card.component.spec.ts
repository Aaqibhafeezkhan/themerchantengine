import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleService } from '../../locale.service';
import { renderComponent } from '../../ui/testing';
import { EMBEDDED_PAYMENT_COMPONENTS } from './embedded-payment-host.component';
import { FakePaymentCardComponent, PaymentRedirector } from './fake-payment-card.component';

const RETURN_URL = 'https://shop.test/en/order-confirmation/ORD-1';
const DECLINE = '4000000000000002';

async function render() {
  const go = vi.fn();
  const fixture = await renderComponent(
    FakePaymentCardComponent,
    {
      clientToken: 'fake_secret_1',
      publicConfig: { provider: 'fake', declineCard: DECLINE },
      returnUrl: RETURN_URL,
    },
    [LocaleService, { provide: PaymentRedirector, useValue: { go } }],
  );
  fixture.detectChanges();
  return { fixture, go };
}

const query = (fixture: { nativeElement: HTMLElement }, id: string) =>
  fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function typeCard(fixture: { nativeElement: HTMLElement; detectChanges(): void }, value: string) {
  const input = query(fixture, 'fake-card-number') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('FakePaymentCardComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('registers itself under the fake provider id', () => {
    expect(EMBEDDED_PAYMENT_COMPONENTS['fake']).toBe(FakePaymentCardComponent);
  });

  it('labels the card input with the localised text', async () => {
    const { fixture } = await render();
    const strings = TestBed.inject(LocaleService).strings();
    const label = fixture.nativeElement.querySelector('label[for="fake-card-number"]');
    expect(label?.textContent?.trim()).toBe(strings.checkout.paymentCardNumber);
  });

  it('sends the shopper to the return url on a good card', async () => {
    const { fixture, go } = await render();
    query(fixture, 'fake-pay')?.click();
    fixture.detectChanges();
    expect(go).toHaveBeenCalledWith(RETURN_URL);
    expect(query(fixture, 'fake-error')).toBeNull();
  });

  it('shows the localised decline message and stays on the page for the decline card', async () => {
    const { fixture, go } = await render();
    typeCard(fixture, '4000 0000 0000 0002');
    query(fixture, 'fake-pay')?.click();
    fixture.detectChanges();
    const strings = TestBed.inject(LocaleService).strings();
    expect(go).not.toHaveBeenCalled();
    expect(query(fixture, 'fake-error')?.textContent?.trim()).toBe(
      strings.checkout.errors.paymentCardDeclined,
    );
    expect(query(fixture, 'fake-pay')?.hasAttribute('disabled')).toBe(false);
  });

  it('clears the decline when the shopper retries with another card', async () => {
    const { fixture, go } = await render();
    typeCard(fixture, DECLINE);
    query(fixture, 'fake-pay')?.click();
    fixture.detectChanges();
    typeCard(fixture, '4242424242424242');
    query(fixture, 'fake-pay')?.click();
    fixture.detectChanges();
    expect(go).toHaveBeenCalledTimes(1);
    expect(query(fixture, 'fake-error')).toBeNull();
  });
});

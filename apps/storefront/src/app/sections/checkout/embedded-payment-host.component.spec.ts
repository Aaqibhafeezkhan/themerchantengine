import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocaleService } from '../../locale.service';
import { renderComponent } from '../../ui/testing';
import {
  EMBEDDED_PAYMENT_COMPONENTS,
  EmbeddedPaymentHostComponent,
} from './embedded-payment-host.component';

@Component({
  selector: 'app-fake-embedded',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="fake-embedded">{{ clientToken() }}|{{ returnUrl() }}</div>`,
})
class FakeEmbeddedComponent {
  readonly clientToken = input('');
  readonly publicConfig = input<Record<string, string>>({});
  readonly returnUrl = input('');
}

describe('EmbeddedPaymentHostComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    TestBed.resetTestingModule();
    delete EMBEDDED_PAYMENT_COMPONENTS['fake'];
  });

  it('renders the component registered for the provider, with the token', async () => {
    EMBEDDED_PAYMENT_COMPONENTS['fake'] = FakeEmbeddedComponent;
    const fixture = await renderComponent(
      EmbeddedPaymentHostComponent,
      {
        returnUrl: 'https://shop.test/en/order-confirmation/ORD-1',
        action: { type: 'embedded', clientToken: 'tok_1', publicConfig: { provider: 'fake' } },
      },
      [LocaleService],
    );
    const el = fixture.nativeElement.querySelector('[data-testid="fake-embedded"]');
    expect(el?.textContent).toContain('tok_1');
    expect(el?.textContent).toContain('https://shop.test/en/order-confirmation/ORD-1');
    expect(
      fixture.nativeElement.querySelector('[data-testid="embedded-payment-unsupported"]'),
    ).toBeNull();
  });

  // Canary: proves the registry lookup is what decides the output.
  it('shows the unsupported message for a provider nobody registered', async () => {
    const fixture = await renderComponent(
      EmbeddedPaymentHostComponent,
      {
        returnUrl: 'https://shop.test/en/order-confirmation/ORD-1',
        action: { type: 'embedded', clientToken: 'tok_1', publicConfig: { provider: 'ghost' } },
      },
      [LocaleService],
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="embedded-payment-unsupported"]'),
    ).not.toBeNull();
  });

  it('shows the unsupported message when the action names no provider', async () => {
    const fixture = await renderComponent(
      EmbeddedPaymentHostComponent,
      {
        returnUrl: 'https://shop.test/en/order-confirmation/ORD-1',
        action: { type: 'embedded', clientToken: 'tok_1' },
      },
      [LocaleService],
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="embedded-payment-unsupported"]'),
    ).not.toBeNull();
  });
});

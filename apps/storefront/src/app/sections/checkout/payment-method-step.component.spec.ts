import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StorefrontPaymentMethod } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, attachToBody, renderComponent } from '../../ui/testing';
import { PaymentMethodStepComponent } from './payment-method-step.component';

const methods: StorefrontPaymentMethod[] = [
  {
    code: 'cod',
    name: 'Paiement à la livraison',
    description: null,
    provider: 'cod',
    sortOrder: 0,
    requiresPayment: false,
  },
  {
    code: 'bank',
    name: 'Virement bancaire',
    description: 'IBAN',
    provider: 'manual',
    sortOrder: 1,
    requiresPayment: false,
  },
];

function radiosOf(host: HTMLElement): HTMLInputElement[] {
  return [
    ...host.querySelectorAll('input[type="radio"][name="payment-method"]'),
  ] as HTMLInputElement[];
}

function providers() {
  return [provideRouter([]), LocaleService];
}

describe('PaymentMethodStepComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders one radio per enabled method with its name and description', async () => {
    const fixture = await renderComponent(
      PaymentMethodStepComponent,
      { methods, selectedCode: 'cod' },
      providers(),
    );
    expect(radiosOf(fixture.nativeElement).length).toBe(2);
    const option = fixture.nativeElement.querySelector(
      '[data-testid="payment-method-option-bank"]',
    ) as HTMLElement;
    expect(option.textContent).toContain('Virement bancaire');
    expect(option.textContent).toContain('IBAN');
  });

  it('emits the code on change and reflects the current selection', async () => {
    const fixture = await renderComponent(
      PaymentMethodStepComponent,
      { methods, selectedCode: 'cod' },
      providers(),
    );
    const picked: string[] = [];
    fixture.componentInstance.methodSelected.subscribe((code: string) => picked.push(code));
    const radios = radiosOf(fixture.nativeElement);
    expect(radios[0].checked).toBe(true);
    radios[1].click();
    fixture.detectChanges();
    expect(picked).toEqual(['bank']);
  });

  /**
   * Pass-2 finding D2: the store had zero methods configured, checkout printed
   * a hardcoded cash-on-delivery note, and the order was placed anyway. Empty
   * must read as "cannot pay", never as "pay cash".
   */
  it('says the store cannot take the order when no method is enabled', async () => {
    const fixture = await renderComponent(
      PaymentMethodStepComponent,
      { methods: [], loading: false },
      providers(),
    );
    const empty = fixture.nativeElement.querySelector('[data-testid="payment-method-empty"]');
    expect(empty).not.toBeNull();
    expect(empty.textContent).not.toMatch(/livraison|delivery/i);
    expect(radiosOf(fixture.nativeElement).length).toBe(0);
  });

  it('renders the operator checkout message above the methods when set', async () => {
    const fixture = await renderComponent(
      PaymentMethodStepComponent,
      { methods, selectedCode: 'cod', checkoutMessage: 'Paiement uniquement en dinars.' },
      providers(),
    );
    const note = fixture.nativeElement.querySelector('[data-testid="checkout-message"]');
    expect(note?.textContent?.trim()).toBe('Paiement uniquement en dinars.');
  });

  it('renders nothing for an unset checkout message', async () => {
    const fixture = await renderComponent(
      PaymentMethodStepComponent,
      { methods, selectedCode: 'cod', checkoutMessage: null },
      providers(),
    );
    expect(fixture.nativeElement.querySelector('[data-testid="checkout-message"]')).toBeNull();
  });

  it('has no serious axe violations', async () => {
    const fixture = await renderComponent(
      PaymentMethodStepComponent,
      { methods, selectedCode: 'bank' },
      providers(),
    );
    await assertAxeClean(attachToBody(fixture.nativeElement));
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import type { Address } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import { fixtureRuntimeConfig } from '../../../test-support/store-config-fixtures';

/** The markets the fixture every component spec renders under actually serves. */
const MARKETS = fixtureRuntimeConfig('maghreb-ltr').identity.areaServed;
const MARKET = MARKETS[0];
import { AddressFormComponent, type AddressFormSubmit } from './address-form.component';

const existingAddress: Address = {
  id: 'addr-9',
  fullName: 'Existing Customer',
  phone: '+97412345678',
  addressLine1: '5 Old St',
  addressLine2: null,
  city: 'Lyon',
  state: null,
  postalCode: null,
  country: 'QA',
  isDefaultShipping: true,
} as Address;

describe('AddressFormComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('starts with country prefilled to the store market when no initialAddress is supplied', async () => {
    // Load-bearing for tax, not cosmetic: the shipping-address country is the
    // argument that resolves both the shipping zone and the VAT zone, so a
    // stale default means the store quotes another market's rate to anyone who
    // does not overwrite the field. The market comes from the runtime config
    // (plan E2.5), which is what this reads it from.
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);
    const country = fixture.nativeElement.querySelector(
      `[formcontrolname="country"]`,
    ) as HTMLSelectElement;
    expect(country.value).toBe(MARKET);
  });

  it('pre-populates the form when initialAddress is supplied', async () => {
    const fixture = await renderComponent(
      AddressFormComponent,
      { initialAddress: existingAddress },
      [LocaleService],
    );
    const fullName = fixture.nativeElement.querySelector(
      `input[formcontrolname="fullName"]`,
    ) as HTMLInputElement;
    expect(fullName.value).toBe('Existing Customer');

    const isDefault = fixture.nativeElement.querySelector(
      `input[formcontrolname="isDefault"]`,
    ) as HTMLInputElement;
    expect(isDefault.checked).toBe(true);
  });

  it('blocks submission when required fields are empty and surfaces aria errors', async () => {
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);

    let emitted: AddressFormSubmit | null = null;
    fixture.componentInstance.submit.subscribe((v: AddressFormSubmit) => {
      emitted = v;
    });

    const submitBtn = fixture.nativeElement.querySelector(
      `form[data-testid-shared="account-address-form"] button[type="submit"]`,
    ) as HTMLButtonElement;
    submitBtn.click();
    fixture.detectChanges();

    expect(emitted).toBeNull();

    const phone = fixture.nativeElement.querySelector(
      `input[formcontrolname="phone"]`,
    ) as HTMLInputElement;
    expect(phone.getAttribute('aria-invalid')).toBe('true');
  });

  it('accepts a spaced international number and rejects one with too few digits', async () => {
    // The reported defect: `+218 21 000 000` was refused with "Enter a valid
    // phone number" while `+21671000000` went through, so the form rejected
    // the format the footer and the seed both print. Asserted through the
    // control rather than the regex, because the control is what the customer
    // meets. `lib/phone.spec.ts` pins the rule itself.
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);
    const phone = fixture.componentInstance['form'].controls['phone'];

    phone.setValue('+218 21 000 000');
    expect(phone.valid).toBe(true);

    phone.setValue('+21671000000');
    expect(phone.valid).toBe(true);

    phone.setValue('12345');
    expect(phone.valid).toBe(false);
  });

  it('emits submit with parsed payload + isDefault when valid', async () => {
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);

    let emitted: AddressFormSubmit | null = null;
    fixture.componentInstance.submit.subscribe((v: AddressFormSubmit) => {
      emitted = v;
    });

    fixture.componentInstance['form'].setValue({
      fullName: ' Khaleej User ',
      phone: '+97455551234',
      addressLine1: '10 Pearl Walk',
      addressLine2: '',
      city: 'Lyon',
      state: '',
      postalCode: '',
      country: 'QA',
      isDefault: true,
    });
    fixture.detectChanges();

    const submitBtn = fixture.nativeElement.querySelector(
      `form[data-testid-shared="account-address-form"] button[type="submit"]`,
    ) as HTMLButtonElement;
    submitBtn.click();

    expect(emitted).not.toBeNull();
    expect(emitted!.payload.fullName).toBe('Khaleej User');
    expect(emitted!.payload.country).toBe('QA');
    expect(emitted!.isDefault).toBe(true);
  });

  it('emits cancel when the cancel button is clicked', async () => {
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);
    let cancelled = 0;
    fixture.componentInstance.cancel.subscribe(() => cancelled++);

    (
      fixture.nativeElement.querySelector(
        `[data-testid="account-address-form-cancel"]`,
      ) as HTMLButtonElement
    ).click();

    expect(cancelled).toBe(1);
  });

  it('forwards externalError to the visible form-error region', async () => {
    const fixture = await renderComponent(
      AddressFormComponent,
      { externalError: 'API rejected the address.' },
      [LocaleService],
    );
    const region = fixture.nativeElement.querySelector(
      `[data-testid="account-address-form-error"]`,
    );
    expect(region?.textContent?.trim()).toBe('API rejected the address.');
  });

  it('axe — zero serious / critical violations', async () => {
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['region', 'landmark-one-main', 'page-has-heading-one'],
    });
  });
});

/**
 * Findings A3 and A4.
 *
 * A4 is two defects. The Reactive validators and the Zod schema disagreed, so
 * a submit that passed the former and failed the latter returned without
 * emitting: the customer saw a generic banner and no request ever left. And
 * `formError` was cleared only on the success path, so a stale banner sat next
 * to the field errors of the next invalid submit.
 *
 * A3: Country was a free-text two-letter code, then a single hardcoded option,
 * on a store that ships to a known set of markets. It reads
 * `identity.areaServed` now, so the options are the markets this install
 * actually serves (plan E2.5).
 */
describe('AddressFormComponent country and error handling (findings A3, A4)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  function field(fixture: { nativeElement: HTMLElement }, name: string): HTMLElement {
    return fixture.nativeElement.querySelector(`[formcontrolname="${name}"]`) as HTMLElement;
  }

  function fill(
    fixture: { nativeElement: HTMLElement; detectChanges(): void },
    values: Record<string, string>,
  ) {
    for (const [name, value] of Object.entries(values)) {
      const el = field(fixture, name) as HTMLInputElement;
      el.value = value;
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('blur'));
    }
    fixture.detectChanges();
  }

  function submitForm(fixture: { nativeElement: HTMLElement; detectChanges(): void }) {
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  }

  function banner(fixture: { nativeElement: HTMLElement }): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="account-address-form-error"]');
  }

  const VALID = {
    fullName: 'Ines Mejri',
    phone: '+21620123456',
    addressLine1: '12 rue de Marseille',
    city: 'Sabratha',
  };

  it('offers country as a select, not a free-text code', async () => {
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);
    const country = field(fixture, 'country');
    expect(country.tagName.toLowerCase()).toBe('select');
    const options = Array.from(country.querySelectorAll('option')).map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual([...MARKETS]);
    expect((country as HTMLSelectElement).value).toBe(MARKET);
  });

  it('emits a payload the shared schema accepts', async () => {
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);
    let emitted: AddressFormSubmit | null = null;
    fixture.componentInstance.submit.subscribe((v: AddressFormSubmit) => {
      emitted = v;
    });

    fill(fixture, VALID);
    submitForm(fixture);

    expect(emitted).not.toBeNull();
    expect(emitted!.payload.country).toBe(MARKET);
    expect(banner(fixture)).toBeNull();
  });

  it('never fails silently: an invalid submit shows field errors, not a generic banner', async () => {
    const fixture = await renderComponent(AddressFormComponent, {}, [LocaleService]);
    let emitted: AddressFormSubmit | null = null;
    fixture.componentInstance.submit.subscribe((v: AddressFormSubmit) => {
      emitted = v;
    });

    submitForm(fixture);

    expect(emitted).toBeNull();
    // The banner says "could not save right now", which is a lie when nothing
    // was ever sent. The field errors are the honest surface.
    expect(banner(fixture)).toBeNull();
    expect(field(fixture, 'fullName').getAttribute('aria-invalid')).toBe('true');
  });

  it('clears a stale banner on the next submit attempt', async () => {
    const fixture = await renderComponent(
      AddressFormComponent,
      { externalError: 'Server said no' },
      [LocaleService],
    );
    expect(banner(fixture)?.textContent).toContain('Server said no');

    submitForm(fixture);

    // The banner belonged to a previous attempt; leaving it up next to fresh
    // field errors reads as two unrelated failures.
    expect(banner(fixture)).toBeNull();
  });

  it('clears a stale banner even when the next submit succeeds', async () => {
    const fixture = await renderComponent(
      AddressFormComponent,
      { externalError: 'Server said no' },
      [LocaleService],
    );
    fill(fixture, VALID);
    submitForm(fixture);

    expect(banner(fixture)).toBeNull();
  });

  it('clears a stale banner as soon as the customer edits a field (sibling of S2-5)', async () => {
    const fixture = await renderComponent(
      AddressFormComponent,
      { externalError: 'Server said no' },
      [LocaleService],
    );
    expect(banner(fixture)?.textContent).toContain('Server said no');

    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'Sam Customer';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    expect(banner(fixture)).toBeNull();
  });
});

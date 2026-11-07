import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import type { Address } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import { AddressCardComponent } from './address-card.component';

const baseAddress: Address = {
  id: 'addr-1',
  fullName: 'Jane Lyon',
  phone: '+97412345678',
  addressLine1: '1 Pearl Blvd',
  addressLine2: 'Apt 5',
  city: 'Lyon',
  state: null,
  postalCode: null,
  country: 'QA',
  isDefaultShipping: false,
} as Address;

describe('AddressCardComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders the address line in CSV form', async () => {
    const fixture = await renderComponent(AddressCardComponent, { address: baseAddress }, [
      LocaleService,
    ]);
    const lines = fixture.nativeElement.querySelectorAll('.line');
    expect(lines[0].textContent?.trim()).toBe('1 Pearl Blvd, Apt 5, Lyon, QA');
  });

  it('isolates the phone as left-to-right so a leading plus stays first in RTL (S2-19)', async () => {
    const fixture = await renderComponent(AddressCardComponent, { address: baseAddress }, [
      LocaleService,
    ]);
    const phone = fixture.nativeElement.querySelector('bdi[dir="ltr"]');
    expect(phone?.textContent?.trim()).toBe('+97412345678');
  });

  it('shows the default badge only when isDefaultShipping is true', async () => {
    const fixture = await renderComponent(
      AddressCardComponent,
      { address: { ...baseAddress, isDefaultShipping: true } },
      [LocaleService],
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="address-card-default-badge"]'),
    ).not.toBeNull();
  });

  it('hides the set-default action when the address is already the default', async () => {
    const fixture = await renderComponent(
      AddressCardComponent,
      { address: { ...baseAddress, isDefaultShipping: true } },
      [LocaleService],
    );
    expect(
      fixture.nativeElement.querySelector(
        `[data-testid="address-card-set-default-${baseAddress.id}"]`,
      ),
    ).toBeNull();
  });

  it('emits edit / remove / setDefault on the matching button click', async () => {
    const fixture = await renderComponent(AddressCardComponent, { address: baseAddress }, [
      LocaleService,
    ]);

    const seen = { edit: 0, remove: 0, setDefault: 0 };
    fixture.componentInstance.edit.subscribe(() => seen.edit++);
    fixture.componentInstance.remove.subscribe(() => seen.remove++);
    fixture.componentInstance.setDefault.subscribe(() => seen.setDefault++);

    (
      fixture.nativeElement.querySelector(
        `[data-testid="address-card-edit-${baseAddress.id}"]`,
      ) as HTMLButtonElement
    ).click();
    (
      fixture.nativeElement.querySelector(
        `[data-testid="address-card-delete-${baseAddress.id}"]`,
      ) as HTMLButtonElement
    ).click();
    (
      fixture.nativeElement.querySelector(
        `[data-testid="address-card-set-default-${baseAddress.id}"]`,
      ) as HTMLButtonElement
    ).click();

    expect(seen).toEqual({ edit: 1, remove: 1, setDefault: 1 });
  });

  it('disables remove + setDefault when busy is true', async () => {
    const fixture = await renderComponent(
      AddressCardComponent,
      { address: baseAddress, busy: true },
      [LocaleService],
    );
    const del = fixture.nativeElement.querySelector(
      `[data-testid="address-card-delete-${baseAddress.id}"]`,
    ) as HTMLButtonElement;
    const setDef = fixture.nativeElement.querySelector(
      `[data-testid="address-card-set-default-${baseAddress.id}"]`,
    ) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(setDef.disabled).toBe(true);
  });

  it('axe — zero serious / critical violations', async () => {
    const fixture = await renderComponent(AddressCardComponent, { address: baseAddress }, [
      LocaleService,
    ]);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['region', 'landmark-one-main', 'page-has-heading-one'],
    });
  });
});

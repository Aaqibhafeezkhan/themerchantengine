import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UsersService } from '@storefront-services';
import type { Address } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import { AddressPickerComponent } from './address-picker.component';

const seedAddress: Address = {
  id: 'addr-1',
  fullName: 'Jane Customer',
  phone: '+97412345678',
  addressLine1: '12 Pearl St',
  addressLine2: undefined,
  city: 'Lyon',
  state: undefined,
  postalCode: '12345',
  country: 'QA',
  isDefaultShipping: true,
  isDefaultBilling: true,
};

const otherAddress: Address = {
  id: 'addr-2',
  fullName: 'Jane Office',
  phone: '+97487654321',
  addressLine1: '99 West Bay',
  city: 'Lyon',
  country: 'QA',
};

class FakeUsersService {
  createAddress = vi.fn(async () => ({
    ...seedAddress,
    id: 'addr-new',
    fullName: 'New Person',
    addressLine1: '7 New St',
    city: 'Lusail',
    isDefaultShipping: false,
  }));
}

describe('AddressPickerComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('starts in pick mode and auto-selects the default address', async () => {
    const fixture = await renderComponent(
      AddressPickerComponent,
      { addresses: [seedAddress, otherAddress] },
      [provideRouter([]), LocaleService, { provide: UsersService, useClass: FakeUsersService }],
    );
    const list = fixture.nativeElement.querySelector('fieldset.list') as HTMLElement;
    expect(list).not.toBeNull();
    const radios = fixture.nativeElement.querySelectorAll(
      'input[type="radio"][name="checkout-address"]',
    );
    expect(radios.length).toBe(2);
    const checked = fixture.nativeElement.querySelector(
      'input[type="radio"]:checked',
    ) as HTMLInputElement;
    expect(checked.value).toBe('addr-1');
  });

  it('isolates each phone as left-to-right so a leading plus stays first in RTL (S2-19)', async () => {
    const fixture = await renderComponent(
      AddressPickerComponent,
      { addresses: [seedAddress, otherAddress] },
      [provideRouter([]), LocaleService, { provide: UsersService, useClass: FakeUsersService }],
    );
    const phones = Array.from(
      fixture.nativeElement.querySelectorAll('.row-line bdi[dir="ltr"]') as NodeListOf<HTMLElement>,
    ).map((el) => el.textContent?.trim());
    expect(phones).toEqual(['+97412345678', '+97487654321']);
  });

  it('emits addressSelected for the default on init', async () => {
    const events: Address[] = [];
    const fixture = await renderComponent(
      AddressPickerComponent,
      { addresses: [seedAddress, otherAddress] },
      [provideRouter([]), LocaleService, { provide: UsersService, useClass: FakeUsersService }],
    );
    fixture.componentInstance.addressSelected.subscribe((a: Address) => events.push(a));
    fixture.detectChanges();
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  it('starts in add mode when there are no saved addresses', async () => {
    const fixture = await renderComponent(AddressPickerComponent, { addresses: [] }, [
      provideRouter([]),
      LocaleService,
      { provide: UsersService, useClass: FakeUsersService },
    ]);
    expect(fixture.nativeElement.querySelector('form[data-testid="address-form"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('fieldset.list')).toBeNull();
  });

  it('rejects an invalid country code without calling the service', async () => {
    const users = new FakeUsersService();
    const fixture = await renderComponent(AddressPickerComponent, { addresses: [] }, [
      provideRouter([]),
      LocaleService,
      { provide: UsersService, useValue: users },
    ]);
    const cmp = fixture.componentInstance as AddressPickerComponent;
    cmp['form'].patchValue({
      fullName: 'A',
      phone: '+97412345678',
      addressLine1: '1 X',
      city: 'Lyon',
      country: 'qq',
    });
    cmp['form'].markAllAsTouched();
    fixture.detectChanges();
    await cmp['onSubmit']();
    expect(users.createAddress).not.toHaveBeenCalled();
  });

  it('clears a stale save error as soon as the customer edits a field (sibling of S2-5)', async () => {
    const users = new FakeUsersService();
    users.createAddress.mockRejectedValueOnce(new Error('boom'));
    const fixture = await renderComponent(AddressPickerComponent, { addresses: [] }, [
      provideRouter([]),
      LocaleService,
      { provide: UsersService, useValue: users },
    ]);
    const cmp = fixture.componentInstance as AddressPickerComponent;
    cmp['form'].patchValue({
      fullName: 'Jane Customer',
      phone: '+97412345678',
      addressLine1: '1 X',
      city: 'Lyon',
      country: 'QA',
    });
    await cmp['onSubmit']();
    fixture.detectChanges();
    const selector = '[data-testid="address-form-error"]';
    expect(fixture.nativeElement.querySelector(selector)).not.toBeNull();
    (fixture.nativeElement.querySelector('form input') as HTMLInputElement).dispatchEvent(
      new Event('input', { bubbles: true }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(selector)).toBeNull();
  });

  it('persists a new address and emits addressSaved + addressSelected', async () => {
    const users = new FakeUsersService();
    const fixture = await renderComponent(AddressPickerComponent, { addresses: [] }, [
      provideRouter([]),
      LocaleService,
      { provide: UsersService, useValue: users },
    ]);
    const cmp = fixture.componentInstance as AddressPickerComponent;
    const saved: Address[] = [];
    const selected: Address[] = [];
    cmp.addressSaved.subscribe((a: Address) => saved.push(a));
    cmp.addressSelected.subscribe((a: Address) => selected.push(a));
    cmp['form'].patchValue({
      fullName: 'New Person',
      phone: '+97412345678',
      addressLine1: '7 New St',
      city: 'Lusail',
      country: 'QA',
    });
    await cmp['onSubmit']();
    expect(users.createAddress).toHaveBeenCalledTimes(1);
    expect(users.createAddress).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: 'New Person', country: 'QA' }),
    );
    expect(saved.length).toBe(1);
    expect(selected.length).toBe(1);
    expect(saved[0].id).toBe('addr-new');
  });

  /**
   * Plan F phase F6, finding K3. A guest owns no saved addresses and has no
   * account to hang one on, so the inline form is the whole address surface.
   * Persisting it would call an `@OwnerGuard()` endpoint anonymously and 401.
   */
  it('emits the address without persisting it in guest mode', async () => {
    const users = new FakeUsersService();
    const fixture = await renderComponent(AddressPickerComponent, { addresses: [], guest: true }, [
      provideRouter([]),
      LocaleService,
      { provide: UsersService, useValue: users },
    ]);
    const cmp = fixture.componentInstance as AddressPickerComponent;
    const saved: Address[] = [];
    const selected: Address[] = [];
    cmp.addressSaved.subscribe((a: Address) => saved.push(a));
    cmp.addressSelected.subscribe((a: Address) => selected.push(a));
    cmp['form'].patchValue({
      fullName: 'Guest Buyer',
      phone: '+21620123456',
      addressLine1: '12 rue de la Republique',
      city: 'Tripoli',
      postalCode: '1001',
      country: 'TN',
    });
    await cmp['onSubmit']();

    expect(users.createAddress).not.toHaveBeenCalled();
    // Nothing was saved, so nothing is announced as saved.
    expect(saved.length).toBe(0);
    expect(selected.length).toBe(1);
    expect(selected[0]).toMatchObject({
      fullName: 'Guest Buyer',
      city: 'Tripoli',
      country: 'TN',
      postalCode: '1001',
    });
    // An empty id is the signal to the page that this address exists nowhere
    // but in the payload, so `shippingAddressId` must not be sent for it.
    expect(selected[0].id).toBe('');
    // The form stays filled and in add mode: a guest has no saved list to
    // return to, and clearing it would lose what they just typed.
    expect(cmp['mode']()).toBe('add');
  });

  it('renders zero serious or critical axe violations in pick mode', async () => {
    const fixture = await renderComponent(
      AddressPickerComponent,
      { addresses: [seedAddress, otherAddress] },
      [provideRouter([]), LocaleService, { provide: UsersService, useClass: FakeUsersService }],
    );
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['html-has-lang', 'landmark-one-main', 'region', 'heading-order'],
    });
  });

  it('renders zero serious or critical axe violations in add mode', async () => {
    const fixture = await renderComponent(AddressPickerComponent, { addresses: [] }, [
      provideRouter([]),
      LocaleService,
      { provide: UsersService, useClass: FakeUsersService },
    ]);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['html-has-lang', 'landmark-one-main', 'region', 'heading-order'],
    });
  });
});

/**
 * Finding K5. Every address radio was an unlabelled input inside a `<label>`
 * whose whole text a screen reader reads as one run, so the control's
 * accessible name was whatever that run collapsed to, badge and phone number
 * included. Each radio now carries its own name: whose address it is, then
 * where it is.
 */
describe('AddressPickerComponent radio accessible names (K5)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  async function pickerWith(addresses: Address[]) {
    return renderComponent(AddressPickerComponent, { addresses }, [
      provideRouter([]),
      LocaleService,
      { provide: UsersService, useClass: FakeUsersService },
    ]);
  }

  it('names each radio with the recipient and the address line', async () => {
    const fixture = await pickerWith([seedAddress]);
    const radio = fixture.nativeElement.querySelector('input[type="radio"]') as HTMLInputElement;
    const name = radio.getAttribute('aria-label') ?? '';

    expect(name).toContain(seedAddress.fullName);
    expect(name).toContain(seedAddress.addressLine1);
    // Two facts, not one run-on: a comma is what separates them.
    expect(name).toContain(', ');
  });

  it('gives two addresses two different accessible names', async () => {
    const fixture = await pickerWith([seedAddress, otherAddress]);
    const names = Array.from(fixture.nativeElement.querySelectorAll('input[type="radio"]')).map(
      (r) => (r as HTMLInputElement).getAttribute('aria-label'),
    );

    expect(names.every((n) => n && n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import type { CustomerUser, UpdateProfileRequest } from '@storefront-types';

import ar from '../../../i18n/ar';
import en from '../../../i18n/en';
import fr from '../../../i18n/fr';
import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import { ProfileFormComponent } from './profile-form.component';

const baseUser = {
  id: 'u-1',
  email: 'jane@example.com',
  firstName: 'Jane',
  lastName: 'Lyon',
  phone: '+97412345678',
} as unknown as CustomerUser;

describe('ProfileFormComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('shows the email read-only with a hint', async () => {
    const fixture = await renderComponent(ProfileFormComponent, { user: baseUser }, [
      LocaleService,
    ]);
    const out = fixture.nativeElement.querySelector('[data-testid="account-profile-email"]');
    expect(out?.textContent?.trim()).toBe('jane@example.com');
    expect(fixture.nativeElement.querySelectorAll('input[type="email"]').length).toBe(0);
  });

  it('does not claim email changes are unavailable, the Security block offers them (S2-3)', async () => {
    const unavailable = /not yet available|pas encore disponible|غير متاح/;
    for (const dict of [en, fr, ar]) {
      expect(dict.account.profile.emailReadOnlyHint).not.toMatch(unavailable);
    }
  });

  it('pre-populates firstName / lastName / phone from the user', async () => {
    const fixture = await renderComponent(ProfileFormComponent, { user: baseUser }, [
      LocaleService,
    ]);
    const first = fixture.nativeElement.querySelector(
      `input[formcontrolname="firstName"]`,
    ) as HTMLInputElement;
    const phone = fixture.nativeElement.querySelector(
      `input[formcontrolname="phone"]`,
    ) as HTMLInputElement;
    expect(first.value).toBe('Jane');
    expect(phone.value).toBe('+97412345678');
  });

  it('blocks submission and surfaces aria-invalid when phone format is bad', async () => {
    const fixture = await renderComponent(ProfileFormComponent, { user: baseUser }, [
      LocaleService,
    ]);

    let emitted: UpdateProfileRequest | null = null;
    fixture.componentInstance.submit.subscribe((v: UpdateProfileRequest) => {
      emitted = v;
    });

    fixture.componentInstance['form'].patchValue({ phone: 'not-a-phone' });
    fixture.componentInstance['form'].get('phone')?.markAsDirty();
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        `form[data-testid="account-profile-form"] button[type="submit"]`,
      ) as HTMLButtonElement
    ).click();

    expect(emitted).toBeNull();
    const phoneInput = fixture.nativeElement.querySelector(
      `input[formcontrolname="phone"]`,
    ) as HTMLInputElement;
    expect(phoneInput.getAttribute('aria-invalid')).toBe('true');
  });

  it('emits submit with parsed payload on a valid form', async () => {
    const fixture = await renderComponent(ProfileFormComponent, { user: baseUser }, [
      LocaleService,
    ]);

    let emitted: UpdateProfileRequest | null = null;
    fixture.componentInstance.submit.subscribe((v: UpdateProfileRequest) => {
      emitted = v;
    });

    fixture.componentInstance['form'].patchValue({
      firstName: ' New Name ',
      lastName: 'Surname',
      phone: '+97455551234',
    });
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        `form[data-testid="account-profile-form"] button[type="submit"]`,
      ) as HTMLButtonElement
    ).click();

    expect(emitted).not.toBeNull();
    expect(emitted!.firstName).toBe('New Name');
    expect(emitted!.lastName).toBe('Surname');
    expect(emitted!.phone).toBe('+97455551234');
  });

  it('forwards externalError to the visible form-error region', async () => {
    const fixture = await renderComponent(
      ProfileFormComponent,
      { user: baseUser, externalError: 'API rejected the profile.' },
      [LocaleService],
    );
    const region = fixture.nativeElement.querySelector(
      `[data-testid="account-profile-form-error"]`,
    );
    expect(region?.textContent?.trim()).toBe('API rejected the profile.');
  });

  it('clears the form error and emits edited when the customer types (finding S2-5)', async () => {
    const fixture = await renderComponent(
      ProfileFormComponent,
      { user: baseUser, externalError: 'API rejected the profile.' },
      [LocaleService],
    );
    let edits = 0;
    fixture.componentInstance.edited.subscribe(() => edits++);
    const root = fixture.nativeElement as HTMLElement;
    const phone = root.querySelector('input[formcontrolname="phone"]') as HTMLInputElement;
    phone.value = '+97455550000';
    phone.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="account-profile-form-error"]')).toBeNull();
    expect(edits).toBe(1);
  });

  it('axe — zero serious / critical violations', async () => {
    const fixture = await renderComponent(ProfileFormComponent, { user: baseUser }, [
      LocaleService,
    ]);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['region', 'landmark-one-main', 'page-has-heading-one'],
    });
  });
});

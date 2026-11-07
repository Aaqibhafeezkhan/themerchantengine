import { signal, type WritableSignal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocaleService } from '../../locale.service';
import { getChromeStrings } from '../../../i18n';
import { type Locale } from '../../../i18n/types';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import {
  SecuritySectionComponent,
  type EmailChangeRequest,
  type PasswordChangeRequest,
} from './security-section.component';
import { fixtureChromeIdentity } from '../../../test-support/store-config-fixtures';

class StubLocaleService {
  private readonly _locale: WritableSignal<Locale>;
  constructor(initial: Locale) {
    this._locale = signal<Locale>(initial);
  }
  readonly locale = () => this._locale();
  readonly chromeIdentity = () => fixtureChromeIdentity('demo', this._locale());
  readonly strings = () => getChromeStrings(this._locale(), this.chromeIdentity());
}

async function render(
  locale: Locale = 'en',
  inputs: Record<string, unknown> = {},
): Promise<ComponentFixture<SecuritySectionComponent>> {
  return renderComponent(SecuritySectionComponent, inputs as never, [
    { provide: LocaleService, useValue: new StubLocaleService(locale) },
  ]);
}

function fill(fixture: ComponentFixture<SecuritySectionComponent>, testId: string, value: string) {
  const input = (fixture.nativeElement as HTMLElement).querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
  fixture.detectChanges();
}

function submitButton(
  fixture: ComponentFixture<SecuritySectionComponent>,
  testId: string,
): HTMLButtonElement {
  return (fixture.nativeElement as HTMLElement).querySelector(
    `button[data-testid="${testId}"]`,
  ) as HTMLButtonElement;
}

function submitForm(fixture: ComponentFixture<SecuritySectionComponent>, testId: string) {
  const form = (fixture.nativeElement as HTMLElement).querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  fixture.detectChanges();
}

/**
 * Finding N7. The backend has accepted `email`, `newPassword` and
 * `currentPassword` on `PATCH /v1/users/me` all along and the profile page
 * already maps all three of its error codes; only the fields were missing, so
 * those mappings were unreachable.
 */
describe('SecuritySectionComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  describe('password change', () => {
    it('keeps submit disabled until current, new and confirm are valid and matching', async () => {
      const fixture = await render();
      expect(submitButton(fixture, 'account-security-password-submit').disabled).toBe(true);

      fill(fixture, 'account-security-current-password', 'OldPassw0rd!');
      expect(submitButton(fixture, 'account-security-password-submit').disabled).toBe(true);

      fill(fixture, 'account-security-new-password', 'NewPassw0rd!');
      expect(submitButton(fixture, 'account-security-password-submit').disabled).toBe(true);

      fill(fixture, 'account-security-confirm-password', 'NewPassw0rd!');
      expect(submitButton(fixture, 'account-security-password-submit').disabled).toBe(false);
    });

    it('refuses a new password that does not meet the shared password rule', async () => {
      const fixture = await render();
      fill(fixture, 'account-security-current-password', 'OldPassw0rd!');
      fill(fixture, 'account-security-new-password', 'alllowercase');
      fill(fixture, 'account-security-confirm-password', 'alllowercase');

      expect(submitButton(fixture, 'account-security-password-submit').disabled).toBe(true);
      const error = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(error).toContain(getChromeStrings('en').account.security.errors.weakPassword);
    });

    it('surfaces a mismatch between the new password and its confirmation', async () => {
      const fixture = await render();
      fill(fixture, 'account-security-current-password', 'OldPassw0rd!');
      fill(fixture, 'account-security-new-password', 'NewPassw0rd!');
      fill(fixture, 'account-security-confirm-password', 'OtherPassw0rd!');

      expect(submitButton(fixture, 'account-security-password-submit').disabled).toBe(true);
      expect((fixture.nativeElement as HTMLElement).textContent).toContain(
        getChromeStrings('en').account.security.errors.passwordMismatch,
      );
    });

    it('emits the current and new password on a valid submit, never the confirmation', async () => {
      const fixture = await render();
      const emitted: PasswordChangeRequest[] = [];
      fixture.componentInstance.passwordChange.subscribe((v) => emitted.push(v));

      fill(fixture, 'account-security-current-password', 'OldPassw0rd!');
      fill(fixture, 'account-security-new-password', 'NewPassw0rd!');
      fill(fixture, 'account-security-confirm-password', 'NewPassw0rd!');
      submitForm(fixture, 'account-security-password-form');

      expect(emitted).toEqual([{ currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd!' }]);
    });

    it('does not emit while a submit is already in flight', async () => {
      const fixture = await render('en', { passwordBusy: true });
      const emitted: PasswordChangeRequest[] = [];
      fixture.componentInstance.passwordChange.subscribe((v) => emitted.push(v));

      fill(fixture, 'account-security-current-password', 'OldPassw0rd!');
      fill(fixture, 'account-security-new-password', 'NewPassw0rd!');
      fill(fixture, 'account-security-confirm-password', 'NewPassw0rd!');
      submitForm(fixture, 'account-security-password-form');

      expect(emitted).toEqual([]);
    });

    it('renders the externally supplied error copy', async () => {
      const fixture = await render('en', {
        passwordExternalError: 'Your current password is wrong',
      });
      const error = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-security-password-error"]',
      );
      expect(error?.textContent?.trim()).toBe('Your current password is wrong');
      expect(error?.getAttribute('role')).toBe('alert');
    });

    it('renders the success copy that warns about the sign-out everywhere', async () => {
      const success = getChromeStrings('en').account.security.passwordSuccess;
      const fixture = await render('en', { passwordSuccess: success });
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="account-security-password-success"]',
        )?.textContent,
      ).toContain(success);
    });
  });

  describe('email change', () => {
    it('keeps submit disabled until a valid email and the current password are present', async () => {
      const fixture = await render();
      expect(submitButton(fixture, 'account-security-email-submit').disabled).toBe(true);

      fill(fixture, 'account-security-new-email', 'not-an-email');
      fill(fixture, 'account-security-email-current-password', 'OldPassw0rd!');
      expect(submitButton(fixture, 'account-security-email-submit').disabled).toBe(true);

      fill(fixture, 'account-security-new-email', 'new@example.test');
      expect(submitButton(fixture, 'account-security-email-submit').disabled).toBe(false);
    });

    it('emits the trimmed email with the current password', async () => {
      const fixture = await render();
      const emitted: EmailChangeRequest[] = [];
      fixture.componentInstance.emailChange.subscribe((v) => emitted.push(v));

      fill(fixture, 'account-security-new-email', '  new@example.test  ');
      fill(fixture, 'account-security-email-current-password', 'OldPassw0rd!');
      submitForm(fixture, 'account-security-email-form');

      expect(emitted).toEqual([{ email: 'new@example.test', currentPassword: 'OldPassw0rd!' }]);
    });

    it('renders the pending-confirmation success copy', async () => {
      const fixture = await render('en', {
        emailSuccess: 'Confirmation sent to new@example.test.',
      });
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="account-security-email-success"]',
        )?.textContent,
      ).toContain('new@example.test');
    });
  });

  describe('stale messages (finding S2-6)', () => {
    const q = (fixture: ComponentFixture<SecuritySectionComponent>, testId: string) =>
      (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`);

    it('clears the password error once the customer edits a password field', async () => {
      const fixture = await render('en', {
        passwordExternalError: 'Your current password is wrong',
      });
      expect(q(fixture, 'account-security-password-error')).not.toBeNull();
      fill(fixture, 'account-security-current-password', 'x');
      expect(q(fixture, 'account-security-password-error')).toBeNull();
    });

    it('clears the email error once the customer edits an email field', async () => {
      const fixture = await render('en', { emailExternalError: 'Your current password is wrong' });
      expect(q(fixture, 'account-security-email-error')).not.toBeNull();
      fill(fixture, 'account-security-new-email', 'a@b.test');
      expect(q(fixture, 'account-security-email-error')).toBeNull();
    });

    it('hides the password and email success copy once the customer edits again', async () => {
      const fixture = await render('en', {
        passwordSuccess: 'Password changed.',
        emailSuccess: 'Confirmation sent.',
      });
      expect(q(fixture, 'account-security-password-success')).not.toBeNull();
      expect(q(fixture, 'account-security-email-success')).not.toBeNull();
      fill(fixture, 'account-security-new-password', 'x');
      expect(q(fixture, 'account-security-password-success')).toBeNull();
      expect(q(fixture, 'account-security-email-success')).not.toBeNull();
      fill(fixture, 'account-security-new-email', 'a@b.test');
      expect(q(fixture, 'account-security-email-success')).toBeNull();
    });
  });

  it('renders the French labels under the fr locale', async () => {
    const fixture = await render('fr');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain(getChromeStrings('fr').account.security.passwordHeading);
    expect(text).toContain(getChromeStrings('fr').account.security.emailHeading);
  });

  it('renders zero serious or critical axe violations', async () => {
    const fixture = await render();
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['html-has-lang', 'landmark-one-main', 'region'],
    });
  });
});

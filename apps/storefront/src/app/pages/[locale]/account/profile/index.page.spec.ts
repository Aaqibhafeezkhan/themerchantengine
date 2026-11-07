import { ChangeDetectionStrategy, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, UsersService } from '@storefront-services';
import type { CustomerUser } from '@storefront-types';

import { LocaleService } from '../../../../locale.service';
import { AuthStateService } from '../../../../services/auth-state.service';
import { getChromeStrings } from '../../../../../i18n';
import { type Locale } from '../../../../../i18n/types';
import ProfilePage from './index.page';
import { fixtureChromeIdentity } from '../../../../../test-support/store-config-fixtures';

class StubLocaleService {
  private readonly _locale: WritableSignal<Locale>;
  constructor(initial: Locale) {
    this._locale = signal<Locale>(initial);
  }
  readonly locale = () => this._locale();
  readonly chromeIdentity = () => fixtureChromeIdentity('demo', this._locale());
  readonly strings = () => getChromeStrings(this._locale(), this.chromeIdentity());
  // The shared account nav derives `aria-current` from the live URL.
  readonly currentUrl = () => `/${this._locale()}/account`;
}

interface DeferredBoot {
  promise: Promise<void>;
  resolve: () => void;
}

function deferredBoot(): DeferredBoot {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeAuth(authed: boolean | (() => boolean), boot?: DeferredBoot) {
  const read = typeof authed === 'function' ? authed : () => authed;
  return {
    isAuthed: read,
    // The page awaits the boot outcome before deciding (finding N4); with no
    // deferred boot passed, these stubs model a boot that has already settled.
    whenBooted: () => boot?.promise ?? Promise.resolve(),
    bootState: () => (boot ? 'pending' : 'booted'),
    currentUser: () => null,
    clearSession: vi.fn(),
  } as unknown as AuthStateService;
}

const baseUser = {
  id: 'u1',
  email: 'jane@example.com',
  firstName: 'Jane',
  lastName: 'Lyon',
  phone: '+97412345678',
} as unknown as CustomerUser;

interface RenderOpts {
  locale: Locale;
  authed: boolean | (() => boolean);
  boot?: DeferredBoot;
  user?: CustomerUser;
  getMeThrows?: unknown;
  updateMeThrows?: unknown;
}

interface RenderResult {
  fixture: ComponentFixture<ProfilePage>;
  navigateSpy: ReturnType<typeof vi.fn>;
  users: { getMe: ReturnType<typeof vi.fn>; updateMe: ReturnType<typeof vi.fn> };
  authSvc: { signOut: ReturnType<typeof vi.fn> };
}

async function renderProfile(opts: RenderOpts): Promise<RenderResult> {
  const stub = new StubLocaleService(opts.locale);
  const auth = makeAuth(opts.authed, opts.boot);
  const users = {
    getMe: vi.fn(async () => {
      if (opts.getMeThrows) throw opts.getMeThrows;
      return opts.user ?? baseUser;
    }),
    updateMe: vi.fn(async (input: Partial<CustomerUser>) => {
      if (opts.updateMeThrows) throw opts.updateMeThrows;
      return { ...(opts.user ?? baseUser), ...input } as CustomerUser;
    }),
  };

  // Better Auth sign-out. The password-change flow calls it so the signed
  // session-cache cookie dies with the revoked session.
  const authSvc = { signOut: vi.fn(async () => undefined) };

  TestBed.overrideComponent(ProfilePage, {
    set: { changeDetection: ChangeDetectionStrategy.Default },
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: LocaleService, useValue: stub },
      { provide: AuthStateService, useValue: auth },
      { provide: UsersService, useValue: users },
      { provide: AuthService, useValue: authSvc },
    ],
  });
  const router = TestBed.inject(Router);
  const navigateSpy = vi.fn(async () => true);
  router.navigateByUrl = navigateSpy as never;

  const fixture = TestBed.createComponent(ProfilePage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  // Second flush: the page now awaits the session boot outcome before it even
  // reaches its data load (finding N4), so the load settles one turn later.
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, navigateSpy, users, authSvc };
}

describe('AccountProfilePage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });

  it('renders the SSR shell + the profile form pre-populated', async () => {
    const { fixture } = await renderProfile({ locale: 'fr', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="account-profile-page"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="account-profile-form"]')).not.toBeNull();
    const first = root.querySelector(
      `input[formcontrolname="firstName"]`,
    ) as HTMLInputElement | null;
    expect(first?.value).toBe('Jane');
  });

  /**
   * Finding N4. The page used to read `isAuthed()` in `ngOnInit` while the
   * shell's single `getSession()` was still in flight, so a valid customer was
   * bounced to login. The `state` signal also started at `'idle'`, a branch the
   * template `@switch` has no case for, which is the bare-heading symptom: a
   * page that mounted but neither loaded nor redirected rendered a heading and
   * nothing else.
   */
  it('waits for the session boot and loads the form when it commits late', async () => {
    const boot = deferredBoot();
    let authed = false;
    const { fixture, navigateSpy, users } = await renderProfile({
      locale: 'fr',
      authed: () => authed,
      boot,
    });
    const root = fixture.nativeElement as HTMLElement;

    // Boot still pending: no decision taken, and no bare heading either.
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(users.getMe).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="account-profile-loading"]')).not.toBeNull();

    authed = true;
    boot.resolve();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="account-profile-form"]')).not.toBeNull();
  });

  it('redirects an anonymous visitor to /auth/login', async () => {
    const { navigateSpy } = await renderProfile({ locale: 'en', authed: false });
    expect(navigateSpy).toHaveBeenCalled();
    expect(navigateSpy.mock.calls[0][0]).toContain('/en/auth/login');
  });

  it('shows the saved message after a successful submit', async () => {
    const { fixture, users } = await renderProfile({ locale: 'en', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    const phoneInput = root.querySelector(`input[formcontrolname="phone"]`) as HTMLInputElement;
    phoneInput.value = '+97455551234';
    phoneInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const form = root.querySelector('[data-testid="account-profile-form"]') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(users.updateMe).toHaveBeenCalled();
    expect(root.querySelector('[data-testid="account-profile-status"]')).not.toBeNull();
  });

  it('hides the saved message once the customer edits a field again (finding S2-5)', async () => {
    const { fixture } = await renderProfile({ locale: 'en', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    const phoneInput = root.querySelector(`input[formcontrolname="phone"]`) as HTMLInputElement;
    phoneInput.value = '+97455551234';
    phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    const form = root.querySelector('[data-testid="account-profile-form"]') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="account-profile-status"]')).not.toBeNull();

    phoneInput.value = '+97455550000';
    phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="account-profile-status"]')).toBeNull();
  });

  it('renders the error branch when getMe throws', async () => {
    const { StorefrontServerError } = await import('@storefront-types');
    const { fixture } = await renderProfile({
      locale: 'en',
      authed: true,
      getMeThrows: new StorefrontServerError({ code: 'SERVER', message: 'boom' }),
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="account-profile-error"]'),
    ).not.toBeNull();
  });

  /**
   * Full-stack audit B1 rows #10-12 — backend now emits typed PROFILE_*
   * codes on `PATCH /v1/users/me` failures. The profile page's
   * `profileSaveErrorMessageFor` switch must map each code to its
   * dedicated EN copy. The current-password-incorrect path (401) must
   * also branch inside the `StorefrontUnauthorizedError` arm so the
   * session is NOT cleared and the customer stays on the profile form.
   */
  async function submitProfileWithError(error: unknown): Promise<RenderResult> {
    const result = await renderProfile({
      locale: 'en',
      authed: true,
      updateMeThrows: error,
    });
    const root = result.fixture.nativeElement as HTMLElement;
    const phoneInput = root.querySelector(`input[formcontrolname="phone"]`) as HTMLInputElement;
    phoneInput.value = '+97455551234';
    phoneInput.dispatchEvent(new Event('input'));
    result.fixture.detectChanges();
    const form = root.querySelector('[data-testid="account-profile-form"]') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    await result.fixture.whenStable();
    result.fixture.detectChanges();
    return result;
  }

  it('maps PROFILE_CURRENT_PASSWORD_REQUIRED to the localized EN error string', async () => {
    const { StorefrontValidationError } = await import('@storefront-types');
    const { fixture } = await submitProfileWithError(
      new StorefrontValidationError({
        code: 'PROFILE_CURRENT_PASSWORD_REQUIRED',
        message: 'Current password is required',
      }),
    );
    const err = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-profile-form-error"]',
    ) as HTMLElement | null;
    expect(err?.textContent ?? '').toContain('Enter your current password');
  });

  it('maps PROFILE_CURRENT_PASSWORD_INCORRECT to localized copy without clearing the session', async () => {
    const { StorefrontUnauthorizedError } = await import('@storefront-types');
    const { fixture, navigateSpy } = await submitProfileWithError(
      new StorefrontUnauthorizedError({
        code: 'PROFILE_CURRENT_PASSWORD_INCORRECT',
        message: 'Current password is incorrect',
      }),
    );
    const err = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-profile-form-error"]',
    ) as HTMLElement | null;
    expect(err?.textContent ?? '').toContain('current password is incorrect');
    // The auth-interceptor short-circuit must skip the logout chain so the
    // customer can correct the password without losing the form context.
    const loginNav = navigateSpy.mock.calls.find(([url]) => String(url).includes('/auth/login'));
    expect(loginNav, 'navigateByUrl must not redirect to /auth/login').toBeUndefined();
  });

  it('maps PROFILE_EMAIL_IN_USE to the localized EN error string', async () => {
    const { StorefrontConflictError } = await import('@storefront-types');
    const { fixture } = await submitProfileWithError(
      new StorefrontConflictError({
        code: 'PROFILE_EMAIL_IN_USE',
        message: 'Email already in use',
      }),
    );
    const err = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-profile-form-error"]',
    ) as HTMLElement | null;
    expect(err?.textContent ?? '').toContain('already in use');
  });
});

/**
 * Finding N7. `PATCH /v1/users/me` has accepted `email`, `newPassword` and
 * `currentPassword` all along, and this page already maps all three of its
 * error codes, but the form rendered no fields for any of it so those
 * mappings were unreachable.
 *
 * The password change revokes EVERY session including the caller's, by design.
 * The UI has to own that outcome: success copy, a deliberate `clearSession()`
 * and a navigation to login. Letting the generic 401 handler fire first would
 * read as a crash.
 */
describe('AccountProfilePage security section (finding N7)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });

  function fillSecurity(
    fixture: ComponentFixture<ProfilePage>,
    values: Record<string, string>,
  ): void {
    const root = fixture.nativeElement as HTMLElement;
    for (const [testId, value] of Object.entries(values)) {
      const input = root.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('blur'));
    }
    fixture.detectChanges();
  }

  function submit(fixture: ComponentFixture<ProfilePage>, testId: string): void {
    const form = (fixture.nativeElement as HTMLElement).querySelector(
      `[data-testid="${testId}"]`,
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  }

  it('mounts the security section on the ready state', async () => {
    const { fixture } = await renderProfile({ locale: 'fr', authed: true });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-security-section"]',
      ),
    ).not.toBeNull();
  });

  it('sends the password change, clears the session and routes to login', async () => {
    const { fixture, users, navigateSpy, authSvc } = await renderProfile({
      locale: 'en',
      authed: true,
    });
    fillSecurity(fixture, {
      'account-security-current-password': 'OldPassw0rd!',
      'account-security-new-password': 'NewPassw0rd!',
      'account-security-confirm-password': 'NewPassw0rd!',
    });
    submit(fixture, 'account-security-password-form');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(users.updateMe).toHaveBeenCalledWith({
      currentPassword: 'OldPassw0rd!',
      newPassword: 'NewPassw0rd!',
    });
    const success = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-security-password-success"]',
    );
    expect(success?.textContent).toContain(getChromeStrings('en').account.security.passwordSuccess);
    const target = navigateSpy.mock.calls.map((c) => String(c[0]));
    expect(target.some((t) => t.startsWith('/en/auth/login?from='))).toBe(true);
    // Signing out is what clears Better Auth's signed session-cache cookie.
    // Without it the revoked session still opened /account on the next full
    // page load, for as long as the cache lived.
    expect(authSvc.signOut).toHaveBeenCalledTimes(1);
  });

  it('renders a wrong current password inline without bouncing to login', async () => {
    const rejection = Object.assign(new Error('nope'), {
      code: 'PROFILE_CURRENT_PASSWORD_INCORRECT',
    });
    const { fixture, navigateSpy } = await renderProfile({
      locale: 'en',
      authed: true,
      updateMeThrows: rejection,
    });
    fillSecurity(fixture, {
      'account-security-current-password': 'WrongPassw0rd!',
      'account-security-new-password': 'NewPassw0rd!',
      'account-security-confirm-password': 'NewPassw0rd!',
    });
    submit(fixture, 'account-security-password-form');
    await fixture.whenStable();
    fixture.detectChanges();

    const error = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-security-password-error"]',
    );
    expect(error?.textContent).toContain(
      getChromeStrings('en').account.profile.errors.currentPasswordIncorrect,
    );
    expect(
      navigateSpy.mock.calls.map((c) => String(c[0])).some((t) => t.includes('/auth/login')),
    ).toBe(false);
  });

  it('shows the pending-confirmation copy on an email change and keeps the old email', async () => {
    const { fixture, users } = await renderProfile({ locale: 'en', authed: true });
    fillSecurity(fixture, {
      'account-security-new-email': 'new@example.test',
      'account-security-email-current-password': 'OldPassw0rd!',
    });
    submit(fixture, 'account-security-email-form');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(users.updateMe).toHaveBeenCalledWith({
      currentPassword: 'OldPassw0rd!',
      email: 'new@example.test',
    });
    const success = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="account-security-email-success"]',
    );
    expect(success?.textContent).toContain('new@example.test');
    // The change is pending confirmation, so the displayed address must not
    // move, whatever the response happens to echo back.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="account-profile-email"]')
        ?.textContent,
    ).toContain('jane@example.com');
  });

  it('maps PROFILE_EMAIL_IN_USE onto the email form, not the password form', async () => {
    const rejection = Object.assign(new Error('taken'), { code: 'PROFILE_EMAIL_IN_USE' });
    const { fixture } = await renderProfile({
      locale: 'en',
      authed: true,
      updateMeThrows: rejection,
    });
    fillSecurity(fixture, {
      'account-security-new-email': 'taken@example.test',
      'account-security-email-current-password': 'OldPassw0rd!',
    });
    submit(fixture, 'account-security-email-form');
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(
      root.querySelector('[data-testid="account-security-email-error"]')?.textContent,
    ).toContain(getChromeStrings('en').account.profile.errors.emailInUse);
    expect(root.querySelector('[data-testid="account-security-password-error"]')).toBeNull();
  });
});

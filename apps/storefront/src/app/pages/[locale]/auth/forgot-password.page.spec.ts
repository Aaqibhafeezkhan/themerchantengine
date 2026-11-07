import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, STOREFRONT_API_CLIENT, type ApiClient } from '@storefront-services';

import { signal } from '@angular/core';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { StoreConfigService } from '../../../services/store-config.service';
import { assertAxeClean, renderComponent } from '../../../ui/testing';
import AuthForgotPasswordPage from './forgot-password.page';
import { fixtureStoreConfigValue } from '../../../../test-support/store-config-fixtures';

const noopApi: ApiClient = {
  get: async () => ({}) as never,
  post: async () => ({}) as never,
  patch: async () => ({}) as never,
  delete: async () => ({}) as never,
  request: async () => ({}) as never,
};

type ActionResult =
  | { ok: true }
  | { ok: false; failure: { code: string | null; status: number; message: string } };

/** Fake `AuthService` exposing only `forgotPassword` — the sole method the page calls. */
function fakeAuth(forgotPassword: ReturnType<typeof vi.fn>) {
  return { provide: AuthService, useValue: { forgotPassword } as unknown as AuthService };
}

describe('AuthForgotPasswordPage', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  /** The support address comes from the store settings, not from the locale
   * catalogue, so every test states what the operator configured. */
  function fakeStoreConfig(contactEmail: string | null) {
    return {
      provide: StoreConfigService,
      // Spread rather than hand-written: a member added to the service must
      // not silently go missing from this stub.
      useValue: { ...fixtureStoreConfigValue('maghreb-ltr'), contactEmail: signal(contactEmail) },
    };
  }

  function commonProviders(
    forgotPassword: ReturnType<typeof vi.fn>,
    contactEmail: string | null = 'contact@example.test',
  ) {
    return [
      provideRouter([]),
      LocaleService,
      AuthStateService,
      { provide: STOREFRONT_API_CLIENT, useValue: noopApi },
      fakeAuth(forgotPassword),
      fakeStoreConfig(contactEmail),
    ];
  }

  /** Submit a valid address and settle the success panel. */
  async function submitAndSettle(fixture: Awaited<ReturnType<typeof renderComponent>>) {
    const email = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-email"]',
    ) as HTMLInputElement;
    email.value = 'kh@auth.test';
    email.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-form"]',
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('renders the configured support address, not a hardcoded one', async () => {
    const forgotPassword = vi.fn(async () => ({ ok: true }) as ActionResult);
    const fixture = await renderComponent(
      AuthForgotPasswordPage,
      {},
      commonProviders(forgotPassword, 'help@example.test'),
    );

    await submitAndSettle(fixture);

    const mailto = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-support-mailto"]',
    ) as HTMLAnchorElement;
    expect(mailto.getAttribute('href')).toBe('mailto:help@example.test');
    expect(mailto.textContent?.trim()).toBe('help@example.test');
  });

  it('hides the whole support line when no contact address is configured', async () => {
    // Better a success panel with no support line than one inviting the reader
    // to write to an address the operator never claimed.
    const forgotPassword = vi.fn(async () => ({ ok: true }) as ActionResult);
    const fixture = await renderComponent(
      AuthForgotPasswordPage,
      {},
      commonProviders(forgotPassword, null),
    );

    await submitAndSettle(fixture);

    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-forgot-success"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-forgot-support"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-forgot-support-mailto"]'),
    ).toBeNull();
  });

  it('submits email + redirectTo and renders the success panel', async () => {
    const forgotPassword = vi.fn(async () => ({ ok: true }) as ActionResult);
    const fixture = await renderComponent(
      AuthForgotPasswordPage,
      {},
      commonProviders(forgotPassword),
    );
    const email = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-email"]',
    ) as HTMLInputElement;
    email.value = 'kh@auth.test';
    email.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-form"]',
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-forgot-success"]'),
    ).not.toBeNull();
    const mailto = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-support-mailto"]',
    ) as HTMLAnchorElement;
    expect(mailto.getAttribute('href')).toMatch(/^mailto:/);
    expect(forgotPassword).toHaveBeenCalledTimes(1);
    // The reset link must land back on the storefront's reset-password route.
    expect(forgotPassword).toHaveBeenCalledWith(
      { email: 'kh@auth.test' },
      expect.stringContaining('/auth/reset-password'),
    );
  });

  it('keeps submit disabled until the email is valid', async () => {
    const fixture = await renderComponent(
      AuthForgotPasswordPage,
      {},
      commonProviders(vi.fn(async () => ({ ok: true }) as ActionResult)),
    );
    const submit = fixture.nativeElement.querySelector(
      'button[data-testid="auth-forgot-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('renders the localized error when the request fails', async () => {
    const forgotPassword = vi.fn(
      async () =>
        ({ ok: false, failure: { code: null, status: 429, message: 'rate' } }) as ActionResult,
    );
    const fixture = await renderComponent(
      AuthForgotPasswordPage,
      {},
      commonProviders(forgotPassword),
    );
    const email = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-email"]',
    ) as HTMLInputElement;
    email.value = 'kh@auth.test';
    email.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-form"]',
    ) as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const err = fixture.nativeElement.querySelector(
      '[data-testid="auth-forgot-error"]',
    ) as HTMLElement;
    expect(err?.textContent?.trim().length).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector('[data-testid="auth-forgot-success"]')).toBeNull();

    // sibling of S2-5: the banner describes the previous attempt, so editing clears it
    (fixture.nativeElement.querySelector('form input') as HTMLInputElement).dispatchEvent(
      new Event('input', { bubbles: true }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-forgot-error"]')).toBeNull();
  });

  it('renders zero serious or critical axe violations on the form state', async () => {
    const fixture = await renderComponent(
      AuthForgotPasswordPage,
      {},
      commonProviders(vi.fn(async () => ({ ok: true }) as ActionResult)),
    );
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['html-has-lang', 'landmark-one-main', 'region'],
    });
  });
});

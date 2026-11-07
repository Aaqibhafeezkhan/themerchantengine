import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, STOREFRONT_API_CLIENT, type ApiClient } from '@storefront-services';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { assertAxeClean, renderComponent } from '../../../ui/testing';
import AuthRegisterPage from './register.page';

type AuthFailure = { code: string | null; status: number; message: string };
type ActionResult = { ok: true } | { ok: false; failure: AuthFailure };

const noopApi: ApiClient = {
  get: async () => ({}) as never,
  post: async () => ({}) as never,
  patch: async () => ({}) as never,
  delete: async () => ({}) as never,
  request: async () => ({}) as never,
};

@Component({ standalone: true, template: '<div>account</div>' })
class FakeAccountPage {}

describe('AuthRegisterPage', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  function commonProviders(register?: ReturnType<typeof vi.fn>, authState?: AuthStateService) {
    const registerFn = register ?? vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    return {
      register: registerFn,
      providers: [
        provideRouter([
          { path: 'ar/account', component: FakeAccountPage },
          { path: '**', component: FakeAccountPage },
        ]),
        LocaleService,
        ...(authState ? [{ provide: AuthStateService, useValue: authState }] : [AuthStateService]),
        { provide: STOREFRONT_API_CLIENT, useValue: noopApi },
        { provide: AuthService, useValue: { register: registerFn } as unknown as AuthService },
      ],
    };
  }

  it('renders the form with first/last/email/password fields and a terms checkbox', async () => {
    const fixture = await renderComponent(AuthRegisterPage, {}, commonProviders().providers);
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-register-first-name"]'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-register-last-name"]'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-register-email"]'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-register-password"]'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-register-terms"]'),
    ).not.toBeNull();
  });

  it('keeps submit disabled while the terms checkbox is unchecked', async () => {
    const fixture = await renderComponent(AuthRegisterPage, {}, commonProviders().providers);
    fillRegisterValid(fixture, { acceptTerms: false });
    const submit = fixture.nativeElement.querySelector(
      'button[data-testid="auth-register-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  /**
   * Better Auth requires email verification (clarification Q2): sign-up does
   * NOT establish a session. The page swaps to a "check your inbox" panel and
   * never navigates to an authed route.
   */
  it('on success → shows the check-your-inbox panel and stays on the page', async () => {
    const { register, providers } = commonProviders();
    const fixture = await renderComponent(AuthRegisterPage, {}, providers);
    fillRegisterValid(fixture, { acceptTerms: true });
    await triggerSubmit(fixture);
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-register-success"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-register-form"]')).toBeNull();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('passes only the four account fields to register (no acceptTerms)', async () => {
    const { register, providers } = commonProviders();
    const fixture = await renderComponent(AuthRegisterPage, {}, providers);
    fillRegisterValid(fixture, { acceptTerms: true });
    await triggerSubmit(fixture);
    expect(register).toHaveBeenCalledTimes(1);
    // Exact-match arg0 — `acceptTerms` must NOT be forwarded to the API — plus
    // arg1, the locale-aware callback URL the verification link lands on.
    expect(register).toHaveBeenCalledWith(
      {
        email: expect.any(String),
        password: 'StrongPassw0rd',
        firstName: 'Aisha',
        lastName: 'Karim',
      },
      expect.any(String),
      // arg2: bot-abuse signals — no captcha required in test (no site key),
      // honeypot left empty by a real submit.
      { captchaToken: null, honeypot: '' },
    );
  });

  it('on USER_ALREADY_EXISTS → renders the localized emailExists error', async () => {
    const register = vi.fn(
      async (): Promise<ActionResult> => ({
        ok: false,
        failure: { code: 'USER_ALREADY_EXISTS', status: 422, message: 'taken' },
      }),
    );
    const fixture = await renderComponent(
      AuthRegisterPage,
      {},
      commonProviders(register).providers,
    );
    fillRegisterValid(fixture, { acceptTerms: true });
    await triggerSubmit(fixture);
    const err = fixture.nativeElement.querySelector(
      '[data-testid="auth-register-error"]',
    ) as HTMLElement;
    expect(err?.textContent?.trim().length).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector('[data-testid="auth-register-success"]')).toBeNull();

    // sibling of S2-5: the banner describes the previous attempt, so editing clears it
    (fixture.nativeElement.querySelector('form input') as HTMLInputElement).dispatchEvent(
      new Event('input', { bubbles: true }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-register-error"]')).toBeNull();
  });

  it('renders zero serious or critical axe violations', async () => {
    const fixture = await renderComponent(AuthRegisterPage, {}, commonProviders().providers);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['html-has-lang', 'landmark-one-main', 'region'],
    });
  });
  /**
   * Finding N2, sibling site. A signed-in customer has no business on the
   * register form either, and the honeypot pin (finding A8) lives here: it must
   * stay outside the accessibility tree and outside the tab order.
   */
  describe('already-authed visitor and honeypot (findings N2, A8)', () => {
    async function renderWithSpy(authed: boolean) {
      const authState = new AuthStateService();
      if (authed) {
        authState.setSession({ user: { id: 'u-1', email: 'a@b.co' } as never });
      }
      authState.markBooted();
      const navigated: string[] = [];
      TestBed.overrideComponent(AuthRegisterPage, {
        set: { changeDetection: ChangeDetectionStrategy.Default },
      });
      TestBed.configureTestingModule({
        providers: commonProviders(undefined, authState).providers as never,
      });
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'navigateByUrl').mockImplementation(async (url) => {
        navigated.push(String(url));
        return true;
      });
      const fixture = TestBed.createComponent(AuthRegisterPage);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      return { fixture, navigated };
    }

    it('forwards a signed-in visitor to the account index', async () => {
      const { navigated } = await renderWithSpy(true);
      expect(navigated).toContain('/fr/account');
    });

    it('leaves an anonymous visitor on the form', async () => {
      const { navigated, fixture } = await renderWithSpy(false);
      expect(navigated).toEqual([]);
      expect(
        fixture.nativeElement.querySelector('[data-testid="auth-register-submit"]'),
      ).not.toBeNull();
    });

    it('keeps the honeypot out of the a11y tree and out of the tab order', async () => {
      const { fixture } = await renderWithSpy(false);
      const root = fixture.nativeElement as HTMLElement;
      const input = root.querySelector('#auth-register-company') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input?.getAttribute('tabindex')).toBe('-1');
      expect(input?.closest('[aria-hidden="true"]')).not.toBeNull();
    });
  });
});

function fillRegisterValid(
  fixture: { nativeElement: HTMLElement; detectChanges(): void },
  opts: { acceptTerms: boolean },
) {
  set(fixture, 'auth-register-first-name', 'Aisha');
  set(fixture, 'auth-register-last-name', 'Karim');
  set(fixture, 'auth-register-email', `e2e-${Date.now()}@auth.test`);
  set(fixture, 'auth-register-password', 'StrongPassw0rd');
  if (opts.acceptTerms) {
    const cb = fixture.nativeElement.querySelector(
      '[data-testid="auth-register-terms"]',
    ) as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  }
  fixture.detectChanges();
}

function set(
  fixture: { nativeElement: HTMLElement; detectChanges(): void },
  testid: string,
  value: string,
) {
  const el = fixture.nativeElement.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

async function triggerSubmit(fixture: {
  nativeElement: HTMLElement;
  detectChanges(): void;
  whenStable(): Promise<unknown>;
}) {
  const form = fixture.nativeElement.querySelector(
    '[data-testid="auth-register-form"]',
  ) as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
}

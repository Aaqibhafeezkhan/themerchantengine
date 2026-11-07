import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AuthService,
  CartService,
  STOREFRONT_API_CLIENT,
  type ApiClient,
} from '@storefront-services';
import type { CustomerUser } from '@storefront-types';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { assertAxeClean, renderComponent } from '../../../ui/testing';
import AuthLoginPage from './login.page';

const SAMPLE_USER: CustomerUser = {
  id: 'cus_01',
  email: 'kh@auth.test',
  firstName: 'Aisha',
  lastName: 'Karim',
  phone: null,
  avatarUrl: null,
  locale: 'fr',
  addresses: [],
};

type AuthFailure = { code: string | null; status: number; message: string };
type SignInResult =
  | { status: 'authenticated'; user: CustomerUser }
  | { status: 'failed'; failure: AuthFailure };
type ActionResult = { ok: true } | { ok: false; failure: AuthFailure };

const noopApi: ApiClient = {
  get: async () => ({}) as never,
  post: async () => ({}) as never,
  patch: async () => ({}) as never,
  delete: async () => ({}) as never,
  request: async () => ({}) as never,
};

function makeRoute(query: Record<string, string> = {}): ActivatedRoute {
  return { snapshot: { queryParamMap: convertToParamMap(query) } } as ActivatedRoute;
}

@Component({
  standalone: true,
  template: '<div data-testid="account-route">account</div>',
})
class FakeAccountPage {}

describe('AuthLoginPage', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  function commonProviders(
    opts: {
      query?: Record<string, string>;
      login?: ReturnType<typeof vi.fn>;
      sendMagicLink?: ReturnType<typeof vi.fn>;
      authState?: AuthStateService;
    } = {},
  ) {
    const login =
      opts.login ??
      vi.fn(async (): Promise<SignInResult> => ({ status: 'authenticated', user: SAMPLE_USER }));
    const sendMagicLink =
      opts.sendMagicLink ?? vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    return {
      login,
      sendMagicLink,
      providers: [
        provideRouter([
          { path: 'ar/account', component: FakeAccountPage },
          { path: 'ar/account/orders', component: FakeAccountPage },
          { path: 'en/account', component: FakeAccountPage },
          { path: 'en/account/orders', component: FakeAccountPage },
          { path: '**', component: FakeAccountPage },
        ]),
        LocaleService,
        ...(opts.authState
          ? [{ provide: AuthStateService, useValue: opts.authState }]
          : [AuthStateService]),
        { provide: STOREFRONT_API_CLIENT, useValue: noopApi },
        { provide: AuthService, useValue: { login, sendMagicLink } as unknown as AuthService },
        { provide: ActivatedRoute, useValue: makeRoute(opts.query) },
      ],
    };
  }

  it('renders the heading + form + footer links', async () => {
    const fixture = await renderComponent(AuthLoginPage, {}, commonProviders().providers);
    expect(fixture.nativeElement.querySelector('h1.heading')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-login-form"]')).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-login-forgot-link"]'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-login-register-link"]'),
    ).not.toBeNull();
  });

  it('keeps submit disabled until valid credentials are typed', async () => {
    const fixture = await renderComponent(AuthLoginPage, {}, commonProviders().providers);
    const submit = fixture.nativeElement.querySelector(
      'button[data-testid="auth-login-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('toggles the password input type via the show/hide button', async () => {
    const fixture = await renderComponent(AuthLoginPage, {}, commonProviders().providers);
    const password = fixture.nativeElement.querySelector(
      '[data-testid="auth-login-password"]',
    ) as HTMLInputElement;
    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="auth-login-password-toggle"]',
    ) as HTMLButtonElement;
    expect(password.type).toBe('password');
    toggle.click();
    fixture.detectChanges();
    expect(password.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('on success → commits the customer to AuthState and navigates to ?from', async () => {
    const fixture = await renderComponent(
      AuthLoginPage,
      {},
      commonProviders({ query: { from: '/fr/account/orders' } }).providers,
    );
    const router = TestBed.inject(Router);
    const authState = TestBed.inject(AuthStateService);
    fillCredentials(fixture);
    await triggerSubmit(fixture);
    expect(authState.currentUser()?.id).toBe('cus_01');
    expect(authState.isAuthed()).toBe(true);
    expect(router.url).toBe('/fr/account/orders');
  });

  it('rejects ?from with a foreign locale prefix and falls back to /account', async () => {
    const fixture = await renderComponent(
      AuthLoginPage,
      {},
      commonProviders({ query: { from: '/en/account/orders' } }).providers,
    );
    const router = TestBed.inject(Router);
    fillCredentials(fixture);
    await triggerSubmit(fixture);
    expect(router.url).toBe('/fr/account');
  });

  it('falls back to /account when ?from is missing', async () => {
    const fixture = await renderComponent(AuthLoginPage, {}, commonProviders().providers);
    const router = TestBed.inject(Router);
    fillCredentials(fixture);
    await triggerSubmit(fixture);
    expect(router.url).toBe('/fr/account');
  });

  it('falls back to /account when ?from is cross-origin', async () => {
    const fixture = await renderComponent(
      AuthLoginPage,
      {},
      commonProviders({ query: { from: 'https://evil.com/steal' } }).providers,
    );
    const router = TestBed.inject(Router);
    fillCredentials(fixture);
    await triggerSubmit(fixture);
    expect(router.url).toBe('/fr/account');
  });

  it('falls back to /account when ?from is protocol-relative (//evil.com)', async () => {
    const fixture = await renderComponent(
      AuthLoginPage,
      {},
      commonProviders({ query: { from: '//evil.com/steal' } }).providers,
    );
    const router = TestBed.inject(Router);
    fillCredentials(fixture);
    await triggerSubmit(fixture);
    expect(router.url).toBe('/fr/account');
  });

  it('on a failed sign-in → renders the localized invalidCredentials error', async () => {
    const login = vi.fn(
      async (): Promise<SignInResult> => ({
        status: 'failed',
        failure: { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401, message: 'bad' },
      }),
    );
    const fixture = await renderComponent(AuthLoginPage, {}, commonProviders({ login }).providers);
    fillCredentials(fixture);
    await triggerSubmit(fixture);
    const err = fixture.nativeElement.querySelector(
      '[data-testid="auth-login-error"]',
    ) as HTMLElement;
    expect(err?.textContent?.trim().length).toBeGreaterThan(0);
    expect(TestBed.inject(AuthStateService).isAuthed()).toBe(false);

    // sibling of S2-5: the banner describes the previous attempt, so editing clears it
    (fixture.nativeElement.querySelector('form input') as HTMLInputElement).dispatchEvent(
      new Event('input', { bubbles: true }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-login-error"]')).toBeNull();
  });

  /**
   * Better Auth blocks an unverified new customer at sign-in with a distinct
   * `EMAIL_NOT_VERIFIED` code — the page must steer them to the verification
   * email, not imply the password is wrong.
   */
  it('on EMAIL_NOT_VERIFIED renders the verify-your-email message (fr default)', async () => {
    const login = vi.fn(
      async (): Promise<SignInResult> => ({
        status: 'failed',
        failure: { code: 'EMAIL_NOT_VERIFIED', status: 403, message: 'verify' },
      }),
    );
    const fixture = await renderComponent(AuthLoginPage, {}, commonProviders({ login }).providers);
    fillCredentials(fixture);
    await triggerSubmit(fixture);
    const err = fixture.nativeElement.querySelector(
      '[data-testid="auth-login-error"]',
    ) as HTMLElement;
    expect(err?.textContent ?? '').toContain('Vérifiez d’abord votre adresse e-mail');
  });

  it('magic-link → emails a one-time link and swaps to the sent panel', async () => {
    const sendMagicLink = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const fixture = await renderComponent(
      AuthLoginPage,
      {},
      commonProviders({ sendMagicLink }).providers,
    );
    const email = fixture.nativeElement.querySelector(
      '[data-testid="auth-login-email"]',
    ) as HTMLInputElement;
    email.value = 'kh@auth.test';
    email.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const magic = fixture.nativeElement.querySelector(
      '[data-testid="auth-login-magic-link"]',
    ) as HTMLButtonElement;
    magic.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(sendMagicLink).toHaveBeenCalledTimes(1);
    expect(sendMagicLink).toHaveBeenCalledWith({ email: 'kh@auth.test' }, expect.any(String));
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-login-magic-link-sent"]'),
    ).not.toBeNull();
  });

  /**
   * Anonymous-cart merge on interactive sign-in (plan F phase F2, finding K4 /
   * pass-2 A9).
   *
   * The A9 repro is exactly this path: a guest with one line opens /checkout,
   * gets bounced to login with `?from=/en/checkout`, signs in here, and the
   * SPA navigates straight on. No page reload happens, so the shell's boot
   * merge never runs and the basket is gone by the time checkout renders.
   */
  describe('anonymous cart merge on sign-in', () => {
    it('merges the guest cart after the session is committed', async () => {
      const fixture = await renderComponent(AuthLoginPage, {}, commonProviders().providers);
      const cart = TestBed.inject(CartService);
      const mergeSpy = vi.spyOn(cart, 'merge').mockResolvedValue({} as never);
      fillCredentials(fixture);
      await triggerSubmit(fixture);
      expect(mergeSpy).toHaveBeenCalledTimes(1);
    });

    it('does not merge when the sign-in failed', async () => {
      const login = vi.fn(
        async (): Promise<SignInResult> => ({
          status: 'failed',
          failure: { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401, message: 'bad' },
        }),
      );
      const fixture = await renderComponent(
        AuthLoginPage,
        {},
        commonProviders({ login }).providers,
      );
      const cart = TestBed.inject(CartService);
      const mergeSpy = vi.spyOn(cart, 'merge').mockResolvedValue({} as never);
      fillCredentials(fixture);
      await triggerSubmit(fixture);
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('still redirects when the merge fails', async () => {
      // A lost basket must not also strand the customer on the login form.
      const fixture = await renderComponent(AuthLoginPage, {}, commonProviders().providers);
      const cart = TestBed.inject(CartService);
      vi.spyOn(cart, 'merge').mockRejectedValue(new Error('merge exploded'));
      fillCredentials(fixture);
      await triggerSubmit(fixture);
      expect(TestBed.inject(AuthStateService).isAuthed()).toBe(true);
    });
  });

  it('renders zero serious or critical axe violations', async () => {
    const fixture = await renderComponent(AuthLoginPage, {}, commonProviders().providers);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['html-has-lang', 'landmark-one-main', 'region'],
    });
  });
  /**
   * Finding N2. A signed-in customer who reached the login page was stranded on
   * a credential form. The check has to wait for the boot outcome (finding N4)
   * or a full load by an authed customer never redirects.
   */
  describe('already-authed visitor (finding N2)', () => {
    function bootedAuth(authed: boolean): AuthStateService {
      const auth = new AuthStateService();
      if (authed) auth.setSession({ user: SAMPLE_USER });
      auth.markBooted();
      return auth;
    }

    /**
     * Builds the bed by hand rather than through `renderComponent` so the
     * router spy is installed BEFORE the component mounts: the redirect fires
     * one microtask after `ngOnInit`, which `renderComponent` has already
     * flushed by the time it returns.
     */
    async function renderWithSpy(opts: { authed: boolean; query?: Record<string, string> }) {
      const authState = bootedAuth(opts.authed);
      const navigated: string[] = [];
      TestBed.overrideComponent(AuthLoginPage, {
        set: { changeDetection: ChangeDetectionStrategy.Default },
      });
      TestBed.configureTestingModule({
        providers: commonProviders({ authState, query: opts.query }).providers as never,
      });
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'navigateByUrl').mockImplementation(async (url) => {
        navigated.push(String(url));
        return true;
      });

      const fixture = TestBed.createComponent(AuthLoginPage);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      return { fixture, navigated, authState };
    }

    it('forwards a signed-in visitor to the account index by default', async () => {
      const { navigated } = await renderWithSpy({ authed: true });
      expect(navigated).toContain('/fr/account');
    });

    it('forwards to the sanitised from-param when one is present', async () => {
      const { navigated } = await renderWithSpy({
        authed: true,
        query: { from: '/fr/account/orders' },
      });
      expect(navigated).toContain('/fr/account/orders');
    });

    it('rejects a cross-origin from-param and falls back to the account index', async () => {
      const { navigated } = await renderWithSpy({
        authed: true,
        query: { from: '//evil.example.com' },
      });
      expect(navigated).toContain('/fr/account');
      expect(navigated.some((t) => t.includes('evil.example.com'))).toBe(false);
    });

    it('leaves an anonymous visitor on the form', async () => {
      const { navigated, fixture } = await renderWithSpy({ authed: false });
      expect(navigated).toEqual([]);
      expect(fixture.nativeElement.querySelector('[data-testid="auth-login-form"]')).not.toBeNull();
    });

    it('does not interrupt the magic-link sent panel', async () => {
      const { navigated, fixture, authState } = await renderWithSpy({ authed: false });
      (
        fixture.componentInstance as unknown as { magicLinkSent: { set(v: boolean): void } }
      ).magicLinkSent.set(true);
      authState.setSession({ user: SAMPLE_USER });
      fixture.detectChanges();
      await fixture.whenStable();

      expect(navigated).toEqual([]);
    });
  });
});

function fillCredentials(fixture: { nativeElement: HTMLElement; detectChanges(): void }) {
  const email = fixture.nativeElement.querySelector(
    '[data-testid="auth-login-email"]',
  ) as HTMLInputElement;
  const password = fixture.nativeElement.querySelector(
    '[data-testid="auth-login-password"]',
  ) as HTMLInputElement;
  email.value = 'kh@auth.test';
  email.dispatchEvent(new Event('input'));
  password.value = 'StrongPassw0rd';
  password.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

async function triggerSubmit(fixture: {
  nativeElement: HTMLElement;
  detectChanges(): void;
  whenStable(): Promise<unknown>;
}) {
  const form = fixture.nativeElement.querySelector(
    '[data-testid="auth-login-form"]',
  ) as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  // The submit handler awaits the cart merge between committing the session
  // and navigating, so the redirect lands one macrotask later than it used to.
  // Without this hop every ?from assertion below reads an empty navigation log.
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
  await fixture.whenStable();
}

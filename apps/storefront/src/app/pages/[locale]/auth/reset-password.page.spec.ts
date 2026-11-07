import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, STOREFRONT_API_CLIENT, type ApiClient } from '@storefront-services';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { assertAxeClean, renderComponent } from '../../../ui/testing';
import AuthResetPasswordPage from './reset-password.page';

type AuthFailure = { code: string | null; status: number; message: string };
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

describe('AuthResetPasswordPage', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  function commonProviders(
    query: Record<string, string> = {},
    resetPassword?: ReturnType<typeof vi.fn>,
  ) {
    const resetFn = resetPassword ?? vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    return {
      resetPassword: resetFn,
      providers: [
        provideRouter([]),
        LocaleService,
        AuthStateService,
        { provide: STOREFRONT_API_CLIENT, useValue: noopApi },
        { provide: AuthService, useValue: { resetPassword: resetFn } as unknown as AuthService },
        { provide: ActivatedRoute, useValue: makeRoute(query) },
      ],
    };
  }

  it('renders the token-missing panel when ?token= is absent', async () => {
    const fixture = await renderComponent(AuthResetPasswordPage, {}, commonProviders().providers);
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-reset-token-missing"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-reset-form"]')).toBeNull();
  });

  it('renders the form when a token is present', async () => {
    const fixture = await renderComponent(
      AuthResetPasswordPage,
      {},
      commonProviders({ token: 'abc' }).providers,
    );
    expect(fixture.nativeElement.querySelector('[data-testid="auth-reset-form"]')).not.toBeNull();
  });

  it('shows the password-mismatch error when the two passwords differ', async () => {
    const fixture = await renderComponent(
      AuthResetPasswordPage,
      {},
      commonProviders({ token: 'abc' }).providers,
    );
    set(fixture, 'auth-reset-password', 'StrongPassw0rd');
    set(fixture, 'auth-reset-confirm', 'OtherPassw0rd');
    const confirm = fixture.nativeElement.querySelector(
      '[data-testid="auth-reset-confirm"]',
    ) as HTMLInputElement;
    confirm.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-reset-mismatch"]'),
    ).not.toBeNull();
  });

  it('on submit success → swaps to the success panel', async () => {
    const { resetPassword, providers } = commonProviders({ token: 'abc' });
    const fixture = await renderComponent(AuthResetPasswordPage, {}, providers);
    set(fixture, 'auth-reset-password', 'StrongPassw0rd');
    set(fixture, 'auth-reset-confirm', 'StrongPassw0rd');
    await triggerSubmit(fixture);
    expect(
      fixture.nativeElement.querySelector('[data-testid="auth-reset-success"]'),
    ).not.toBeNull();
    expect(resetPassword).toHaveBeenCalledWith({ token: 'abc', password: 'StrongPassw0rd' });
  });

  it('on an invalid token → renders the localized error', async () => {
    const resetPassword = vi.fn(
      async (): Promise<ActionResult> => ({
        ok: false,
        failure: { code: 'INVALID_TOKEN', status: 400, message: 'bad' },
      }),
    );
    const fixture = await renderComponent(
      AuthResetPasswordPage,
      {},
      commonProviders({ token: 'abc' }, resetPassword).providers,
    );
    set(fixture, 'auth-reset-password', 'StrongPassw0rd');
    set(fixture, 'auth-reset-confirm', 'StrongPassw0rd');
    await triggerSubmit(fixture);
    const err = fixture.nativeElement.querySelector(
      '[data-testid="auth-reset-error"]',
    ) as HTMLElement;
    expect(err?.textContent?.trim().length).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector('[data-testid="auth-reset-success"]')).toBeNull();

    // sibling of S2-5: the banner describes the previous attempt, so editing clears it
    (fixture.nativeElement.querySelector('form input') as HTMLInputElement).dispatchEvent(
      new Event('input', { bubbles: true }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="auth-reset-error"]')).toBeNull();
  });

  it('renders zero serious or critical axe violations', async () => {
    const fixture = await renderComponent(
      AuthResetPasswordPage,
      {},
      commonProviders({ token: 'abc' }).providers,
    );
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['html-has-lang', 'landmark-one-main', 'region'],
    });
  });
});

function set(
  fixture: { nativeElement: HTMLElement; detectChanges(): void },
  testid: string,
  value: string,
) {
  const el = fixture.nativeElement.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

async function triggerSubmit(fixture: {
  nativeElement: HTMLElement;
  detectChanges(): void;
  whenStable(): Promise<unknown>;
}) {
  const form = fixture.nativeElement.querySelector(
    '[data-testid="auth-reset-form"]',
  ) as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
}

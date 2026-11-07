import { ChangeDetectionStrategy, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationPreferencesService } from '@storefront-services';
import type { NotificationPreferences } from '@storefront-types';

import { LocaleService } from '../../../../locale.service';
import { AuthStateService } from '../../../../services/auth-state.service';
import { getChromeStrings } from '../../../../../i18n';
import { type Locale } from '../../../../../i18n/types';
import PreferencesPage from './index.page';
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

function makeAuth(authed: boolean) {
  return {
    isAuthed: () => authed,
    // The page awaits the boot outcome before deciding (finding N4); these
    // stubs model a boot that has already settled.
    whenBooted: async () => undefined,
    bootState: () => 'booted',
    currentUser: () => null,
    clearSession: vi.fn(),
  } as unknown as AuthStateService;
}

const allOff: NotificationPreferences = {
  LIFECYCLE: { email: false, sms: false, push: false },
  MARKETING: { email: false, sms: false, push: false },
};

interface RenderOpts {
  locale: Locale;
  authed: boolean;
  prefs?: NotificationPreferences;
  getThrows?: unknown;
  updateThrows?: unknown;
}

interface RenderResult {
  fixture: ComponentFixture<PreferencesPage>;
  navigateSpy: ReturnType<typeof vi.fn>;
  service: {
    getPreferences: ReturnType<typeof vi.fn>;
    updatePreferences: ReturnType<typeof vi.fn>;
  };
}

async function renderPage(opts: RenderOpts): Promise<RenderResult> {
  const stub = new StubLocaleService(opts.locale);
  const auth = makeAuth(opts.authed);
  const service = {
    getPreferences: vi.fn(async () => {
      if (opts.getThrows) throw opts.getThrows;
      return opts.prefs ?? allOff;
    }),
    updatePreferences: vi.fn(async (input: Partial<NotificationPreferences>) => {
      if (opts.updateThrows) throw opts.updateThrows;
      return { ...(opts.prefs ?? allOff), ...input };
    }),
  };

  TestBed.overrideComponent(PreferencesPage, {
    set: { changeDetection: ChangeDetectionStrategy.Default },
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: LocaleService, useValue: stub },
      { provide: AuthStateService, useValue: auth },
      { provide: NotificationPreferencesService, useValue: service },
    ],
  });
  const router = TestBed.inject(Router);
  const navigateSpy = vi.fn(async () => true);
  router.navigateByUrl = navigateSpy as never;

  const fixture = TestBed.createComponent(PreferencesPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  // Second flush: the page now awaits the session boot outcome before it even
  // reaches its data load (finding N4), so the load settles one turn later.
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, navigateSpy, service };
}

describe('AccountPreferencesPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.head.innerHTML = '';
  });

  it('renders the SSR shell + the preferences form with category toggles', async () => {
    const { fixture } = await renderPage({ locale: 'fr', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="account-preferences-page"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="account-preferences-form"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="pref-toggle-LIFECYCLE"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="pref-toggle-MARKETING"]')).not.toBeNull();
  });

  it('redirects an anonymous visitor to /auth/login', async () => {
    const { navigateSpy } = await renderPage({ locale: 'en', authed: false });
    expect(navigateSpy).toHaveBeenCalled();
    expect(navigateSpy.mock.calls[0][0]).toContain('/en/auth/login');
  });

  it('reflects a stored opt-in in the toggle state', async () => {
    const { fixture } = await renderPage({
      locale: 'en',
      authed: true,
      prefs: {
        LIFECYCLE: { email: true, sms: false, push: false },
        MARKETING: { email: false, sms: false, push: false },
      },
    });
    const root = fixture.nativeElement as HTMLElement;
    const lifecycle = root.querySelector(
      '[data-testid="pref-toggle-LIFECYCLE"]',
    ) as HTMLInputElement;
    expect(lifecycle.checked).toBe(true);
  });

  it('saves and shows the status message after a submit', async () => {
    const { fixture, service } = await renderPage({ locale: 'en', authed: true });
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector('[data-testid="pref-toggle-LIFECYCLE"]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const form = root.querySelector('[data-testid="account-preferences-form"]') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.updatePreferences).toHaveBeenCalledWith({
      LIFECYCLE: { email: true },
      MARKETING: { email: false },
    });
    expect(root.querySelector('[data-testid="account-preferences-status"]')).not.toBeNull();
  });

  it('shows the localized form error when a save fails', async () => {
    const { StorefrontServerError } = await import('@storefront-types');
    const { fixture } = await renderPage({
      locale: 'en',
      authed: true,
      updateThrows: new StorefrontServerError({ code: 'SERVER', message: 'boom' }),
    });
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector('[data-testid="pref-toggle-LIFECYCLE"]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const form = root.querySelector('[data-testid="account-preferences-form"]') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    const err = root.querySelector(
      '[data-testid="account-preferences-form-error"]',
    ) as HTMLElement | null;
    expect(err?.textContent ?? '').toContain('Could not save your preferences');
  });

  it('hides the saved message and the save error once the customer toggles again (sibling of S2-5)', async () => {
    const { StorefrontServerError } = await import('@storefront-types');
    for (const updateThrows of [
      undefined,
      new StorefrontServerError({ code: 'SERVER', message: 'boom' }),
    ]) {
      TestBed.resetTestingModule();
      const { fixture } = await renderPage({ locale: 'en', authed: true, updateThrows });
      const root = fixture.nativeElement as HTMLElement;
      const toggle = root.querySelector(
        '[data-testid="pref-toggle-LIFECYCLE"]',
      ) as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      const form = root.querySelector(
        '[data-testid="account-preferences-form"]',
      ) as HTMLFormElement;
      form.dispatchEvent(new Event('submit'));
      await fixture.whenStable();
      fixture.detectChanges();
      const stale =
        '[data-testid="account-preferences-status"], [data-testid="account-preferences-form-error"]';
      expect(root.querySelector(stale)).not.toBeNull();

      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
      expect(root.querySelector(stale)).toBeNull();
    }
  });

  it('renders the error branch when getPreferences throws', async () => {
    const { StorefrontServerError } = await import('@storefront-types');
    const { fixture } = await renderPage({
      locale: 'en',
      authed: true,
      getThrows: new StorefrontServerError({ code: 'SERVER', message: 'boom' }),
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="account-preferences-error"]',
      ),
    ).not.toBeNull();
  });
});

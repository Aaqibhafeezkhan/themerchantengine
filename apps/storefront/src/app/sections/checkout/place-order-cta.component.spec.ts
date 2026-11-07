import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import { PlaceOrderCtaComponent } from './place-order-cta.component';
import { getChromeStrings } from '../../../i18n';
import type { Locale } from '../../../i18n/types';

class FakeLocaleService {
  private readonly _locale: WritableSignal<Locale>;
  readonly strings: WritableSignal<ReturnType<typeof getChromeStrings>>;
  constructor(locale: Locale) {
    this._locale = signal<Locale>(locale);
    this.strings = signal(getChromeStrings(locale));
  }
  readonly locale = () => this._locale();
}

describe('PlaceOrderCtaComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders the COD legal note for a cash-on-delivery tender', async () => {
    const fixture = await renderComponent(PlaceOrderCtaComponent, { paymentProvider: 'cod' }, [
      provideRouter([]),
      LocaleService,
    ]);
    const note = fixture.nativeElement.querySelector(
      '[data-testid="place-order-cod-note"]',
    ) as HTMLElement;
    expect(note?.textContent?.trim().length).toBeGreaterThan(0);
  });

  /**
   * Pass-2 finding D2. The note was unconditional, so a store paid by bank
   * transfer still told every customer they would hand cash to the courier.
   */
  it('hides the COD note for any other tender', async () => {
    const fixture = await renderComponent(PlaceOrderCtaComponent, { paymentProvider: 'manual' }, [
      provideRouter([]),
      LocaleService,
    ]);
    expect(fixture.nativeElement.querySelector('[data-testid="place-order-cod-note"]')).toBeNull();
  });

  it('hides the COD note when no tender has been resolved at all', async () => {
    const fixture = await renderComponent(PlaceOrderCtaComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    expect(fixture.nativeElement.querySelector('[data-testid="place-order-cod-note"]')).toBeNull();
  });

  /**
   * S2-20. The Arabic submit label said "cash on delivery" for every tender, so a
   * customer who picked a card was told they would pay the courier.
   */
  it('words the submit button the same in every locale, never naming a tender', async () => {
    for (const locale of ['fr', 'en', 'ar'] as const) {
      TestBed.resetTestingModule();
      const fixture = await renderComponent(PlaceOrderCtaComponent, { paymentProvider: 'card' }, [
        provideRouter([]),
        { provide: LocaleService, useValue: new FakeLocaleService(locale) },
      ]);
      const label = (
        fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement
      ).textContent;
      expect(label).not.toContain('الدفع عند الاستلام');
    }
  });

  /**
   * Pass-2 finding D7. An unset `termsOfServiceUrl` must never resolve to the
   * locale home, which is a perfectly truthy href for a link that goes nowhere
   * near the terms the customer is being asked to accept.
   */
  it('never resolves the terms link to the locale home', async () => {
    for (const locale of ['fr', 'en'] as const) {
      TestBed.resetTestingModule();
      const fixture = await renderComponent(PlaceOrderCtaComponent, { termsHref: null }, [
        provideRouter([]),
        { provide: LocaleService, useValue: new FakeLocaleService(locale) },
      ]);
      const href = (
        fixture.nativeElement.querySelector(
          '[data-testid="place-order-terms-link"]',
        ) as HTMLAnchorElement
      ).getAttribute('href');
      expect(href).not.toBe(`/${locale}`);
      expect(href).not.toBe(`/${locale}/`);
      expect(href).toBe(`/${locale}/policies/terms`);
    }
  });

  it('keeps the submit button focusable so screen-readers can read it', async () => {
    const fixture = await renderComponent(PlaceOrderCtaComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const submit = fixture.nativeElement.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit).not.toBeNull();
    // Button is never natively disabled: the a11y audit requires aria-disabled
    // semantics over HTML disabled. Submit is only blocked by the onSubmit
    // canSubmit guard (the form itself silently rejects invalid submits).
    expect(submit.disabled).toBe(false);
  });

  it('surfaces the terms-required inline error when clicked without accepting', async () => {
    const fixture = await renderComponent(PlaceOrderCtaComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const cmp = fixture.componentInstance as PlaceOrderCtaComponent;
    let count = 0;
    cmp.placeOrder.subscribe(() => count++);
    cmp['onSubmit']();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(count).toBe(0);
    const err = fixture.nativeElement.querySelector(
      '[data-testid="place-order-terms-required"]',
    ) as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.textContent?.trim()).toBe(getChromeStrings('fr').checkout.errors.termsRequired);
  });

  it('emits placeOrder when accepted form submits', async () => {
    const fixture = await renderComponent(PlaceOrderCtaComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const cmp = fixture.componentInstance as PlaceOrderCtaComponent;
    let count = 0;
    cmp.placeOrder.subscribe(() => count++);
    cmp['form'].controls['acceptTerms'].setValue(true);
    fixture.detectChanges();
    await fixture.whenStable();
    const submit = fixture.nativeElement.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    submit.click();
    expect(count).toBe(1);
  });

  it('does not emit when disabled input is true even with terms checked', async () => {
    const fixture = await renderComponent(PlaceOrderCtaComponent, { disabled: true }, [
      provideRouter([]),
      LocaleService,
    ]);
    const cmp = fixture.componentInstance as PlaceOrderCtaComponent;
    let count = 0;
    cmp.placeOrder.subscribe(() => count++);
    cmp['form'].controls['acceptTerms'].setValue(true);
    fixture.detectChanges();
    cmp['onSubmit']();
    expect(count).toBe(0);
  });

  it('renders an inline error region when errorMessage is set', async () => {
    const fixture = await renderComponent(
      PlaceOrderCtaComponent,
      { errorMessage: 'Out of stock' },
      [provideRouter([]), LocaleService],
    );
    const err = fixture.nativeElement.querySelector(
      '[data-testid="place-order-error"]',
    ) as HTMLElement;
    expect(err?.textContent?.trim()).toBe('Out of stock');
    expect(err.getAttribute('role')).toBe('alert');
  });

  it('renders zero serious or critical axe violations', async () => {
    const fixture = await renderComponent(PlaceOrderCtaComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['html-has-lang', 'landmark-one-main', 'region', 'heading-order'],
    });
  });

  describe('consent links', () => {
    async function render(locale: Locale, inputs: Record<string, unknown> = {}) {
      return renderComponent(PlaceOrderCtaComponent, inputs, [
        provideRouter([]),
        { provide: LocaleService, useValue: new FakeLocaleService(locale) },
      ]);
    }

    it('points the terms and privacy links at the real policy pages', async () => {
      const fixture = await render('en');
      const terms = fixture.nativeElement.querySelector(
        '[data-testid="place-order-terms-link"]',
      ) as HTMLAnchorElement;
      const privacy = fixture.nativeElement.querySelector(
        '[data-testid="place-order-privacy-link"]',
      ) as HTMLAnchorElement;
      // Both were computed as APP_ROUTES.home under a stale comment claiming
      // the policy pages had not shipped yet. They had.
      expect(terms.getAttribute('href')).toBe('/en/policies/terms');
      expect(privacy.getAttribute('href')).toBe('/en/policies/privacy');
    });

    it('keeps the policy routes localized', async () => {
      const fixture = await render('fr');
      const terms = fixture.nativeElement.querySelector(
        '[data-testid="place-order-terms-link"]',
      ) as HTMLAnchorElement;
      expect(terms.getAttribute('href')).toBe('/fr/policies/terms');
    });

    it('renders an operator-configured external terms URL as a plain anchor', async () => {
      // The API exposes termsOfServiceUrl on the checkout settings. When the
      // client that reads it lands, an absolute URL must not go through
      // routerLink, which would treat it as an in-app path.
      const fixture = await render('en', { termsHref: 'https://legal.example.com/terms' });
      const terms = fixture.nativeElement.querySelector(
        '[data-testid="place-order-terms-link"]',
      ) as HTMLAnchorElement;
      expect(terms.getAttribute('href')).toBe('https://legal.example.com/terms');
      expect(terms.getAttribute('rel')).toBe('noopener');
      expect(terms.getAttribute('target')).toBe('_blank');
    });
  });
});

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZoneChangeDetection, signal, type WritableSignal } from '@angular/core';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';

import { STOREFRONT_API_CLIENT, type ApiClient } from '@storefront-services';

import { CmsNavService } from '../services/cms-nav.service';
import { StoreConfigService } from '../services/store-config.service';
import { FooterComponent } from './footer.component';
import type { CmsPage } from '@storefront-types';
import { LocaleService } from '../locale.service';
import { getChromeStrings } from '../../i18n';
import type { Locale } from '../../i18n/types';
import {
  fixtureChromeIdentity,
  fixtureStoreConfigValue,
} from '../../test-support/store-config-fixtures';

// FooterComponent hosts the newsletter signup (NewsletterService → API client).
const noopApi = { post: async () => ({}), get: async () => ({}) } as unknown as ApiClient;

class FakeLocaleService {
  readonly _locale = signal<Locale>('fr');
  readonly _url = signal('/fr/');
  readonly locale = this._locale.asReadonly();
  readonly currentUrl = this._url.asReadonly();
  readonly chromeIdentity = () => fixtureChromeIdentity('maghreb-ltr', this._locale());
  readonly strings = signal(getChromeStrings('fr', fixtureChromeIdentity('maghreb-ltr', 'fr')));
  set(locale: Locale, url: string) {
    this._locale.set(locale);
    this._url.set(url);
    this.strings.set(getChromeStrings(locale, fixtureChromeIdentity('maghreb-ltr', locale)));
  }
}

/** The store the footer renders under, from the fixture the fakes read. */
const STORE_EN = fixtureChromeIdentity('maghreb-ltr', 'en').storeName;
const STORE_FR = fixtureChromeIdentity('maghreb-ltr', 'fr').storeName;

class FakeCmsNavService {
  readonly _pages: WritableSignal<CmsPage[]> = signal<CmsPage[]>([]);
  readonly pages = this._pages.asReadonly();
  loadCalls = 0;
  load = async () => {
    this.loadCalls += 1;
  };
}

function cmsPage(slug: string, title: string, type: CmsPage['type'] = 'STATIC'): CmsPage {
  return {
    id: `cms-${slug}`,
    slug,
    type,
    title,
    content: 'Body',
    isPublished: true,
    showInNavigation: true,
    sortOrder: 0,
  } as CmsPage;
}

/** The store-config surface the footer reads. Defaults to an unconfigured
 * store, which is the state every pre-existing assertion in this file was
 * written against. */
/**
 * Spreads the shared fixture stub rather than restating the service's members.
 * A hand-written stub went stale three times across plan E2 as the service
 * grew; this one cannot, because the members come from the service's own
 * fixture-backed shape and only the two this file varies are overridden.
 */
class FakeStoreConfigService {
  private readonly base = fixtureStoreConfigValue('maghreb-ltr');
  readonly localization = this.base.localization;
  readonly money = this.base.money;
  readonly brand = this.base.brand;
  readonly identity = this.base.identity;
  readonly runtime = this.base.runtime;
  readonly contactEmail = signal<string | null>(null);
  readonly phone = signal<string | null>(null);
  readonly socialLinks = signal<{ platform: string; url: string }[]>([]);
  /** Null is the unconfigured store: the footer falls back to the neutral mark. */
  readonly logoUrl = signal<string | null>(null);
  readonly storeName = signal<string | null>('Probe Store');
}

function setup(
  locale: Locale = 'fr',
  url = '/fr/',
  navPages: CmsPage[] = [],
  config: Partial<{
    contactEmail: string | null;
    phone: string | null;
    socialLinks: { platform: string; url: string }[];
  }> = {},
) {
  const fakeLocale = new FakeLocaleService();
  fakeLocale.set(locale, url);
  const fakeNav = new FakeCmsNavService();
  fakeNav._pages.set(navPages);
  const fakeConfig = new FakeStoreConfigService();
  if (config.contactEmail !== undefined) fakeConfig.contactEmail.set(config.contactEmail);
  if (config.phone !== undefined) fakeConfig.phone.set(config.phone);
  if (config.socialLinks !== undefined) fakeConfig.socialLinks.set(config.socialLinks);
  TestBed.configureTestingModule({
    imports: [FooterComponent],
    providers: [
      provideZoneChangeDetection({ eventCoalescing: true }),
      provideRouter([]),
      { provide: LocaleService, useValue: fakeLocale },
      { provide: STOREFRONT_API_CLIENT, useValue: noopApi },
      { provide: CmsNavService, useValue: fakeNav },
      { provide: StoreConfigService, useValue: fakeConfig },
    ],
  });
  const fixture = TestBed.createComponent(FooterComponent);
  fixture.detectChanges();
  return { fixture, fakeLocale, fakeNav, fakeConfig };
}

describe('FooterComponent', () => {
  it('renders the contentinfo landmark', () => {
    const { fixture } = setup();
    expect(fixture.nativeElement.querySelector('footer[role="contentinfo"]')).toBeTruthy();
  });

  it('opens the language menu at the start edge, above the trigger', () => {
    const { fixture } = setup();
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLElement>('[data-testid="footer-language-toggle"]')?.click();
    fixture.detectChanges();
    const menu = root.querySelector('.menu') as HTMLElement;
    expect(menu.classList.contains('start')).toBe(true);
    expect(menu.classList.contains('above')).toBe(true);
  });

  it('returns focus to the language trigger when Escape closes the menu', () => {
    const { fixture } = setup();
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector<HTMLElement>('[data-testid="footer-language-toggle"]')!;
    toggle.click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(root.querySelector('.menu')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('binds the reversed mark on the dark surface, one asset for both locales', () => {
    const { fixture } = setup('fr', '/fr/');
    const img = fixture.nativeElement.querySelector('.brand img') as HTMLImageElement;
    // The footer grounds on `--brand-text`, so it takes the reversed mark and
    // not the one the header uses. Binding the header's asset here painted a
    // dark wordmark on a near-black ground, which no `src` assertion catches
    // and which the gate review found by reading the artwork.
    expect(img.src).toMatch(/\/brand\/default\/logo-inverse\.svg$/);
    // The reserved box carries the artwork's own aspect. The default marks are
    // 200 x 40, and the box was 240 x 72 from a deleted asset, so every render
    // letterboxed the mark inside a box a third too tall.
    expect(img.getAttribute('width')).toBe('240');
    expect(img.getAttribute('height')).toBe('48');
    // Footer is below the fold — lazy + async per S14.5.
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('fetchpriority')).toBeNull();
  });

  it('leaves the brand block to the artwork, with no typed descriptor beside it', () => {
    const { fixture, fakeLocale } = setup('en', '/en/');
    // Brand floor §4.6 forbids retyping the logotype or the signature in a
    // font. The mark carries both as vector artwork, so a typed positioning
    // line beneath it would print the brand a second time.
    expect(fixture.nativeElement.querySelector('.brand-descriptor')).toBeNull();
    expect(fixture.nativeElement.querySelector('.brand-wordmark')).toBeNull();
    fakeLocale.set('fr', '/fr/');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.brand-descriptor')).toBeNull();
    expect(fixture.nativeElement.querySelector('.brand-wordmark')).toBeNull();
    // The lockup itself stays, and stays the only carrier of the name.
    expect(fixture.nativeElement.querySelector('.brand img')).not.toBeNull();
  });

  it('renders three column groups (About / Support / Legal)', () => {
    const { fixture } = setup('en', '/en/');
    const cols = fixture.nativeElement.querySelectorAll('[data-testid^="footer-col-"]');
    expect(cols.length).toBe(3);
    const headings = Array.from(fixture.nativeElement.querySelectorAll('.col-heading')).map((h) =>
      (h as HTMLElement).textContent?.trim(),
    );
    expect(headings).toEqual(['About', 'Support', 'Legal']);
  });

  it('renders the six routed footer link entries with bilingual labels', () => {
    const { fixture, fakeLocale } = setup('en', '/en/');
    const links = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid^="footer-link-"]'),
    ) as HTMLAnchorElement[];
    expect(links.length).toBe(6);
    const enLabels = links.map((a) => a.textContent?.trim());
    expect(enLabels).toEqual(['About', 'Shipping', 'Returns', 'Track order', 'Privacy', 'Terms']);

    fakeLocale.set('fr', '/fr/');
    fixture.detectChanges();
    const frLabels = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid^="footer-link-"]'),
    ).map((a) => (a as HTMLAnchorElement).textContent?.trim());
    expect(frLabels).toEqual([
      'À propos',
      'Livraison',
      'Retours',
      'Suivre ma commande',
      'Confidentialité',
      'Conditions',
    ]);
  });

  it('routes each footer link to the matching SSG path', () => {
    const { fixture, fakeLocale } = setup('en', '/en/');
    fixture.detectChanges();
    const links = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid^="footer-link-"]'),
    ) as HTMLAnchorElement[];
    expect(
      links.find((a) => a.dataset['testid'] === 'footer-link-about')?.getAttribute('href'),
    ).toBe('/en/about');
    expect(
      links.find((a) => a.dataset['testid'] === 'footer-link-privacy')?.getAttribute('href'),
    ).toBe('/en/policies/privacy');
    // The public track page has no other entry point: the header carries no
    // navigation at all (finding M3).
    expect(
      links.find((a) => a.dataset['testid'] === 'footer-link-track')?.getAttribute('href'),
    ).toBe('/en/track');
    expect(
      links.find((a) => a.dataset['testid'] === 'footer-link-shipping')?.getAttribute('href'),
    ).toBe('/en/policies/shipping');
    expect(
      links.find((a) => a.dataset['testid'] === 'footer-link-returns')?.getAttribute('href'),
    ).toBe('/en/policies/returns');
    expect(
      links.find((a) => a.dataset['testid'] === 'footer-link-terms')?.getAttribute('href'),
    ).toBe('/en/policies/terms');

    fakeLocale.set('fr', '/fr/');
    fixture.detectChanges();
    const frLinks = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid^="footer-link-"]'),
    ) as HTMLAnchorElement[];
    expect(
      frLinks.find((a) => a.dataset['testid'] === 'footer-link-about')?.getAttribute('href'),
    ).toBe('/fr/about');
    expect(
      frLinks.find((a) => a.dataset['testid'] === 'footer-link-terms')?.getAttribute('href'),
    ).toBe('/fr/policies/terms');
  });

  it('lists the enabled locales by native name with path-preserving hrefs', () => {
    const { fixture } = setup('en', '/en/_smoke/services?ref=home');
    const trigger = fixture.nativeElement.querySelector(
      'button[data-testid="footer-language-toggle"]',
    ) as HTMLButtonElement;
    expect(trigger.textContent).toContain('English');
    trigger.click();
    fixture.detectChanges();
    const options = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid^="footer-language-option-"]'),
    ) as HTMLAnchorElement[];
    const fr = options.find((o) => o.getAttribute('hreflang') === 'fr');
    expect(fr?.getAttribute('href')).toBe('/fr/_smoke/services?ref=home');
    expect(fr?.textContent?.trim()).toBe('Français');
    const en = options.find((o) => o.getAttribute('hreflang') === 'en');
    expect(en?.getAttribute('aria-current')).toBe('true');
  });

  it('gives the switcher light hover and focus colours on the dark surface', () => {
    const { fixture } = setup();
    const host = fixture.nativeElement.querySelector('app-language-switcher') as HTMLElement;
    const style = getComputedStyle(host);
    expect(style.getPropertyValue('--switcher-focus').trim()).toBe('var(--brand-on-primary)');
    expect(style.getPropertyValue('--switcher-hover-bg').trim()).toBe(
      'var(--brand-on-primary-hover-bg)',
    );
  });

  it('passes axe-core WCAG 2.2 AA at the component scope', async () => {
    const { fixture } = setup();
    const result = await axe.run(fixture.nativeElement, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
      rules: {
        region: { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
      },
    });
    const blocking = result.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  it('renders the bilingual copyright line', () => {
    const { fixture, fakeLocale } = setup();
    let copyright = fixture.nativeElement.querySelector('.legal') as HTMLElement;
    expect(copyright.textContent?.trim()).toContain('Tous droits réservés');
    fakeLocale.set('en', '/en/');
    fixture.detectChanges();
    copyright = fixture.nativeElement.querySelector('.legal') as HTMLElement;
    expect(copyright.textContent?.trim()).toContain('All rights reserved');
  });

  it('appends a navigable STATIC page to the About column', () => {
    const { fixture } = setup('en', '/en/', [cmsPage('/faq', 'FAQ')]);
    const about = fixture.nativeElement.querySelector('[data-testid="footer-col-about"]');
    const link = about?.querySelector('[data-testid="footer-link-cms-faq"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent?.trim()).toBe('FAQ');
    expect(link.getAttribute('href')).toBe('/en/pages/faq');
  });

  it('appends a navigable POLICY page to the Legal column', () => {
    const { fixture } = setup('en', '/en/', [cmsPage('/cookies', 'Cookie Policy', 'POLICY')]);
    const legal = fixture.nativeElement.querySelector('[data-testid="footer-col-legal"]');
    const link = legal?.querySelector(
      '[data-testid="footer-link-cms-cookies"]',
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/en/pages/cookies');
    // Not in About: the grouping is the point of the assertion.
    const about = fixture.nativeElement.querySelector('[data-testid="footer-col-about"]');
    expect(about?.querySelector('[data-testid="footer-link-cms-cookies"]')).toBeNull();
  });

  it('renders the CMS title the API resolved for the active locale', () => {
    const { fixture } = setup('fr', '/fr/', [cmsPage('/faq', 'Questions fréquentes')]);
    const link = fixture.nativeElement.querySelector(
      '[data-testid="footer-link-cms-faq"]',
    ) as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe('Questions fréquentes');
    expect(link.getAttribute('href')).toBe('/fr/pages/faq');
  });

  it('keeps the built-in links untouched when a CMS page is appended', () => {
    const { fixture } = setup('en', '/en/', [cmsPage('/faq', 'FAQ')]);
    const builtIn = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid^="footer-link-"]'),
    )
      .map((a) => (a as HTMLAnchorElement).dataset['testid'])
      .filter((id) => !id?.startsWith('footer-link-cms-'));
    expect(builtIn).toEqual([
      'footer-link-about',
      'footer-link-shipping',
      'footer-link-returns',
      'footer-link-track',
      'footer-link-privacy',
      'footer-link-terms',
    ]);
  });

  it('drops a CMS entry once the operator clears its navigation flag', () => {
    const { fixture, fakeNav } = setup('en', '/en/', [cmsPage('/faq', 'FAQ')]);
    expect(fixture.nativeElement.querySelector('[data-testid="footer-link-cms-faq"]')).toBeTruthy();
    fakeNav._pages.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="footer-link-cms-faq"]')).toBeNull();
  });

  it('asks the nav service to load its pages', () => {
    const { fakeNav } = setup();
    // The footer is where the fetch is triggered, not layout-shell.boot():
    // an extra footer link must never be able to fail the session bootstrap.
    expect(fakeNav.loadCalls).toBe(1);
  });

  describe('store contact block', () => {
    it('renders nothing when the operator configured no contact and no socials', () => {
      // The empty-config no-op: an unconfigured store must render the exact
      // footer it rendered before the config endpoint existed.
      const { fixture } = setup();
      expect(fixture.nativeElement.querySelector('[data-testid="footer-contact"]')).toBeNull();
    });

    it('renders a mailto link for the configured contact email', () => {
      const { fixture } = setup('en', '/en/', [], { contactEmail: 'contact@demo.test' });
      const link = fixture.nativeElement.querySelector(
        '[data-testid="footer-contact-email"]',
      ) as HTMLAnchorElement;
      expect(link).toBeTruthy();
      expect(link.getAttribute('href')).toBe('mailto:contact@demo.test');
      expect(link.textContent?.trim()).toBe('contact@demo.test');
    });

    it('isolates the visible number as left-to-right so a leading plus stays first in RTL (S2-19)', () => {
      const { fixture } = setup('ar', '/ar/', [], { phone: '+218 21 000 000' });
      const number = fixture.nativeElement.querySelector(
        '[data-testid="footer-contact-phone"] bdi[dir="ltr"]',
      ) as HTMLElement | null;
      expect(number?.textContent?.trim()).toBe('+218 21 000 000');
    });

    it('renders a tel link with the spaces stripped from the href only', () => {
      // A `tel:` href with spaces is not dialable on every handset; the visible
      // number keeps the operator's grouping.
      const { fixture } = setup('en', '/en/', [], { phone: '+218 21 000 000' });
      const link = fixture.nativeElement.querySelector(
        '[data-testid="footer-contact-phone"]',
      ) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('tel:+21821000000');
      expect(link.textContent?.trim()).toBe('+218 21 000 000');
    });

    it('renders one social link per configured platform, in the service order', () => {
      const { fixture } = setup('en', '/en/', [], {
        socialLinks: [
          { platform: 'facebook', url: 'https://facebook.com/demostore' },
          { platform: 'instagram', url: 'https://instagram.com/demostore' },
        ],
      });
      const links = Array.from(
        fixture.nativeElement.querySelectorAll('[data-testid^="footer-social-"]'),
      ) as HTMLAnchorElement[];
      expect(links.map((a) => a.getAttribute('href'))).toEqual([
        'https://facebook.com/demostore',
        'https://instagram.com/demostore',
      ]);
    });

    it('gives every social link an accessible name and a safe rel', () => {
      const { fixture } = setup('en', '/en/', [], {
        socialLinks: [{ platform: 'facebook', url: 'https://facebook.com/demostore' }],
      });
      const link = fixture.nativeElement.querySelector(
        '[data-testid="footer-social-facebook"]',
      ) as HTMLAnchorElement;
      // The link renders an icon-free platform name, so the accessible name is
      // the label, not the URL.
      expect(link.getAttribute('aria-label')).toBe(`${STORE_EN} on Facebook`);
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('target')).toBe('_blank');
    });

    it('localizes the social accessible name', () => {
      const { fixture } = setup('fr', '/fr/', [], {
        socialLinks: [{ platform: 'facebook', url: 'https://facebook.com/demostore' }],
      });
      const link = fixture.nativeElement.querySelector(
        '[data-testid="footer-social-facebook"]',
      ) as HTMLAnchorElement;
      expect(link.getAttribute('aria-label')).toBe(`${STORE_FR} sur Facebook`);
    });

    it('falls back to the raw key for a platform the display map does not know', () => {
      const { fixture } = setup('en', '/en/', [], {
        socialLinks: [{ platform: 'mastodon', url: 'https://example.social/@demostore' }],
      });
      const link = fixture.nativeElement.querySelector(
        '[data-testid="footer-social-mastodon"]',
      ) as HTMLAnchorElement;
      expect(link).toBeTruthy();
      expect(link.getAttribute('aria-label')).toBe(`${STORE_EN} on mastodon`);
    });

    it('appears as soon as the config resolves, without a reload', () => {
      const { fixture, fakeConfig } = setup();
      expect(fixture.nativeElement.querySelector('[data-testid="footer-contact"]')).toBeNull();
      fakeConfig.contactEmail.set('contact@demo.test');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="footer-contact"]')).toBeTruthy();
    });
  });
});

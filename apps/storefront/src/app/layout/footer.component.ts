import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LocaleService } from '../locale.service';
import { CmsNavService } from '../services/cms-nav.service';
import { StoreConfigService } from '../services/store-config.service';
import { APP_ROUTES, cmsPageRoute } from '../../lib/routes';

import { LanguageSwitcherComponent } from './language-switcher.component';
import { NewsletterSignupComponent } from './newsletter-signup.component';
import { DEFAULT_LOGO_INVERSE } from '../../lib/no-image';

interface FooterLink {
  key: string;
  label: string;
  href: string;
  testId: string;
}

interface FooterColumn {
  key: 'about' | 'support' | 'legal';
  heading: string;
  links: FooterLink[];
}

interface FooterSocialLink {
  platform: string;
  url: string;
  label: string;
  testId: string;
}

/**
 * Display names for the platforms `STORE_CONFIG.general.socialLinks` offers.
 *
 * Code-level rather than in the locale catalogues because a platform name is a
 * brand and does not translate; only the sentence around it does. An operator
 * who stores a key that is not here still gets a working link, labelled with
 * the raw key, rather than no link at all.
 */
const SOCIAL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  twitter: 'Twitter',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

/**
 * Storefront footer. Surfaces the bilingual lockup, column-grouped nav,
 * language switcher, and the copyright line.
 *
 * S22 chrome rework (agent_docs/storefront/brand-tokens.md amendment):
 * - The surface flips to `--brand-text` with inverse text on it, so the mark
 *   is the reversed one rather than the mark the header uses.
 * - No typed descriptor sits under the mark. The artwork already carries both
 *   the logotype and the signature as artwork, and §4.6 forbids retyping
 *   either one in a font, so a second tagline-shaped line would print the
 *   brand twice.
 * - The language switcher stays. Payment-method icons cut from v1 (revisit when
 *   the payment-method API stabilises).
 */
@Component({
  selector: 'app-footer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LanguageSwitcherComponent, NewsletterSignupComponent],
  styles: [
    `
      :host {
        display: block;
        background-color: var(--brand-text);
        color: var(--brand-on-primary);
      }

      .frame {
        max-inline-size: 1400px;
        margin-inline: auto;
        padding-inline: clamp(1rem, 4vw, 2rem);
        padding-block: clamp(2.5rem, 5vw, 3.5rem);
        display: grid;
        gap: 2rem;
        grid-template-columns: 1fr;
      }

      @media (min-width: 640px) {
        .frame {
          grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
          gap: 2.5rem;
        }
      }

      .brand {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        align-items: flex-start;
      }

      .brand img {
        block-size: 72px;
        inline-size: auto;
      }

      .col-heading {
        font-size: var(--brand-text-micro);
        font-weight: 500;
        color: var(--brand-on-primary);
        opacity: 0.7;
        margin-block: 0 0.75rem;
        margin-inline: 0;
      }

      .links ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
      }

      .links a {
        display: inline-flex;
        align-items: center;
        min-block-size: 44px;
        min-inline-size: 44px;
        padding-inline: 0.25rem;
        color: var(--brand-on-primary);
        text-decoration: none;
      }

      .links a:hover,
      .links a:focus-visible {
        text-decoration: underline;
        text-underline-offset: 4px;
      }

      .links a:focus-visible {
        outline: 2px solid var(--brand-on-primary);
        outline-offset: 2px;
      }

      app-language-switcher {
        --switcher-hover-bg: var(--brand-on-primary-hover-bg);
        --switcher-focus: var(--brand-on-primary);
      }

      .newsletter {
        grid-column: 1 / -1;
        padding-block-start: 1.5rem;
        border-block-start: 1px solid var(--brand-on-primary-divider);
      }

      .lang {
        grid-column: 1 / -1;
      }

      .contact p {
        margin: 0;
        margin-block-start: 0.5rem;
      }

      .socials {
        list-style: none;
        margin: 0;
        margin-block-start: 0.5rem;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
      }

      .legal {
        grid-column: 1 / -1;
        padding-block-start: 1.5rem;
        border-block-start: 1px solid var(--brand-on-primary-divider);
        font-size: var(--brand-text-micro);
        color: var(--brand-on-primary);
        opacity: 0.85;
        margin: 0;
      }
    `,
  ],
  template: `
    <footer role="contentinfo">
      <div class="frame">
        <div class="brand">
          <img
            [src]="lockupSrc()"
            [alt]="strings().footer.brandLockupAlt"
            width="240"
            height="48"
            loading="lazy"
            decoding="async"
          />
        </div>

        @for (col of columns(); track col.key) {
          <nav
            class="links"
            [attr.aria-label]="col.heading"
            [attr.data-testid]="'footer-col-' + col.key"
          >
            <h2 class="col-heading">{{ col.heading }}</h2>
            <ul>
              @for (link of col.links; track link.key) {
                <li>
                  <a [routerLink]="link.href" [attr.data-testid]="link.testId">{{ link.label }}</a>
                </li>
              }
            </ul>
          </nav>
        }

        <app-newsletter-signup class="newsletter" />

        @if (hasContact()) {
          <section class="contact" data-testid="footer-contact">
            <h2 class="col-heading">{{ strings().footer.contactHeading }}</h2>
            @if (contactEmail(); as email) {
              <p>
                <a
                  class="contact-link"
                  [href]="'mailto:' + email"
                  data-testid="footer-contact-email"
                >
                  {{ email }}
                </a>
              </p>
            }
            @if (phone(); as number) {
              <p>
                <a
                  class="contact-link"
                  [href]="'tel:' + dialable(number)"
                  data-testid="footer-contact-phone"
                >
                  <bdi dir="ltr">{{ number }}</bdi>
                </a>
              </p>
            }
            @if (socialLinks().length) {
              <ul class="socials" [attr.aria-label]="strings().footer.socialHeading">
                @for (link of socialLinks(); track link.platform) {
                  <li>
                    <a
                      class="contact-link"
                      [href]="link.url"
                      [attr.aria-label]="link.label"
                      [attr.data-testid]="link.testId"
                      target="_blank"
                      rel="noopener noreferrer"
                      >{{ displayName(link.platform) }}</a
                    >
                  </li>
                }
              </ul>
            }
          </section>
        }

        <div class="lang">
          <app-language-switcher idPrefix="footer" placement="above" align="start" />
        </div>

        <p class="legal">{{ strings().footer.copyright }}</p>
      </div>
    </footer>
  `,
})
export class FooterComponent {
  private readonly localeService = inject(LocaleService);
  private readonly cmsNav = inject(CmsNavService);
  private readonly storeConfig = inject(StoreConfigService);

  constructor() {
    // Hydration-time, from the footer rather than from `layout-shell.boot()`:
    // an extra nav link must never be able to fail the session bootstrap. The
    // service is browser-gated, so this is a no-op during SSR.
    void this.cmsNav.load();
  }

  protected readonly locale = this.localeService.locale;
  protected readonly strings = this.localeService.strings;
  /**
   * The footer grounds on `--brand-text`, so its mark needs light ink. A
   * configured logo is used as given, because one uploaded asset is all the
   * config carries today; the default has a reversed variant.
   */
  protected readonly lockupSrc = computed(() => this.storeConfig.logoUrl() ?? DEFAULT_LOGO_INVERSE);

  protected readonly homeRoute = computed(() => APP_ROUTES.home(this.locale()));

  /**
   * Operator-configured contact details (finding D4). Everything here is
   * absent until the settings carry a value: an unconfigured store renders the
   * footer it rendered before the config endpoint existed, rather than an
   * empty heading over an empty mailto link.
   */
  protected readonly contactEmail = this.storeConfig.contactEmail;
  protected readonly phone = this.storeConfig.phone;

  protected readonly socialLinks = computed<FooterSocialLink[]>(() => {
    const template = this.strings().footer.socialLinkLabel;
    return this.storeConfig.socialLinks().map(({ platform, url }) => ({
      platform,
      url,
      label: template.replace('{platform}', this.displayName(platform)),
      testId: `footer-social-${platform}`,
    }));
  });

  protected readonly hasContact = computed(
    () => !!this.contactEmail() || !!this.phone() || this.socialLinks().length > 0,
  );

  protected displayName(platform: string): string {
    return SOCIAL_DISPLAY_NAMES[platform] ?? platform;
  }

  /** A `tel:` href with spaces is not dialable on every handset. The visible
   * number keeps the operator's grouping; only the href is stripped. */
  protected dialable(phone: string): string {
    return phone.replace(/[^+0-9]/g, '');
  }

  /**
   * The five built-in links are core store IA and legally required copy, so
   * they render in the SSR HTML and deliberately ignore `showInNavigation`.
   * Everything the admin publishes beyond them is appended after hydration:
   * POLICY rows under Legal, the rest under About, in the order the operator
   * set. `cmsPageRoute` sends each slug to its canonical URL.
   */
  protected readonly columns = computed<FooterColumn[]>(() => {
    const loc = this.locale();
    const extras = this.cmsNav.pages();
    return this.baseColumns().map((col) => {
      if (col.key === 'support') return col;
      const wantPolicy = col.key === 'legal';
      const links = extras
        .filter((page) => (page.type === 'POLICY') === wantPolicy)
        .map((page) => ({
          key: `cms-${page.slug}`,
          label: page.title,
          href: cmsPageRoute(loc, page.slug),
          testId: `footer-link-cms-${page.slug.replace(/^\/+|\/+$/g, '')}`,
        }));
      return links.length ? { ...col, links: [...col.links, ...links] } : col;
    });
  });

  private readonly baseColumns = computed<FooterColumn[]>(() => {
    const s = this.strings().footer;
    const loc = this.locale();
    return [
      {
        key: 'about',
        heading: s.columnAboutLabel,
        links: [
          {
            key: 'about',
            label: s.about,
            href: APP_ROUTES.about(loc),
            testId: 'footer-link-about',
          },
        ],
      },
      {
        key: 'support',
        heading: s.columnSupportLabel,
        links: [
          {
            key: 'shipping',
            label: s.shipping,
            href: APP_ROUTES.policy(loc, 'shipping'),
            testId: 'footer-link-shipping',
          },
          {
            key: 'returns',
            label: s.returns,
            href: APP_ROUTES.policy(loc, 'returns'),
            testId: 'footer-link-returns',
          },
          // The only navigation into the public track page: the header carries
          // no links at all (finding M3, plan C territory).
          {
            key: 'track',
            label: s.trackOrder,
            href: APP_ROUTES.track(loc),
            testId: 'footer-link-track',
          },
        ],
      },
      {
        key: 'legal',
        heading: s.columnLegalLabel,
        links: [
          {
            key: 'privacy',
            label: s.privacy,
            href: APP_ROUTES.policy(loc, 'privacy'),
            testId: 'footer-link-privacy',
          },
          {
            key: 'terms',
            label: s.terms,
            href: APP_ROUTES.policy(loc, 'terms'),
            testId: 'footer-link-terms',
          },
        ],
      },
    ];
  });
}

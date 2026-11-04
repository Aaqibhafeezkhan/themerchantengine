import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { LocaleService } from '../../locale.service';
import { TrustIconComponent } from './icons/trust-icon.component';

export interface TrustPillar {
  kind: 'delivery' | 'returns' | 'authentic' | 'support';
  title: string;
  subtitle: string;
}

/**
 * Trust strip — four feature pillars (delivery, returns, authenticity,
 * support). A primary rule on the **top edge** (`border-block-start`), which
 * is one of the primary's sanctioned uses, and no card chrome, so the
 * pillars sit directly on the page surface. Title and icon are
 * `--brand-primary`; subtitle stays `--brand-text-muted`.
 */
@Component({
  selector: 'app-trust-strip',
  standalone: true,
  imports: [TrustIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="strip" [attr.aria-labelledby]="headingId()" data-testid="home-trust-strip">
      <h2 [id]="headingId()" class="visually-hidden">
        {{ resolvedTitle() }}
      </h2>
      <ul class="grid" role="list">
        @for (pillar of resolvedPillars(); track pillar.kind) {
          <li class="pillar" [attr.data-testid]="'home-trust-' + pillar.kind">
            <span class="icon" aria-hidden="true">
              <app-trust-icon [kind]="pillar.kind" [size]="28" />
            </span>
            <div class="text">
              <p class="title">{{ pillar.title }}</p>
              <p class="subtitle">{{ pillar.subtitle }}</p>
            </div>
          </li>
        }
      </ul>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .strip {
        border-block-start: 3px solid var(--brand-primary);
        padding-block: 1.5rem;
        padding-inline: 0;
      }
      .visually-hidden {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        margin-block: -1px;
        margin-inline: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }
      .grid {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1rem;
      }
      .pillar {
        display: flex;
        align-items: center;
        gap: 0.875rem;
      }
      .icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 44px;
        block-size: 44px;
        shrink: 0;
        color: var(--brand-primary);
        background-color: var(--brand-surface-strong);
        border-radius: var(--brand-radius-md);
      }
      .text {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
      }
      .title {
        margin: 0;
        font-size: var(--brand-text-body);
        font-weight: 600;
        color: var(--brand-primary);
      }
      .subtitle {
        margin: 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-text-muted);
      }

      @media (min-width: 768px) {
        .grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
      }
    `,
  ],
})
export class TrustStripComponent {
  private readonly localeService = inject(LocaleService);

  /**
   * Optional pillar list from a `StorefrontSection.config.items` (dynamic-
   * sections path). When unset, the component falls back to the chrome-
   * strings derivation that has shipped since S5 — keeps the flag-off
   * render unchanged until S21 cutover.
   */
  readonly pillars = input<TrustPillar[] | null>(null);

  /**
   * Unique DOM id for the heading + `aria-labelledby` chain so two
   * TRUST_SIGNALS rows on the same page never collide on a hardcoded id.
   */
  readonly headingId = input<string>('home-trust-heading');

  /**
   * Operator section title from the row envelope. The heading used to be the
   * i18n string unconditionally, so a merchant who titled the section in the
   * admin saw that title nowhere (finding H3). The i18n heading is now the
   * fallback, not the value.
   *
   * The heading stays visually hidden. Making it visible is a agent_docs/storefront/brand-tokens.md
   * decision, not a rendering fix.
   */
  readonly title = input<string | null>(null);

  protected readonly strings = this.localeService.strings;

  protected readonly resolvedTitle = computed(() => {
    const configured = this.title()?.trim();
    return configured ? configured : this.strings().home.trust.heading;
  });

  protected readonly resolvedPillars = computed<TrustPillar[]>(() => {
    const incoming = this.pillars();
    if (incoming && incoming.length > 0) return incoming;
    const trust = this.strings().home.trust;
    return [
      { kind: 'delivery', title: trust.delivery.title, subtitle: trust.delivery.subtitle },
      { kind: 'returns', title: trust.returns.title, subtitle: trust.returns.subtitle },
      { kind: 'authentic', title: trust.authentic.title, subtitle: trust.authentic.subtitle },
      { kind: 'support', title: trust.support.title, subtitle: trust.support.subtitle },
    ];
  });
}

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { LocaleService } from '../locale.service';
import { WishlistToggleComponent } from '../sections/product/wishlist-toggle.component';
import { PictureComponent, type PictureSource } from './picture.component';
import { PriceComponent } from './price.component';
import { RatingComponent } from './rating.component';
import { StoreConfigService } from '../services/store-config.service';
import type { Availability } from '../../lib/availability';
import { DEFAULT_LOCALE } from '../../i18n/types';
import { getChromeStrings } from '../../i18n';

/**
 * The three availability states a product surface renders, matching the API's
 * `STOCK_STATUSES` in `apps/api/src/modules/inventory/inventory.constants.ts`
 * so the wire value reaches the screen without a second vocabulary.
 */
export type ProductAvailability = Availability;

/** Short `data-state` attribute value the state-colour styles key off. */
export type AvailabilityState = 'in' | 'low' | 'out';

export const AVAILABILITY_STATE: Record<ProductAvailability, AvailabilityState> = {
  IN_STOCK: 'in',
  LOW_STOCK: 'low',
  OUT_OF_STOCK: 'out',
};

export interface ProductCardData {
  /** Product id — drives the optional overlay wishlist toggle. When absent
   * the toggle is not rendered (older callers can omit and stay valid). */
  productId?: string;
  slug: string;
  title: string;
  href: string;
  imageSrc: string;
  imageAlt: string;
  imageSources?: PictureSource[];
  /**
   * Null when the payload carries no resolvable price, which draws no price line
   * at all. It used to be a plain `number` and every producer floored it at a
   * literal `0`, so a search hit whose price the page could not find rendered as
   * `0,000 DT`, a real and wrong and buyable-looking price on every card. A missing
   * price is missing information, and the card has to say nothing rather than
   * say zero. A genuine zero is still a zero and still renders.
   */
  price: number | null;
  compareAtPrice?: number | null;
  currency?: string;
  ratingValue?: number;
  reviewCount?: number;
  deliveryEstimate?: string;
  /** Required, never optional. agent_docs/storefront/brand-tokens.md and §10 row 21 make
   * availability part of the card itself, so every producer has to state it
   * rather than fall through to a silent default. */
  availability: ProductAvailability;
}

@Component({
  selector: 'app-product-card',
  standalone: true,
  imports: [PictureComponent, PriceComponent, RatingComponent, WishlistToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="card">
      <div class="image-area">
        <a [href]="data().href" class="image-link">
          <app-picture
            [src]="data().imageSrc"
            [alt]="data().imageAlt"
            [sources]="data().imageSources ?? []"
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            aspectRatio="1 / 1"
          />
        </a>
        @if (data().productId) {
          <wishlist-toggle
            class="card-wishlist"
            variant="overlay"
            [productId]="data().productId!"
            [iconSize]="18"
          />
        }
      </div>
      <div class="meta">
        <h3 class="title">
          <a [href]="data().href">{{ data().title }}</a>
        </h3>
        <div class="rating-slot" [attr.aria-hidden]="ratingSlotAriaHidden()">
          @if (showRating()) {
            <app-rating [value]="data().ratingValue ?? 0" [count]="data().reviewCount ?? 0" />
          }
        </div>
        <div class="footer">
          @if (price() !== null) {
            <app-price
              [amount]="price()!"
              [compareAt]="data().compareAtPrice ?? null"
              [currency]="currency()"
              taxMention="excluded"
            />
          }
          <p
            class="availability"
            [attr.data-state]="availabilityState()"
            data-testid="product-card-availability"
          >
            {{ availabilityLabel() }}
          </p>
          <p class="delivery" [attr.aria-hidden]="deliveryAriaHidden()">{{ deliveryText() }}</p>
        </div>
      </div>
    </article>
  `,
  styles: [
    `
      :host {
        display: flex;
        block-size: 100%;
        min-inline-size: 0;
        inline-size: 100%;
      }
      .card {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        background-color: var(--brand-surface);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-lg);
        overflow: clip;
        min-inline-size: 0;
      }
      .image-area {
        position: relative;
        shrink: 0;
      }
      .image-link {
        display: block;
        aspect-ratio: 1 / 1;
        background-color: var(--brand-bg);
        shrink: 0;
        overflow: hidden;
      }
      .card-wishlist {
        /* Overlay handled by wishlist-toggle's own .is-overlay positioning;
           explicit z-index keeps it above the image-link anchor when both
           occupy the same stacking context. */
        z-index: 1;
      }
      /* Force the app-picture chain to fill the aspect-ratio'd anchor
         even when the source asset is non-square (some seeded
         products ship 1:2 portraits). Without this the picture/img
         intrinsic ratio overrides the parent constraint and image
         heights drift across cards. */
      .image-link app-picture {
        display: block;
        inline-size: 100%;
        block-size: 100%;
      }
      .image {
        inline-size: 100%;
        block-size: 100%;
        object-fit: cover;
        display: block;
      }
      .meta {
        flex: 1;
        padding-block: 0.625rem 1rem;
        padding-inline: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-inline-size: 0;
      }
      .title {
        margin: 0;
        font-family: var(--brand-font-display);
        font-size: var(--brand-text-product);
        font-weight: 500;
        line-height: 1.4;
        color: var(--brand-text);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        /* Reserve two text lines so cards with 1-line and 2-line titles
           occupy identical vertical space. */
        min-block-size: calc(1.4em * 2);
      }
      .title a {
        color: inherit;
        text-decoration: none;
      }
      .title a:hover,
      .title a:focus-visible {
        text-decoration: underline;
      }
      /* Reserve the rating slot height even when the product has zero
         reviews. Brand-floor §10 forbids fake stars on placeholder
         products, so the slot stays empty visually but holds the layout
         line height (matches app-rating's rendered block-size). */
      .rating-slot {
        min-block-size: 1.25rem;
      }
      .footer {
        margin-block-start: auto;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      /* State colours. The success and warning colours only
         clear 3:1 on so their text steps carry the label; Rouge
         rupture already clears 4.5:1 and stays as the charte hex. */
      .availability {
        margin: 0;
        font-size: var(--brand-text-micro);
        font-weight: 500;
      }
      .availability[data-state='in'] {
        color: var(--brand-success-text);
      }
      .availability[data-state='low'] {
        color: var(--brand-warning-text);
      }
      .availability[data-state='out'] {
        color: var(--brand-error);
      }
      .delivery {
        margin: 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-text-muted);
        min-block-size: 1.1em;
      }
    `,
  ],
})
export class ProductCardComponent {
  readonly data = input.required<ProductCardData>();

  /** Optional, like every other primitive in this folder: the card renders in
   * specs and stories with no router-backed LocaleService bound, and falls
   * back to the default locale there. */
  private readonly localeService = inject(LocaleService, { optional: true });

  /** Read through a computed so the template can narrow it: `data().price` is a
   * call expression and an `@if` cannot narrow one. */
  protected readonly price = computed(() => this.data().price);

  protected readonly showRating = computed(() => (this.data().reviewCount ?? 0) > 0);
  private readonly storeConfig = inject(StoreConfigService);

  /** The card data carries a currency only when the API sent one; otherwise
   * the store's configured code labels it. */
  protected readonly currency = computed(
    () => this.data().currency ?? this.storeConfig.currencyCode(),
  );
  /** Delivery slot text — U+00A0 (NBSP) when absent so the line reserves
   * its `min-block-size: 1.1em` reliably across UAs that collapse a
   * solitary regular space inside `<p>`. Brand-auditor flagged this. */
  /** Hide the empty delivery slot from screen readers — the NBSP is a
   * pure layout reservation. a11y-auditor flagged the noise. */
  protected readonly deliveryAriaHidden = computed(() => (this.showDelivery() ? null : 'true'));
  /** The rating-slot wrapper is decorative-only when there is no rating.
   * When `showRating()` is true the slot must surrender its aria-hidden
   * so the inner app-rating's role="img" + aria-label propagate to the
   * accessibility tree (a11y-auditor serious finding). */
  protected readonly ratingSlotAriaHidden = computed(() => (this.showRating() ? null : 'true'));
  /** Finding H5: an out-of-stock card promised a delivery date for something
   * nobody can buy. Every producer still passes the estimate; the gate lives
   * here so one change clears the home rails, catalog, category, search and
   * the related rail at once. LOW_STOCK keeps the promise: it can be bought. */
  protected readonly showDelivery = computed(
    () => !!this.data().deliveryEstimate && this.availabilityState() !== 'out',
  );
  protected readonly deliveryText = computed(() =>
    this.showDelivery() ? (this.data().deliveryEstimate ?? ' ') : ' ',
  );

  protected readonly availabilityState = computed<AvailabilityState>(
    () => AVAILABILITY_STATE[this.data().availability],
  );

  /** Real text, never a bare colour swatch: WCAG 1.4.1 forbids colour as the
   * only carrier of a meaning, so the label states it and the state colour
   * only reinforces it. */
  protected readonly availabilityLabel = computed(() => {
    const stock = getChromeStrings(this.localeService?.locale() ?? DEFAULT_LOCALE).product.stock;
    switch (this.data().availability) {
      case 'IN_STOCK':
        return stock.inStock;
      case 'LOW_STOCK':
        return stock.lowStock;
      default:
        return stock.outOfStock;
    }
  });
}

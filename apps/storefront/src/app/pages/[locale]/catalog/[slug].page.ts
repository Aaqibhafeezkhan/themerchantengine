import { DOCUMENT, isPlatformBrowser, isPlatformServer } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { injectLoad } from '@analogjs/router';

import { ProductsService } from '@storefront-services';
import type { BrandFacet, Category, ListProductsQuery, ProductSummary } from '@storefront-types';
import { pickTranslation, type ResolvedString } from '@storefront-types';

import { looksLikeRichTextHtml } from '../../../../lib/rich-text';

import { readSpecParam, groupSpecTokens } from '../../../../lib/catalog-filters';
import { resultsCountLabel } from '../../../../lib/catalog-copy';
import type { load } from './[slug].server';

import { BreadcrumbComponent, type BreadcrumbItem } from '../../../ui/breadcrumb.component';
import { LocaleService } from '../../../locale.service';
import { APP_ROUTES } from '../../../../lib/routes';
import { pictureSourcesFromAssetVariants } from '../../../../lib/asset-variant';
import { noImageFallback } from '../../../../lib/no-image';
import { productAvailability } from '../../../../lib/availability';
import {
  breadcrumbListJsonLd,
  categoryMetaTags,
  itemListJsonLd,
  pageTitle,
  serializeJsonLd,
} from '../../../../lib/seo';
import { upsertPropertyMulti } from '../../../../lib/meta-dom';
import { CategoryBarComponent } from '../../../sections/catalog/category-bar.component';
import { PictureComponent } from '../../../ui/picture.component';
import {
  FilterRailComponent,
  type CatalogFilterChange,
  type CatalogFilterState,
  type CatalogSpecFacet,
  type CatalogPriceBand,
} from '../../../sections/catalog/filter-rail.component';
import { ProductGridComponent } from '../../../sections/catalog/product-grid.component';
import {
  SortControlComponent,
  type CatalogSortChange,
  type CatalogSortKey,
} from '../../../sections/catalog/sort-control.component';
import type { ProductCardData } from '../../../ui/product-card.component';
import { catalogSortKeyFromQuery, resolveCatalogSort } from '../../../../lib/catalog-sort';
import { StoreConfigService } from '../../../services/store-config.service';

/**
 * Cap on sequential page fetches issued during deep-link restoration. Beyond
 * this the customer scrolls to load more — bounds the cost of `?page=999`.
 */
const MAX_RESTORE_PAGES = 10;
const PAGE_SIZE = 24;

const PRICE_BAND_FROM_QUERY = (
  minPrice: number | null,
  maxPrice: number | null,
): CatalogPriceBand | null => {
  if (minPrice == null && maxPrice === 49.999) return 'under50';
  if (minPrice === 50 && maxPrice === 249.999) return '50to250';
  if (minPrice === 250 && maxPrice === 999.999) return '250to1000';
  if (minPrice === 1000 && maxPrice == null) return 'over1000';
  return null;
};

@Component({
  selector: 'app-catalog-category-page',
  standalone: true,
  imports: [
    BreadcrumbComponent,
    CategoryBarComponent,
    PictureComponent,
    FilterRailComponent,
    ProductGridComponent,
    SortControlComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-breadcrumb [items]="breadcrumb()" [ariaLabel]="strings().catalog.breadcrumb.navLabel" />

      <catalog-category-bar [activeSlug]="slug()" />

      <header class="header">
        @if (categoryImageUrl()) {
          <span class="header-media" aria-hidden="true">
            <app-picture
              [src]="categoryImageUrl()!"
              alt=""
              [sources]="categoryImageSources()"
              sizes="72px"
              aspectRatio="1 / 1"
            />
          </span>
        }
        <span class="header-text">
          <h1 class="title">{{ headingText() }}</h1>
          @if (totalCount() > 0) {
            <p class="results">{{ resultsCount() }}</p>
          }
        </span>
      </header>

      @if (introText()) {
        @if (introIsRich()) {
          <!-- innerhtml-approved: admin-authored rich text, sanitized on write by sanitizeRichTextHtml against a safe-tag allowlist (constitution 3.5); Angular sanitizes again on render. No bypassSecurityTrust* involved. -->
          <div
            class="intro rich-text-content"
            data-testid="category-intro"
            [innerHTML]="introText()"
          ></div>
        } @else {
          <p class="intro intro-plain" data-testid="category-intro">{{ introText() }}</p>
        }
      }

      <div class="grid-shell">
        <aside class="rail" [attr.aria-label]="strings().catalog.filters.title">
          <catalog-filter-rail
            [specFacets]="specFacets()"
            [brands]="availableBrands()"
            [initial]="currentFilterState()"
            (filterChange)="onFilterChange($event)"
          />
        </aside>
        <div class="grid">
          <div class="toolbar">
            <catalog-sort-control
              [current]="currentSortKey()"
              (sortChange)="onSortChange($event)"
            />
          </div>
          @if (productsError()) {
            <div class="load-error" data-testid="catalog-error" role="alert">
              <p>{{ strings().catalog.loadError }}</p>
              <button type="button" data-testid="catalog-error-retry" (click)="retry()">
                {{ strings().catalog.retry }}
              </button>
            </div>
          } @else {
            <catalog-product-grid
              [items]="cardItems()"
              [loading]="loading()"
              [loadingMore]="loadingMore()"
              [hasMore]="hasMore()"
              (loadMore)="onLoadMore()"
            />
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        background-color: var(--brand-bg);
        min-block-size: 100dvh;
      }
      .page {
        display: flex;
        flex-direction: column;
        gap: clamp(1rem, 3vw, 1.5rem);
        max-inline-size: 1400px;
        margin-inline: auto;
        padding-block: clamp(1rem, 4vw, 2rem);
        padding-inline: clamp(1rem, 4vw, 2rem);
      }
      .header {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 1rem;
      }
      /* Decorative: the h1 names the page, so the image carries an empty alt
         inside an aria-hidden span. */
      .header-media {
        display: inline-flex;
        inline-size: 72px;
        block-size: 72px;
        shrink: 0;
        border-radius: var(--brand-radius-lg);
        overflow: hidden;
      }
      .header-media img {
        inline-size: 100%;
        block-size: 100%;
        object-fit: cover;
      }
      .header-text {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-inline-size: 0;
      }
      .title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md page title */
        font-size: clamp(var(--brand-text-display-mobile), 4vw, var(--brand-text-display));
        font-weight: 700;
        color: var(--brand-text);
      }
      .results {
        margin: 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-text-muted);
      }
      /*
        The admin hands operators a full rich-text editor for this field and
        the value was already on the public wire, but nothing rendered it:
        the copy they wrote was invisible to customers. Typography for the
        injected children is the shared .rich-text-content in global.css.
      */
      .intro {
        margin: 0;
        max-inline-size: 70ch;
        font-size: var(--brand-text-body);
        line-height: 1.6;
        color: var(--brand-text);
      }
      .intro-plain {
        white-space: pre-wrap;
      }
      /* Load-error block, shared shape with the cart and search pages. */
      .load-error {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        align-items: start;
        padding-block: 2rem;
      }
      .load-error p {
        margin: 0;
        color: var(--brand-text);
      }
      .load-error button {
        font: inherit;
        min-block-size: 44px;
        padding-block: 0.5rem;
        padding-inline: 1rem;
        border-radius: var(--brand-radius-md);
        background-color: transparent;
        color: var(--brand-primary);
        border: 1px solid var(--brand-primary);
        cursor: pointer;
      }
      .load-error button:focus-visible {
        outline: 2px solid var(--brand-text);
        outline-offset: 2px;
      }
      .grid-shell {
        display: grid;
        gap: clamp(1rem, 3vw, 1.5rem);
        grid-template-columns: 1fr;
      }
      @media (min-width: 1024px) {
        .grid-shell {
          grid-template-columns: 280px 1fr;
        }
      }
      .toolbar {
        display: flex;
        justify-content: flex-end;
        margin-block-end: 0.75rem;
      }
    `,
  ],
})
export default class CatalogCategoryPage implements OnInit {
  private readonly localeService = inject(LocaleService);
  private readonly storeConfig = inject(StoreConfigService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly productsSvc = inject(ProductsService);

  protected readonly locale = this.localeService.locale;
  protected readonly strings = this.localeService.strings;

  /**
   * SH4 — seed category + first-page products from the page server endpoint
   * payload exported by the sibling `[slug].server.ts` companion. Closes
   * AC-5 (category surface) by populating both the resolved category copy
   * and the products grid on the SSR pass. Mirrors SH2/SH3.
   */
  protected readonly loaded = toSignal(injectLoad<typeof load>(), { requireSync: true });

  protected readonly slug = signal<string>(this.loaded().category.slug);
  protected readonly category = signal<Category | null>(this.loaded().category);
  protected readonly products = signal<ProductSummary[]>(this.loaded().products);
  protected readonly totalCount = signal<number>(this.loaded().totalCount);
  protected readonly loading = signal<boolean>(false);
  /**
   * True when the products fetch failed, as opposed to the category having
   * none. The loader keeps soft-failing so a products outage cannot 500 the
   * category page, and this carries what it soft-failed on (finding C10).
   */
  protected readonly productsError = signal<boolean>(this.loaded().productsError === true);
  /** True while page N>1 is being appended; cards stay rendered. */
  protected readonly loadingMore = signal<boolean>(false);
  /** Last-rendered page; drives URL `?page` and the load-more guard. */
  protected readonly currentPage = signal<number>(1);
  /** Computed from total — collapses the load-more sentinel when false. */
  protected readonly hasMore = computed(() => this.products().length < this.totalCount());
  /**
   * First-page snapshot for JSON-LD ItemList. Capping at PAGE_SIZE keeps
   * structured data stable across appends — Google's crawler does not
   * benefit from rewriting the script on every scroll.
   */
  protected readonly firstPageItems = computed(() => this.products().slice(0, PAGE_SIZE));
  /**
   * Monotonic counter. Filter / sort / slug changes bump the counter so any
   * in-flight page-N fetch is invalidated.
   */
  private requestSeq = 0;

  protected readonly currentSortKey = signal<CatalogSortKey>('newest');
  /** Derived by the API from the live catalogue; see the catalogue index page. */
  protected readonly specFacets = signal<CatalogSpecFacet[]>(
    (this.loaded().specFacets ?? []) as CatalogSpecFacet[],
  );

  /**
   * The payload the field initialisers above already seeded. The effect below
   * skips it so the deep-link restore started in `ngOnInit` is not cancelled by
   * the effect's own first run.
   */
  private seededPayload = this.loaded();

  protected readonly currentFilterState = signal<CatalogFilterState>({
    brand: null,
    priceBand: null,
  });

  protected readonly String = String;

  protected readonly categoryName = computed(() =>
    pickTranslation((this.category()?.name ?? null) as ResolvedString | null, this.locale()),
  );

  /**
   * Category intro copy, resolved for the request locale. Empty when the
   * operator left the field blank, which is the common case, so the block is
   * conditional rather than an always-present empty node.
   */
  protected readonly introText = computed(() =>
    pickTranslation((this.category()?.description ?? null) as ResolvedString | null, this.locale()),
  );
  protected readonly introIsRich = computed(() => looksLikeRichTextHtml(this.introText()));

  /** `card`-intent URL the API resolved from the category's `imageId`. */
  protected readonly categoryImageUrl = computed<string | null>(() => {
    const url = (this.category() as { imageUrl?: unknown } | null)?.imageUrl;
    return typeof url === 'string' && url.length > 0 ? url : null;
  });

  /** Responsive `<source>` ladder for the header image. */
  protected readonly categoryImageSources = computed(() =>
    pictureSourcesFromAssetVariants(
      (this.category() as { imageVariants?: unknown } | null)?.imageVariants,
      '72px',
    ),
  );

  /** Page heading: the category name, falling back to the slug and then to the
   * generic shop title so the heading slot is never empty. The loader hard-404s
   * an unresolved slug, so the fallbacks only cover an unnamed category. */
  protected readonly headingText = computed(() => {
    const name = this.categoryName();
    if (name) return name;
    return this.slug() || this.strings().catalog.pageTitle;
  });

  /**
   * Brand facets from the API, not from the products on screen.
   *
   * Deriving them from `products()` meant a page-1 sample of the already
   * filtered result, so choosing a brand collapsed the rail to that brand and
   * the shopper could not switch without clearing (finding C11).
   */
  protected readonly brandFacets = signal<BrandFacet[]>(this.loaded().brandFacets ?? []);
  protected readonly availableBrands = computed(() => this.brandFacets().map((f) => f.brand));

  protected readonly resultsCount = computed(() =>
    resultsCountLabel(this.totalCount(), this.strings()),
  );

  protected readonly cardItems = computed<ProductCardData[]>(() => {
    return this.products().map((p) => this.toCardData(p));
  });

  protected readonly breadcrumb = computed<BreadcrumbItem[]>(() => {
    const baseLabel = this.strings().catalog.breadcrumb;
    const home: BreadcrumbItem = { label: baseLabel.home, href: APP_ROUTES.home(this.locale()) };
    const catalog: BreadcrumbItem = {
      label: baseLabel.catalog,
      href: APP_ROUTES.catalog(this.locale()),
    };
    const name = this.categoryName();
    if (!name) return [home, catalog];
    return [home, catalog, { label: name }];
  });

  constructor() {
    /**
     * Findings C1 and C7. The category route re-resolves its loader on a
     * query-param change and on a sibling-slug change alike, so the payload
     * always describes the URL the customer is on: filters, sort and category
     * together. The page used to seed once and then refetch from
     * `route.snapshot`, which still held the pre-navigation params, so the grid
     * was overwritten with yesterday's filters. The loader is the only writer
     * now, which is also what retired the browser-side `hydrateBrowser()` pair
     * of fetches on sibling-slug navigation.
     *
     * An `effect()` rather than a direct `subscribe`: the title strategy runs
     * between route activation and `NavigationEnd`, so a synchronous re-apply
     * of the meta would be overwritten by the strategy's home title (C2).
     */
    effect(() => {
      const payload = this.loaded();
      if (payload === this.seededPayload) return;
      this.seededPayload = payload;
      this.requestSeq += 1;
      this.slug.set(payload.category.slug);
      this.category.set(payload.category);
      this.products.set(payload.products);
      this.totalCount.set(payload.totalCount);
      this.productsError.set(payload.productsError === true);
      this.specFacets.set((payload.specFacets ?? []) as CatalogSpecFacet[]);
      this.brandFacets.set(payload.brandFacets ?? []);
      this.currentPage.set(1);
      this.loadingMore.set(false);
      this.loading.set(false);
      this.readQueryParams();
      this.applyMeta();
      this.applyJsonLd();
    });
  }

  ngOnInit(): void {
    this.readQueryParams();
    /**
     * SH4 — meta + JSON-LD apply synchronously after signal seeding (per
     * `agent_docs/storefront/ssr-data-loading.md` `## Per-page recipe` +
     * clarifications Q-2). With the `injectLoad` payload seeded by field-
     * initialiser time, both calls emit complete tags on the SSR pass and
     * the browser hydrate matches byte-for-byte.
     */
    this.applyMeta();
    this.applyJsonLd();

    if (!isPlatformBrowser(this.platformId)) return;
    // Deep-link `?page=N>1` — page 1 is already seeded, so restore pages 2..N.
    const pageParam = this.route.snapshot.queryParamMap.get('page');
    const requested = pageParam ? Math.max(1, Number(pageParam) || 1) : 1;
    if (requested > 1) {
      void this.restoreFromPage2(requested);
    }
  }

  protected onSortChange(change: CatalogSortChange): void {
    this.currentSortKey.set(change.key);
    this.navigateToQuery({
      sortBy: change.sortBy,
      sortOrder: change.sortOrder,
      page: 1,
    });
  }

  protected onFilterChange(change: CatalogFilterChange): void {
    this.currentFilterState.set({
      brand: change.brand,
      priceBand: change.priceBand,
      specs: groupSpecTokens(change.specs),
    });
    this.navigateToQuery({
      brand: change.brand,
      minPrice: change.minPrice,
      maxPrice: change.maxPrice,
      specs: change.specs.length ? change.specs.join(',') : null,
      page: 1,
    });
  }

  /**
   * Navigate to the new query string and let the resolver deliver the grid.
   *
   * `loading` is raised here and cleared by the re-seed effect. The two escape
   * hatches cover the cases where no payload will arrive: a cancelled or failed
   * navigation, and a gesture that lands on the URL the page is already on,
   * which re-runs no resolver.
   */
  private navigateToQuery(queryParams: Record<string, string | number | null>): void {
    const before = this.loaded();
    this.loading.set(true);
    void this.router
      .navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge' })
      .then((navigated) => {
        if (!navigated || this.loaded() === before) this.loading.set(false);
      })
      .catch(() => this.loading.set(false));
  }

  protected onLoadMore(): void {
    void this.loadNextPage();
  }

  private readQueryParams(): void {
    const q = this.route.snapshot.queryParamMap;
    const sortBy = q.get('sortBy') ?? undefined;
    const sortOrder = q.get('sortOrder') ?? undefined;
    this.currentSortKey.set(catalogSortKeyFromQuery(sortBy, sortOrder));
    const minPrice = q.get('minPrice') ? Number(q.get('minPrice')) : null;
    const maxPrice = q.get('maxPrice') ? Number(q.get('maxPrice')) : null;
    const priceBand = PRICE_BAND_FROM_QUERY(minPrice, maxPrice);
    const brand = q.get('brand');
    this.currentFilterState.set({ brand, priceBand, specs: readSpecParam(q.get('specs')) });
  }

  /** Retry surface for the load-error block. The only browser-side first-page
   * fetch left: every other path comes back through the route loader. */
  protected retry(): void {
    void this.loadFirstPage();
  }

  /** First-page fetch, used by the retry only. Replaces the items signal. */
  private async loadFirstPage(): Promise<void> {
    const cat = this.category();
    if (!cat) return;
    const seq = ++this.requestSeq;
    this.products.set([]);
    this.currentPage.set(1);
    this.loadingMore.set(false);
    this.loading.set(true);
    try {
      const result = await this.productsSvc.list(this.buildListQuery(cat.id, 1));
      if (seq !== this.requestSeq) return;
      this.products.set(result.data);
      this.totalCount.set(result.meta.total ?? result.data.length);
      this.productsError.set(false);
    } catch {
      if (seq !== this.requestSeq) return;
      // Raise the flag rather than emptying the grid: an outage is not an
      // empty category (finding C10).
      this.products.set([]);
      this.totalCount.set(0);
      this.productsError.set(true);
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }

  /** Append the next page beneath the current grid. */
  private async loadNextPage(): Promise<void> {
    const cat = this.category();
    if (!cat) return;
    if (!this.hasMore() || this.loading() || this.loadingMore()) return;
    const seq = ++this.requestSeq;
    const nextPage = this.currentPage() + 1;
    this.loadingMore.set(true);
    try {
      const result = await this.productsSvc.list(this.buildListQuery(cat.id, nextPage));
      if (seq !== this.requestSeq) return;
      this.products.update((prev) => [...prev, ...result.data]);
      this.totalCount.set(result.meta.total ?? this.totalCount());
      this.currentPage.set(nextPage);
      this.replacePageInUrl(nextPage);
    } catch {
      // Append failure leaves existing items untouched.
    } finally {
      if (seq === this.requestSeq) this.loadingMore.set(false);
    }
  }

  /** Initial-load deep-link restoration starting from page 2. Page 1 is
   * already seeded from the SSR payload, so this only fetches pages 2..N. */
  private async restoreFromPage2(target: number): Promise<void> {
    const cat = this.category();
    if (!cat) return;
    const cap = Math.min(target, MAX_RESTORE_PAGES);
    if (cap < 2) return;
    const seq = ++this.requestSeq;
    this.loadingMore.set(true);
    try {
      for (let page = 2; page <= cap; page += 1) {
        const result = await this.productsSvc.list(this.buildListQuery(cat.id, page));
        if (seq !== this.requestSeq) return;
        this.products.update((prev) => [...prev, ...result.data]);
        this.totalCount.set(result.meta.total ?? this.totalCount());
        this.currentPage.set(page);
        if (this.products().length >= this.totalCount()) break;
      }
      if (seq !== this.requestSeq) return;
      this.replacePageInUrl(this.currentPage());
    } catch {
      // Restore failure leaves whatever pages did land in place.
    } finally {
      if (seq === this.requestSeq) this.loadingMore.set(false);
    }
  }

  private buildListQuery(categoryId: string, page: number): ListProductsQuery {
    const q = this.route.snapshot.queryParamMap;
    const query: ListProductsQuery = {
      categoryId,
      page,
      pageSize: PAGE_SIZE,
    };
    // Always send a sort. Unset, the API falls back to `sortOrder asc` over
    // rows that all have sortOrder 0, so the grid order is unspecified while
    // the select still reads "Newest" (finding C7).
    const sort = resolveCatalogSort(q.get('sortBy'), q.get('sortOrder'));
    query.sortBy = sort.sortBy;
    query.sortOrder = sort.sortOrder;
    const brand = q.get('brand');
    if (brand) query.brand = brand;
    const minPrice = q.get('minPrice');
    const maxPrice = q.get('maxPrice');
    if (minPrice) query.minPrice = Number(minPrice);
    if (maxPrice) query.maxPrice = Number(maxPrice);
    const specs = q.get('specs');
    if (specs) query.specs = specs;
    return query;
  }

  private replacePageInUrl(page: number): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const loc = globalThis.location;
    const hist = globalThis.history;
    if (!loc || !hist || typeof hist.replaceState !== 'function') return;
    const url = new URL(loc.href);
    url.searchParams.set('page', String(page));
    hist.replaceState(hist.state, '', `${url.pathname}${url.search}${url.hash}`);
  }

  private toCardData(p: ProductSummary): ProductCardData {
    const variant = p.variants?.[0];
    // No literal-zero floor: a row with no resolvable price renders no price line
    // rather than a wrong one. See `ProductCardData.price`.
    const price =
      variant?.price != null
        ? Number(variant.price)
        : p.minPrice != null
          ? Number(p.minPrice)
          : null;
    const compareAt = variant?.compareAtPrice != null ? Number(variant.compareAtPrice) : null;
    const primary = p.primaryAsset ?? p.assets?.find((a) => a.isPrimary) ?? p.assets?.[0];
    const imageSrc = primary?.url || noImageFallback();
    const imageAlt =
      pickTranslation((primary?.altText ?? null) as ResolvedString | null, this.locale()) ||
      pickTranslation(p.name as ResolvedString, this.locale());
    const cardSizes = '(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw';
    const imageSources = pictureSourcesFromAssetVariants(primary?.assetVariants, cardSizes);
    return {
      productId: p.id,
      slug: p.slug,
      title: pickTranslation(p.name as ResolvedString, this.locale()),
      href: APP_ROUTES.product(this.locale(), p.slug),
      imageSrc,
      imageAlt,
      imageSources: imageSources.length > 0 ? imageSources : undefined,
      price,
      compareAtPrice: compareAt,
      currency: p.currency ?? this.storeConfig.currencyCode(),
      availability: productAvailability(p.variants),
      deliveryEstimate: this.strings().product.delivery.estimate,
    };
  }

  private applyJsonLd(): void {
    const head = this.document.head;
    if (!head) return;
    head
      .querySelectorAll<HTMLScriptElement>(
        'script[type="application/ld+json"][data-catalog-jsonld]',
      )
      .forEach((node) => node.remove());
    const baseUrl = this.resolveBaseUrl();
    const breadcrumbItems = this.breadcrumb()
      .filter((b) => !!b.href)
      .map((b) => ({ name: b.label, url: this.absoluteUrl(baseUrl, b.href!) }));
    const last = this.breadcrumb()[this.breadcrumb().length - 1];
    if (last && !last.href) {
      breadcrumbItems.push({
        name: last.label,
        url: this.absoluteUrl(baseUrl, APP_ROUTES.catalog(this.locale(), this.slug())),
      });
    }
    if (breadcrumbItems.length > 0) {
      const script = this.document.createElement('script');
      script.setAttribute('type', 'application/ld+json');
      script.setAttribute('data-catalog-jsonld', 'true');
      script.textContent = serializeJsonLd(breadcrumbListJsonLd(breadcrumbItems));
      head.appendChild(script);
    }
    // Cap at PAGE_SIZE: appended pages do not mutate the structured data so
    // crawlers see a stable, deterministic ItemList. Mirrors Google's
    // published guidance for infinite-scroll surfaces.
    const items = this.firstPageItems();
    if (items.length > 0) {
      const script = this.document.createElement('script');
      script.setAttribute('type', 'application/ld+json');
      script.setAttribute('data-catalog-jsonld', 'true');
      script.textContent = serializeJsonLd(
        itemListJsonLd(
          items.map((p) => ({
            slug: p.slug,
            name: pickTranslation(p.name as ResolvedString, this.locale()),
          })),
          this.locale(),
          baseUrl,
        ),
      );
      head.appendChild(script);
    }
  }

  private applyMeta(): void {
    const cat = this.category();
    const locale = this.locale();
    const baseUrl = this.resolveBaseUrl();
    const slug = this.slug();

    if (slug) {
      const tags = categoryMetaTags({
        locale,
        baseUrl,
        locales: this.storeConfig.seoLocales(),
        identity: this.localeService.chromeIdentity(),
        slug,
        // Stub name keeps `categoryMetaTags` deterministic when the category
        // is null (browser-only sibling-slug nav transient) — canonical and
        // hreflang derive from locale + slug only and stay correct.
        name: (cat?.name ?? '') as ResolvedString,
        description: (cat?.description ?? null) as ResolvedString | null,
      });
      this.upsertCanonical(tags.canonical);
      this.upsertHreflang(tags.hreflang);

      // Full meta requires the category name, which the loader payload always
      // carries. The re-seed effect calls `applyMeta()` + `applyJsonLd()` again
      // on every resolver emission, so a sibling-slug navigation refreshes
      // canonical, OG and the BreadcrumbList for the active leaf.
      if (cat) {
        this.title.setTitle(pageTitle(tags.title, this.strings().brand.name));
        this.upsertNamed('description', tags.description);
        this.upsertProperty('og:title', tags.og.title);
        this.upsertProperty('og:description', tags.og.description);
        this.upsertProperty('og:image', tags.og.image);
        this.upsertProperty('og:url', tags.og.url);
        this.upsertProperty('og:locale', tags.og.locale);
        upsertPropertyMulti(this.document, 'og:locale:alternate', tags.og.localeAlternate);
        this.upsertProperty('og:type', tags.og.type);
        this.upsertNamed('twitter:card', tags.twitter.card);
        this.upsertNamed('twitter:title', tags.twitter.title);
        this.upsertNamed('twitter:description', tags.twitter.description);
        this.upsertNamed('twitter:image', tags.twitter.image);
      }
    }
  }

  private upsertCanonical(href: string): void {
    const head = this.document.head;
    if (!head) return;
    let link = head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      head.appendChild(link);
    }
    link.setAttribute('href', href);
  }

  private upsertHreflang(items: { hreflang: string; href: string }[]): void {
    const head = this.document.head;
    if (!head) return;
    head
      .querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]')
      .forEach((node) => node.remove());
    for (const item of items) {
      const link = this.document.createElement('link');
      link.setAttribute('rel', 'alternate');
      link.setAttribute('hreflang', item.hreflang);
      link.setAttribute('href', item.href);
      head.appendChild(link);
    }
  }

  private upsertNamed(name: string, content: string): void {
    const selector = `name="${name}"`;
    if (this.meta.getTag(selector)) {
      this.meta.updateTag({ name, content }, selector);
    } else {
      this.meta.addTag({ name, content });
    }
  }

  private upsertProperty(property: string, content: string): void {
    const selector = `property="${property}"`;
    if (this.meta.getTag(selector)) {
      this.meta.updateTag({ property, content }, selector);
    } else {
      this.meta.addTag({ property, content });
    }
  }

  private resolveBaseUrl(): string {
    if (isPlatformBrowser(this.platformId)) {
      return globalThis.location?.origin ?? 'http://localhost:53300';
    }
    if (isPlatformServer(this.platformId) && typeof process !== 'undefined') {
      return process.env['STOREFRONT_PUBLIC_BASE_URL'] ?? 'http://localhost:53300';
    }
    return 'http://localhost:53300';
  }

  private absoluteUrl(base: string, path: string): string {
    const trimmed = base.replace(/\/$/, '');
    return path.startsWith('http') ? path : `${trimmed}${path.startsWith('/') ? '' : '/'}${path}`;
  }
}

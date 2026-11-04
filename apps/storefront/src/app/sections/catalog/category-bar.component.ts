import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { pickTranslation, type Category, type ResolvedString } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { CategoryNavService } from '../../services/category-nav.service';
import { APP_ROUTES } from '../../../lib/routes';

interface FlatCategory {
  id: string;
  slug: string;
  parentId: string | null;
  label: string;
  href: string;
  /** `card`-intent URL the API resolved from `Category.imageId`, when present. */
  imageUrl: string | null;
}

interface ChipEntry {
  id: string;
  slug: string;
  label: string;
  href: string;
  imageUrl: string | null;
}

/**
 * Horizontal chip strip rendering top-level categories with an "All" entry,
 * plus a second chip strip showing the active parent's children when one is
 * selected.
 *
 * - Sourced from `CategoriesService.list()`. Top-level entries (parentId
 *   null) anchor the primary strip; their `children` arrays anchor the
 *   subcategory strip.
 * - Active state: a single `activeSlug` input. Resolves to a parent (when
 *   the slug is itself top-level OR is a child whose `parentId` matches a
 *   top-level entry) so the parent chip stays highlighted while a child is
 *   selected. The child chip carries its own `aria-current="page"`.
 * - Renders nothing on SSR and hydrates on the browser so no API call lands
 *   in the SSR critical path. Catalog pages still anchor first paint via
 *   their breadcrumb + heading.
 */
@Component({
  selector: 'catalog-category-bar',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="bar" [attr.aria-label]="strings().catalog.categoryBar.navLabel">
      <ul class="list" role="list">
        <li class="item">
          <a
            class="chip"
            [class.is-active]="isAllActive()"
            [routerLink]="allHref()"
            [attr.aria-current]="isAllActive() ? 'page' : null"
          >
            {{ strings().catalog.categoryBar.all }}
          </a>
        </li>
        @for (entry of topLevelEntries(); track entry.id) {
          <li class="item">
            <a
              class="chip"
              [class.is-active]="entry.slug === activeParentSlug()"
              [routerLink]="entry.href"
              [attr.aria-current]="
                entry.slug === activeParentSlug() && entry.slug === activeSlug() ? 'page' : null
              "
            >
              @if (entry.imageUrl) {
                <span class="thumb" aria-hidden="true">
                  <img [src]="entry.imageUrl" alt="" loading="lazy" decoding="async" />
                </span>
              }
              {{ entry.label }}
            </a>
          </li>
        }
      </ul>
      @if (subEntries().length > 0) {
        <ul
          class="list sub-list"
          role="list"
          [attr.aria-label]="strings().catalog.categoryBar.subNavLabel"
          data-testid="catalog-category-bar-subs"
        >
          @for (entry of subEntries(); track entry.id) {
            <li class="item">
              <a
                class="chip chip--sub"
                [class.is-active]="entry.slug === activeSlug()"
                [routerLink]="entry.href"
                [attr.aria-current]="entry.slug === activeSlug() ? 'page' : null"
              >
                @if (entry.imageUrl) {
                  <span class="thumb" aria-hidden="true">
                    <img [src]="entry.imageUrl" alt="" loading="lazy" decoding="async" />
                  </span>
                }
                {{ entry.label }}
              </a>
            </li>
          }
        </ul>
      }
    </nav>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .bar {
        inline-size: 100%;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .list {
        list-style: none;
        margin: 0;
        padding-block: 0.25rem;
        display: flex;
        gap: 0.5rem;
        overflow-x: auto;
        scrollbar-width: thin;
      }
      .item {
        flex: 0 0 auto;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        min-block-size: 36px;
        padding-block: 0.375rem;
        padding-inline: 0.875rem;
        font-size: var(--brand-text-micro);
        font-weight: 500;
        color: var(--brand-text);
        background-color: var(--brand-surface);
        border: 1px solid var(--brand-border-strong);
        border-radius: var(--brand-radius-full);
        text-decoration: none;
        white-space: nowrap;
      }
      /* 24 px decorative thumbnail of the operator's category image. Sits
         inside an aria-hidden span, so the chip label stays the accessible
         name of the link. */
      .thumb {
        display: inline-flex;
        inline-size: 24px;
        block-size: 24px;
        margin-inline-end: 0.5rem;
        margin-inline-start: -0.25rem;
        border-radius: var(--brand-radius-full);
        overflow: hidden;
        shrink: 0;
      }
      .thumb img {
        inline-size: 100%;
        block-size: 100%;
        object-fit: cover;
      }
      .chip:hover {
        background-color: var(--brand-surface-strong);
      }
      .chip:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .chip.is-active {
        color: var(--brand-on-primary);
        background-color: var(--brand-primary-dark);
        border-color: var(--brand-primary);
      }
      .chip--sub {
        min-block-size: 32px;
        padding-block: 0.25rem;
        padding-inline: 0.75rem;
        font-weight: 400;
      }
      .chip--sub.is-active {
        color: var(--brand-on-primary);
        background-color: var(--brand-primary-dark, var(--brand-primary));
      }
    `,
  ],
})
export class CategoryBarComponent implements OnInit {
  /** Slug of the active category — null/empty marks the "All" chip active. */
  readonly activeSlug = input<string | null>(null);

  private readonly localeService = inject(LocaleService);
  private readonly categoryNav = inject(CategoryNavService);

  protected readonly strings = this.localeService.strings;
  protected readonly locale = this.localeService.locale;

  /**
   * Shared with the header's catalogue nav (plan N5): a catalog page mounts
   * both, and two components each holding their own copy meant two fetches of
   * the same tree per page load.
   */
  private readonly categories = this.categoryNav.categories;

  protected readonly allHref = computed(() => APP_ROUTES.catalog(this.locale()));

  protected readonly isAllActive = computed(() => {
    const slug = this.activeSlug();
    return slug == null || slug === '';
  });

  /** Flatten the (possibly nested) tree once per locale change so children
   * coming back as `parent.children = [...]` are reachable for active-parent
   * resolution and for the subcategory strip. */
  private readonly flat = computed<FlatCategory[]>(() => {
    const locale = this.locale();
    const out: FlatCategory[] = [];
    const seen = new Set<string>();
    const visit = (cat: Category, fallbackParentId: string | null): void => {
      if (seen.has(cat.id)) return;
      seen.add(cat.id);
      const parentId = cat.parentId ?? fallbackParentId;
      out.push({
        id: cat.id,
        slug: cat.slug,
        imageUrl: typeof cat.imageUrl === 'string' ? cat.imageUrl : null,
        parentId,
        label: pickTranslation(cat.name as ResolvedString, locale),
        href: APP_ROUTES.catalog(locale, cat.slug),
      });
      const children = (cat as { children?: Category[] }).children ?? [];
      for (const child of children) visit(child, cat.id);
    };
    for (const cat of this.categories()) visit(cat, null);
    return out;
  });

  protected readonly topLevelEntries = computed<ChipEntry[]>(() =>
    this.flat()
      .filter((c) => c.parentId == null)
      .map(({ id, slug, label, href, imageUrl }) => ({ id, slug, label, href, imageUrl })),
  );

  /** Slug of the active parent — equals `activeSlug` when that slug is
   * top-level, walks up via `parentId` when it's a child. */
  protected readonly activeParentSlug = computed<string | null>(() => {
    const slug = this.activeSlug();
    if (!slug) return null;
    const flat = this.flat();
    const active = flat.find((c) => c.slug === slug);
    if (!active) return null;
    if (active.parentId == null) return active.slug;
    const parent = flat.find((c) => c.id === active.parentId);
    return parent?.slug ?? null;
  });

  protected readonly subEntries = computed<ChipEntry[]>(() => {
    const parentSlug = this.activeParentSlug();
    if (!parentSlug) return [];
    const flat = this.flat();
    const parent = flat.find((c) => c.slug === parentSlug);
    if (!parent) return [];
    return flat
      .filter((c) => c.parentId === parent.id)
      .map(({ id, slug, label, href, imageUrl }) => ({ id, slug, label, href, imageUrl }));
  });

  ngOnInit(): void {
    // Browser-only and deduped inside the service, so a second consumer costs
    // nothing and SSR still dispatches no request.
    void this.categoryNav.load();
  }
}

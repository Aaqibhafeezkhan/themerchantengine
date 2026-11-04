import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { SkeletonComponent } from '@admin-ui';
import { humanizeCode } from '../../shared/format/enum-label';
import { StorefrontConfigService } from '@admin-services';
import { ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';

/**
 * `/storefront` — catalog of storefront pages known to the configurator.
 * Backend returns a plain `string[]` of page slugs; each one drills into
 * its own sections list at `/storefront/:slug`.
 */
@Component({
  selector: 'app-storefront-pages-list-page',
  standalone: true,
  imports: [RouterLink, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="p-6 md:p-10 flex flex-col gap-8" data-testid="storefront-pages-list-page">
      <header>
        <p class="text-xs tracking-widest uppercase text-ink-muted">Storefront</p>
        <h1 class="mt-2 text-4xl md:text-5xl font-bold tracking-tight">Storefront pages</h1>
        <p class="mt-3 tabular text-sm text-ink-muted max-w-xl">
          Each page hosts a stack of configurable sections — hero, product grids, banners. Pick a
          page to manage its layout.
        </p>
      </header>

      <div role="status" aria-live="polite" data-testid="storefront-pages-error">
        @if (error()) {
          <p class="border border-status-error text-ink p-3 tabular text-xs">
            {{ error() }}
          </p>
        }
      </div>

      @if (loading()) {
        <div class="flex flex-col gap-4">
          <app-skeleton height="2rem" width="30%" />
          <app-skeleton height="10rem" width="100%" />
        </div>
      } @else if (slugs().length === 0) {
        <p class="tabular text-sm text-ink-muted" data-testid="storefront-pages-empty">
          No storefront pages defined yet.
        </p>
      } @else {
        <ul class="border border-line" role="list" data-testid="storefront-pages-list">
          @for (slug of slugs(); track slug) {
            <li class="border-b border-line last:border-b-0">
              <a
                [routerLink]="['/storefront', slug]"
                class="flex items-center justify-between gap-4 px-5 py-4 hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
                [attr.data-testid]="'storefront-page-link-' + slug"
              >
                <span class="flex flex-col gap-1 min-w-0">
                  <span class="text-sm text-ink">{{ pageName(slug) }}</span>
                  <span class="font-mono text-xs text-ink-muted">/{{ slug }}</span>
                </span>
                <span class="text-xs tracking-widest uppercase text-ink-muted">
                  Manage sections →
                </span>
              </a>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class StorefrontPagesListPage implements OnInit, OnDestroy {
  private readonly service = inject(StorefrontConfigService);
  private readonly destroy$ = new Subject<void>();

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly slugs = signal<string[]>([]);

  /** The API returns slugs only, so the readable name is derived here. */
  pageName(slug: string): string {
    return humanizeCode(slug, slug);
  }

  ngOnInit(): void {
    this.service
      .listPages()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.slugs.set(res.data);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private formatError(err: unknown): string {
    if (err instanceof ApiForbiddenError)
      return 'You do not have permission to view storefront pages.';
    if (err instanceof ApiNotFoundError) return 'Pages not found.';
    if (err instanceof ApiError && err.message) return err.message;
    return 'Could not load pages. Please retry.';
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BadgeComponent, type BadgeTone, ButtonComponent, SkeletonComponent } from '@admin-ui';
import { SeoService, type SeoUrlInspection } from '@admin-services';
import { ApiError, ApiForbiddenError } from '@admin-types';

/**
 * Per-product Google index-state badge (DR-17 D5). Lazy-on-click ONLY — it fires
 * NO request on init (plan §8/§12: never inspect on a page load, the daily 2 000/
 * property inspect budget is the scarcest SEO resource). On click it reads Google's
 * last-known index state (a READ via URL Inspection, never a recrawl). Degrades
 * gracefully: `disabled` (GSC not connected), `exhausted` (budget spent),
 * `error` — never a spinner or a leaked stack trace. Copy is "Google's last-known
 * index state," never "reindex."
 */
@Component({
  selector: 'app-seo-index-state-badge',
  standalone: true,
  imports: [BadgeComponent, ButtonComponent, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex flex-col gap-3"
      data-testid="seo-index-state"
      [attr.aria-busy]="loading() ? 'true' : null"
    >
      <p class="sr-only" role="status" aria-live="polite" data-testid="seo-index-state-status">
        {{ announcement() ?? '' }}
      </p>

      <div class="flex items-center gap-3 flex-wrap">
        <app-button
          variant="secondary"
          size="sm"
          [disabled]="loading()"
          (clicked)="check()"
          data-testid="seo-index-state-check"
        >
          {{ buttonLabel() }}
        </app-button>
        @if (result(); as r) {
          @if (r.state === 'ok') {
            <app-badge
              [tone]="verdictTone(r.verdict)"
              [ariaLabel]="'Google index verdict: ' + verdictLabel(r.verdict)"
              data-testid="seo-index-state-verdict"
            >
              {{ verdictLabel(r.verdict) }}
            </app-badge>
          }
        }
      </div>

      <p class="text-xs text-ink-muted">
        Google's last-known index state — read-only, not a recrawl request.
      </p>

      @if (loading()) {
        <app-skeleton height="2rem" width="60%" />
      } @else if (httpError(); as msg) {
        <p
          class="border border-status-error text-ink p-3 tabular text-xs"
          role="alert"
          data-testid="seo-index-state-http-error"
        >
          {{ msg }}
        </p>
      } @else if (result(); as r) {
        @switch (r.state) {
          @case ('ok') {
            <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="seo-index-state-detail">
              <div class="border border-line p-3">
                <dt class="text-xs tracking-widest uppercase text-ink-muted">Coverage</dt>
                <dd class="mt-1 text-sm text-ink wrap-break-word">
                  {{ dash(r.coverageState) }}
                </dd>
              </div>
              <div class="border border-line p-3">
                <dt class="text-xs tracking-widest uppercase text-ink-muted">Indexing</dt>
                <dd class="mt-1 text-sm text-ink wrap-break-word">
                  {{ dash(r.indexingState) }}
                </dd>
              </div>
              <div class="border border-line p-3">
                <dt class="text-xs tracking-widest uppercase text-ink-muted">robots.txt</dt>
                <dd class="mt-1 text-sm text-ink wrap-break-word">
                  {{ dash(r.robotsTxtState) }}
                </dd>
              </div>
              <div class="border border-line p-3">
                <dt class="text-xs tracking-widest uppercase text-ink-muted">Last crawl</dt>
                <dd class="mt-1 text-sm text-ink tabular-nums wrap-break-word">
                  {{ dash(r.lastCrawlTime) }}
                </dd>
              </div>
              <div class="border border-line p-3 sm:col-span-2">
                <dt class="text-xs tracking-widest uppercase text-ink-muted">Google canonical</dt>
                <dd class="mt-1 text-sm text-ink break-all">
                  {{ dash(r.googleCanonical) }}
                </dd>
              </div>
            </dl>
          }
          @case ('disabled') {
            <p class="tabular text-sm text-ink-muted" data-testid="seo-index-state-disabled">
              Search Console is not connected, so Google's index state is unavailable.
            </p>
          }
          @case ('exhausted') {
            <p class="tabular text-sm text-ink-muted" data-testid="seo-index-state-exhausted">
              Daily inspection budget reached ({{ r.inspectUsed }}/{{ r.inspectCap }}). Try again
              tomorrow.
            </p>
          }
          @case ('error') {
            <p
              class="border border-status-error text-ink p-3 tabular text-xs"
              role="alert"
              data-testid="seo-index-state-error"
            >
              Could not read the index state. {{ r.detail }}
            </p>
          }
        }
      }
    </div>
  `,
})
export class SeoIndexStateBadgeComponent {
  private readonly seoService = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  readonly productId = input.required<string>();

  readonly loading = signal(false);
  readonly result = signal<SeoUrlInspection | null>(null);
  /** A transport-level failure (forbidden / malformed response), distinct from a
   * degrade `state:'error'` the endpoint returns with a 200. */
  readonly httpError = signal<string | null>(null);
  /** Polite sr-only announcement so a completed inspection is not silent to a
   * screen reader (WCAG 2.2 SC 4.1.3). The error paths announce via role="alert"
   * already, so this carries the ok/disabled/exhausted outcomes only. */
  readonly announcement = signal<string | null>(null);

  protected buttonLabel(): string {
    if (this.loading()) return 'Checking…';
    return this.result() || this.httpError()
      ? 'Re-check index status'
      : 'Check Google index status';
  }

  check(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.httpError.set(null);
    this.announcement.set(null);
    this.seoService
      .inspectUrl({ productId: this.productId() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.result.set(r);
          this.loading.set(false);
          this.announcement.set(this.announceFor(r));
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.result.set(null);
          this.httpError.set(this.formatError(err));
        },
      });
  }

  /** Polite announcement for a completed inspection. The `error` degrade and a
   * transport error both render `role="alert"`, so this returns null for them to
   * avoid a double-announcement. */
  private announceFor(r: SeoUrlInspection): string | null {
    switch (r.state) {
      case 'ok':
        return `Index state: ${this.verdictLabel(r.verdict)}`;
      case 'disabled':
        return 'Search Console is not connected';
      case 'exhausted':
        return `Inspection budget exhausted (${r.inspectUsed ?? 0} of ${r.inspectCap ?? 0})`;
      default:
        return null;
    }
  }

  protected verdictTone(verdict: string | null): BadgeTone {
    switch (verdict) {
      case 'PASS':
        return 'success';
      case 'PARTIAL':
        return 'warning';
      case 'FAIL':
        return 'error';
      default:
        return 'neutral';
    }
  }

  protected verdictLabel(verdict: string | null): string {
    switch (verdict) {
      case 'PASS':
        return 'Pass';
      case 'PARTIAL':
        return 'Partial';
      case 'FAIL':
        return 'Fail';
      default:
        return 'Unknown';
    }
  }

  protected dash(value: string | null): string {
    return value ?? '—';
  }

  private formatError(err: unknown): string {
    if (err instanceof ApiForbiddenError)
      return 'You do not have permission to read the index state.';
    if (err instanceof ApiError && err.message) return err.message;
    return 'Could not read the index state. Please retry.';
  }
}

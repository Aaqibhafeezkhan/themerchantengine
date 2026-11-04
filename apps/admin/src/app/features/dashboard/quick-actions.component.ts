import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../../core/stores/auth.store';

export interface QuickAction {
  label: string;
  to: string;
  permission: string;
  /**
   * Hide the action regardless of permission. Used while the backing route
   * 404s; the owning phase flips this to `false` (or deletes the flag) when
   * the route lands.
   */
  hidden?: boolean;
}

/**
 * Permission-filtered quick-action shortcuts. Shows up to ~6 top-of-mind
 * entry points for common admin workflows. Each shortcut's `permission`
 * gates visibility via `AuthStore.hasPermission`.
 *
 * Kept inline (no global config) so reordering or adding a shortcut is a
 * one-file diff — the nav has its own concerns (all routes, grouped,
 * navigational) that don't map cleanly to "what do you want to do next?"
 */
@Component({
  selector: 'app-quick-actions',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible().length > 0) {
      <section
        class="border border-line bg-surface"
        data-testid="dashboard-quick-actions"
        aria-labelledby="quick-actions-heading"
      >
        <header class="px-5 py-4 border-b border-line">
          <h2 id="quick-actions-heading" class="text-xs tracking-widest uppercase text-ink-muted">
            Quick actions
          </h2>
        </header>
        <ul class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-line">
          @for (action of visible(); track action.to) {
            <li class="sm:min-h-[64px]">
              <a
                [routerLink]="action.to"
                class="flex items-center px-5 py-4 text-sm text-ink hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
                [attr.data-testid]="'quick-action-' + testSuffix(action.to)"
              >
                <span>{{ action.label }}</span>
              </a>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class QuickActionsComponent {
  private readonly store = inject(AuthStore);

  /**
   * Shortcut catalog. Keep this list short (≤ 6) — this is "jump to the
   * screen the user most likely wants next", not a secondary nav.
   */
  readonly actions: readonly QuickAction[] = [
    { label: 'New product', to: '/products/new', permission: 'products:create' },
    { label: 'New promotion', to: '/promotions/new', permission: 'promotions:create' },
    { label: 'Issue gift card', to: '/gift-cards/issue', permission: 'gift_cards:create' },
    { label: 'Review queue', to: '/reviews', permission: 'reviews:update' },
    { label: 'Returns to process', to: '/returns', permission: 'returns:update' },
    { label: 'Create redirect', to: '/seo/redirects/new', permission: 'seo:create' },
  ] as const;

  readonly visible = computed(() =>
    this.actions.filter((a) => !a.hidden && this.store.hasPermission(a.permission)),
  );

  testSuffix(to: string): string {
    return to.replace(/^\//, '').replace(/\//g, '-');
  }
}

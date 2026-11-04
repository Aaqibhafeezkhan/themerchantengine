import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../../core/stores/auth.store';

/**
 * Topbar account menu. Before this existed `/me` and `/me/security` were
 * registered routes reachable from nowhere, so an operator could not open their
 * own profile or enrol two-factor authentication (finding D5).
 *
 * Built on `@angular/cdk/menu` for focus management, arrow-key navigation,
 * Esc-to-close and click-outside close. Sign out deliberately stays its own
 * button in the topbar: it is one click today and every logout journey depends
 * on it.
 */
@Component({
  selector: 'app-topbar-account-menu',
  standalone: true,
  imports: [RouterLink, CdkMenu, CdkMenuItem, CdkMenuTrigger],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="inline-flex items-center gap-2 h-10 px-2 md:px-3 max-w-56 border border-line text-xs uppercase tracking-widest text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
      [cdkMenuTriggerFor]="accountMenu"
      aria-haspopup="menu"
      [attr.aria-label]="'Account: ' + displayName()"
      data-testid="topbar-account"
    >
      <span class="hidden md:inline truncate">{{ displayName() }}</span>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <ng-template #accountMenu>
      <div
        cdkMenu
        class="min-w-56 border border-line bg-surface py-1"
        aria-label="Account"
        data-testid="topbar-account-menu"
      >
        <a
          cdkMenuItem
          routerLink="/me"
          class="flex items-center min-h-[44px] px-4 text-xs uppercase tracking-widest text-ink hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
          data-testid="topbar-account-profile"
        >
          My profile
        </a>
        <a
          cdkMenuItem
          routerLink="/me/security"
          class="flex items-center min-h-[44px] px-4 text-xs uppercase tracking-widest text-ink hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
          data-testid="topbar-account-security"
        >
          Two-factor authentication
        </a>
      </div>
    </ng-template>
  `,
})
export class TopbarAccountMenuComponent {
  private readonly authStore = inject(AuthStore);

  /** Name first, email second: never the raw user id (plan B class). */
  readonly displayName = computed(() => {
    const user = this.authStore.user();
    if (!user) return 'Account';
    const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    return full || user.email || 'Account';
  });
}

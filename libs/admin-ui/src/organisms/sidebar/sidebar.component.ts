import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

export interface NavItem {
  /** Display label. */
  label: string;
  /** Router path. */
  to: string;
  /** Required permission to show this item. Undefined = always show. */
  permission?: string;
  /** Optional short hint (shortcut, count, etc.). */
  hint?: string;
  /**
   * Hide from the rendered sidebar regardless of permission. Used to keep an
   * entry in the config file (so the owning phase can flip it back) while the
   * backing route 404s.
   */
  hidden?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Presentational sidebar. Nav groups are passed in by the app shell, which
 * filters them by the user's permissions. Active state via RouterLinkActive.
 * On mobile this component is rendered inside a CDK drawer; on desktop it
 * sits in the left column of AppShell.
 */
@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav
      class="flex flex-col gap-8 p-4 text-ink h-full overflow-y-auto"
      [attr.aria-label]="ariaLabel()"
      data-testid="sidebar-nav"
    >
      <a
        routerLink="/"
        [routerLinkActiveOptions]="{ exact: true }"
        routerLinkActive="text-ink-emphasis"
        class="flex items-center gap-3 px-3 py-2 focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
        (click)="navItemClicked.emit()"
      >
        <span aria-hidden="true" class="inline-block w-3 h-3 bg-brand-mark shrink-0"></span>
        <span class="text-base font-bold uppercase tracking-tight whitespace-nowrap"
          >The Merchant Engine</span
        >
      </a>

      @for (group of groups(); track group.label) {
        <section class="flex flex-col gap-1">
          <p class="px-3 text-ink-muted text-xs tracking-widest uppercase mb-1">
            {{ group.label }}
          </p>
          @for (item of group.items; track item.to) {
            <a
              [routerLink]="item.to"
              routerLinkActive="bg-surface-elevated text-ink-emphasis"
              [routerLinkActiveOptions]="{ exact: item.to === '/' }"
              class="flex items-center justify-between px-3 py-2 min-h-[44px] text-sm text-ink hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
              (click)="navItemClicked.emit()"
            >
              <span>{{ item.label }}</span>
              @if (item.hint) {
                <span class="text-ink-muted text-xs tabular">{{ item.hint }}</span>
              }
            </a>
          }
        </section>
      }
    </nav>
  `,
})
export class SidebarComponent {
  readonly groups = input.required<NavGroup[]>();
  readonly ariaLabel = input<string>('Primary navigation');
  readonly navItemClicked = output<void>();
}

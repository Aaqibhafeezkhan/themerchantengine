import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SkeletonComponent } from '@admin-ui';
import { AdminDatePipe } from '../../shared/pipes/admin-date.pipe';

export interface ActivityItem {
  id: string;
  /** Ready-to-read sentence ("Super Admin deleted a webhook"), composed upstream. */
  sentence: string;
  /** Raw audit fields, also the drill-down target when `linkable` is on. */
  action: string;
  entityType: string;
  entityId: string | null;
  at: string | null;
  actor: string | null;
}

/**
 * Activity feed — renders the recent audit-log slice for the admin who
 * opens the dashboard. Purely presentational: the dashboard page owns the
 * fetch + loading state and feeds a signal down.
 *
 * Loading: 5 skeleton rows. Empty: a terse "nothing yet" line — no
 * illustrations per brand guide.
 *
 * Rows describe entities that have an audit drill-down route, so `linkable`
 * turns each one into a link to it. The flag is an input rather than a store
 * read on purpose: the dashboard route carries no `audit_log:view` requirement,
 * so the parent decides, and this component stays free of store injection.
 */
@Component({
  selector: 'app-activity-feed',
  standalone: true,
  imports: [RouterLink, SkeletonComponent, AdminDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="border border-line bg-surface" data-testid="dashboard-activity">
      <header class="px-5 py-4 border-b border-line flex items-center justify-between">
        <h2 class="text-xs tracking-widest uppercase text-ink-muted">Recent activity</h2>
      </header>

      @if (loading()) {
        <ul class="divide-y divide-line">
          @for (_ of placeholderRows; track $index) {
            <li class="px-5 py-4 flex flex-col gap-2">
              <app-skeleton height="0.75rem" width="60%" />
              <app-skeleton height="0.625rem" width="30%" />
            </li>
          }
        </ul>
      } @else if (items().length === 0) {
        <p class="px-5 py-10 text-ink-muted text-sm text-center">
          No activity in the last 24 hours.
        </p>
      } @else {
        <ul class="divide-y divide-line" data-testid="activity-list">
          @for (item of items(); track item.id) {
            <li>
              @if (linkable() && item.entityId) {
                <a
                  [routerLink]="['/audit-logs', item.entityType, item.entityId]"
                  [attr.aria-label]="linkLabel(item)"
                  class="px-5 py-4 flex flex-col gap-1 hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-2"
                  data-testid="activity-link"
                >
                  <span class="text-sm text-ink" data-testid="activity-sentence">
                    {{ item.sentence }}
                  </span>
                  @if (item.at) {
                    <span class="tabular text-xs text-ink-muted">{{ item.at | adminDate }}</span>
                  }
                </a>
              } @else {
                <div class="px-5 py-4 flex flex-col gap-1">
                  <p class="text-sm text-ink" data-testid="activity-sentence">
                    {{ item.sentence }}
                  </p>
                  @if (item.at) {
                    <p class="tabular text-xs text-ink-muted">{{ item.at | adminDate }}</p>
                  }
                </div>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ActivityFeedComponent {
  readonly items = input<readonly ActivityItem[]>([]);
  readonly loading = input<boolean>(false);
  /** Off by default: an operator without `audit_log:view` would land on a 403. */
  readonly linkable = input<boolean>(false);

  readonly placeholderRows = [0, 1, 2, 3, 4];

  linkLabel(item: ActivityItem): string {
    return `${item.sentence}. Open the audit history for this ${item.entityType}.`;
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { BadgeComponent, ButtonComponent, PaginationComponent, SkeletonComponent } from '@admin-ui';
import {
  NotificationsService,
  notificationBodyText,
  notificationTitleText,
  type AdminNotification,
  type ListNotificationsQuery,
} from '@admin-services';
import { ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { Subject, forkJoin, takeUntil } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { BOOTSTRAP_LOCALE } from '../../core/tokens';
import { AdminDatePipe } from '../../shared/pipes/admin-date.pipe';

/**
 * `/notifications/inbox` — per-admin in-app notifications.
 *
 * Lists unread-first per the backend order. Operators with
 * `notifications:manage` can mark a single row read or mark every unread
 * row read at once; the topbar indicator reflects the count.
 */
@Component({
  selector: 'app-inbox-page',
  standalone: true,
  imports: [BadgeComponent, ButtonComponent, SkeletonComponent, AdminDatePipe, PaginationComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="p-6 md:p-10 flex flex-col gap-8" data-testid="inbox-page">
      <header class="flex items-end justify-between gap-6 flex-wrap">
        <div>
          <p class="text-xs tracking-widest uppercase text-ink-muted">Notifications</p>
          <h1 class="mt-2 text-4xl md:text-5xl font-bold tracking-tight">Inbox</h1>
          <p class="mt-3 text-sm text-ink-muted max-w-xl">
            Admin alerts from orders, reviews, returns, and inventory. Unread items come first.
          </p>
        </div>
        @if (canManage()) {
          <app-button
            variant="secondary"
            size="md"
            [disabled]="unreadCount() === 0 || busyAll()"
            [loading]="busyAll()"
            (clicked)="markAllRead()"
            testId="inbox-mark-all-read"
            ariaLabel="Mark all notifications as read"
          >
            Mark all read
          </app-button>
        }
      </header>

      <div class="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter by read state">
        <button
          type="button"
          class="text-xs tracking-widest uppercase px-3 py-2 border min-h-[44px] focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
          [class.border-ink]="filter() === 'all'"
          [class.text-ink]="filter() === 'all'"
          [class.border-line]="filter() !== 'all'"
          [class.text-ink-muted]="filter() !== 'all'"
          [attr.aria-pressed]="filter() === 'all'"
          data-testid="inbox-filter-all"
          (click)="setFilter('all')"
        >
          All
        </button>
        <button
          type="button"
          class="text-xs tracking-widest uppercase px-3 py-2 border min-h-[44px] focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
          [class.border-ink]="filter() === 'unread'"
          [class.text-ink]="filter() === 'unread'"
          [class.border-line]="filter() !== 'unread'"
          [class.text-ink-muted]="filter() !== 'unread'"
          [attr.aria-pressed]="filter() === 'unread'"
          data-testid="inbox-filter-unread"
          (click)="setFilter('unread')"
        >
          Unread only
        </button>
      </div>

      <p
        class="text-xs"
        role="alert"
        aria-atomic="true"
        data-testid="inbox-error"
        [class.border]="!!error()"
        [class.border-status-error]="!!error()"
        [class.text-ink]="!!error()"
        [class.p-3]="!!error()"
      >
        {{ error() ?? '' }}
      </p>

      <p
        class="text-xs"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="inbox-notice"
        [class.border]="!!notice()"
        [class.border-status-success]="!!notice()"
        [class.text-ink]="!!notice()"
        [class.p-3]="!!notice()"
      >
        {{ notice() ?? '' }}
      </p>

      <div class="border border-line bg-surface" [attr.aria-busy]="loading() ? 'true' : null">
        @if (loading()) {
          <ul role="list" class="divide-y divide-line">
            @for (_ of placeholderRows; track $index) {
              <li class="p-5 flex flex-col gap-2">
                <app-skeleton height="0.85rem" width="40%" />
                <app-skeleton height="0.75rem" width="70%" />
              </li>
            }
          </ul>
        } @else if (rows().length === 0) {
          <p class="px-5 py-16 text-center text-ink-muted text-sm" data-testid="inbox-empty">
            @if (filter() === 'unread') {
              You have no unread notifications.
            } @else {
              No notifications yet.
            }
          </p>
        } @else {
          <ul role="list" class="divide-y divide-line">
            @for (n of rows(); track n.id) {
              <li
                class="p-5 flex items-start gap-4"
                [attr.data-testid]="'notification-row-' + n.id"
                [class.bg-surface-elevated]="!n.isRead"
              >
                <div class="flex-1 min-w-0 flex flex-col gap-1">
                  <div class="flex items-center gap-3 flex-wrap">
                    <h2 class="text-sm font-bold text-ink">
                      {{ titleText(n) }}
                    </h2>
                    @if (!n.isRead) {
                      <app-badge tone="info" ariaLabel="Unread">Unread</app-badge>
                    }
                  </div>
                  @if (bodyText(n)) {
                    <p class="text-sm text-ink-muted wrap-break-word">
                      {{ bodyText(n) }}
                    </p>
                  }
                  <time
                    class="text-xs font-mono tabular-nums text-ink-muted mt-1"
                    [attr.datetime]="n.createdAt"
                  >
                    {{ n.createdAt | adminDate }}
                  </time>
                </div>
                @if (canManage() && !n.isRead) {
                  <app-button
                    variant="ghost"
                    size="sm"
                    [disabled]="busyId() === n.id"
                    [loading]="busyId() === n.id"
                    (clicked)="markRead(n)"
                    [testId]="'notification-mark-read-' + n.id"
                    [ariaLabel]="markReadLabel(n)"
                  >
                    Mark read
                  </app-button>
                }
              </li>
            }
          </ul>
        }
      </div>

      <app-pagination
        [page]="page()"
        [pageSize]="pageSize()"
        [total]="total()"
        [loading]="loading()"
        testIdPrefix="inbox"
        (pageChange)="goToPage($event)"
      />
    </section>
  `,
})
export class InboxPage implements OnInit, OnDestroy {
  private readonly service = inject(NotificationsService);
  private readonly authStore = inject(AuthStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly locale = inject(BOOTSTRAP_LOCALE, { optional: true }) ?? undefined;
  private readonly destroy$ = new Subject<void>();

  protected readonly placeholderRows = [0, 1, 2];

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly rows = signal<readonly AdminNotification[]>([]);
  readonly total = signal(0);
  readonly unreadCount = signal(0);
  readonly busyId = signal<string | null>(null);
  readonly busyAll = signal(false);

  readonly queryParams = toSignal(this.route.queryParams, {
    initialValue: {} as Record<string, string | undefined>,
  });
  readonly page = computed(() => {
    const raw = Number(this.queryParams()['page'] ?? '1');
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
  });
  readonly pageSize = computed(() => {
    const raw = Number(this.queryParams()['pageSize'] ?? '20');
    return Number.isFinite(raw) && raw >= 1 ? raw : 20;
  });
  readonly filter = computed<'all' | 'unread'>(() =>
    this.queryParams()['unread'] === '1' ? 'unread' : 'all',
  );
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));

  readonly canManage = computed(() => this.authStore.hasAnyPermission(['notifications:manage']));

  titleText(n: AdminNotification): string {
    return notificationTitleText(n, this.locale);
  }

  bodyText(n: AdminNotification): string {
    return notificationBodyText(n, this.locale);
  }

  /**
   * Disambiguated per-row aria-label for the Mark-read button. When the title
   * resolves to the generic "Notification" fallback, append the row's
   * createdAt timestamp so screen-reader users can tell rows apart when
   * multiple untitled notifications render at once (WCAG 2.4.6).
   */
  markReadLabel(n: AdminNotification): string {
    const title = this.titleText(n);
    if (title && title !== 'Notification') return `Mark ${title} as read`;
    const ts = new Date(n.createdAt as string | Date).toISOString().slice(0, 16).replace('T', ' ');
    return `Mark notification from ${ts} as read`;
  }

  ngOnInit(): void {
    this.route.queryParams.pipe(takeUntil(this.destroy$)).subscribe(() => this.fetch());
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  setFilter(next: 'all' | 'unread'): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { unread: next === 'unread' ? '1' : null, page: null },
      queryParamsHandling: 'merge',
    });
  }

  goToPage(n: number): void {
    if (n < 1 || n > this.totalPages()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page: n },
      queryParamsHandling: 'merge',
    });
  }

  markRead(n: AdminNotification): void {
    if (this.busyId() || n.isRead) return;
    this.busyId.set(n.id);
    this.error.set(null);
    this.notice.set(null);
    this.service
      .markRead(n.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.busyId.set(null);
          this.rows.update((list) =>
            list.map((row) =>
              row.id === n.id ? { ...row, isRead: true, readAt: new Date().toISOString() } : row,
            ),
          );
          this.unreadCount.update((v) => Math.max(0, v - 1));
          this.notice.set('Marked 1 notification as read.');
          setTimeout(() => this.notice.set(null), 3500);
        },
        error: (err: unknown) => {
          this.busyId.set(null);
          this.error.set(this.formatError(err, 'Could not mark this notification as read.'));
        },
      });
  }

  markAllRead(): void {
    if (this.busyAll() || this.unreadCount() === 0) return;
    this.busyAll.set(true);
    this.error.set(null);
    this.notice.set(null);
    const before = this.unreadCount();
    this.service
      .markAllRead()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.busyAll.set(false);
          this.rows.update((list) => list.map((row) => ({ ...row, isRead: true })));
          this.unreadCount.set(0);
          this.notice.set(`Marked ${before} notification${before === 1 ? '' : 's'} as read.`);
          setTimeout(() => this.notice.set(null), 3500);
          if (this.filter() === 'unread') this.fetch();
        },
        error: (err: unknown) => {
          this.busyAll.set(false);
          this.error.set(this.formatError(err, 'Could not mark notifications as read.'));
        },
      });
  }

  private fetch(): void {
    const query: ListNotificationsQuery = {
      page: this.page(),
      pageSize: this.pageSize(),
    };
    if (this.filter() === 'unread') query.isRead = false;

    this.loading.set(true);
    this.error.set(null);
    forkJoin({
      list: this.service.list(query),
      unread: this.service.unreadCount(),
    })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.rows.set(res.list.data);
          this.total.set(res.list.meta.total);
          this.unreadCount.set(res.unread.unreadCount);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  private formatError(err: unknown, fallback = 'Could not load notifications.'): string {
    if (err instanceof ApiForbiddenError)
      return 'You do not have permission to manage notifications.';
    if (err instanceof ApiNotFoundError) return 'Notification not found.';
    if (err instanceof ApiError) return err.message;
    return fallback;
  }
}

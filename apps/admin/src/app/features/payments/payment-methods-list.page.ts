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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDropList,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { BadgeComponent, ButtonComponent, PaginationComponent, SkeletonComponent } from '@admin-ui';
import {
  PaymentMethodsService,
  type ListPaymentMethodsQuery,
  type PaymentMethod,
  type PaymentProviderCatalogueEntry,
} from '@admin-services';
import { ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { Subject, takeUntil } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { activeTone, methodLabel, providerLabel, testModeTone } from './payments.utils';
import { StoreSettingsStore } from '../../core/stores/store-settings.store';

/**
 * `/payment-methods` — operator-facing catalogue.
 *
 * Sort order is server-managed. The row is draggable via a dedicated
 * `cdkDragHandle` button (with ArrowUp / ArrowDown keyboard fallback so
 * keyboard-only operators stay on parity with pointer users); a drop
 * PATCHes `POST /v1/admin/payment-methods/reorder` with the new id order
 * and re-fetches on 204, rolling back to the pre-drop order on error.
 */
@Component({
  selector: 'app-payment-methods-list-page',
  standalone: true,
  imports: [
    RouterLink,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    BadgeComponent,
    ButtonComponent,
    SkeletonComponent,
    PaginationComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="p-6 md:p-10 flex flex-col gap-8" data-testid="payment-methods-list-page">
      <header class="flex items-end justify-between gap-6 flex-wrap">
        <div>
          <p class="text-xs tracking-widest uppercase text-ink-muted">Commerce</p>
          <h1 class="mt-2 text-4xl md:text-5xl font-bold tracking-tight">Payment methods</h1>
          <p class="mt-3 tabular text-sm text-ink-muted max-w-xl">
            Providers you expose at checkout.
            @if (canReorder()) {
              Drag the handle or press ArrowUp / ArrowDown to reorder.
            }
          </p>
        </div>
        @if (canCreate()) {
          <app-button
            variant="primary"
            size="md"
            [routerLink]="['/payment-methods/new']"
            data-testid="payment-method-new"
          >
            New payment method
          </app-button>
        }
      </header>

      <div class="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter by status">
        @for (opt of activeOptions; track opt.value) {
          <button
            type="button"
            class="text-xs tracking-widest uppercase px-3 py-2 border focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            [class.border-ink]="activeFilter() === opt.value"
            [class.text-ink]="activeFilter() === opt.value"
            [class.border-line]="activeFilter() !== opt.value"
            [class.text-ink-muted]="activeFilter() !== opt.value"
            [attr.aria-pressed]="activeFilter() === opt.value"
            [attr.data-testid]="'payment-filter-' + (opt.value ?? 'all')"
            (click)="setActiveFilter(opt.value)"
          >
            {{ opt.label }}
          </button>
        }
      </div>

      <div role="alert" aria-atomic="true" data-testid="payment-methods-error">
        @if (error()) {
          <p class="border border-status-error text-ink p-3 tabular text-xs">
            {{ error() }}
          </p>
        }
      </div>

      <div class="border border-line bg-surface">
        <div class="overflow-x-auto">
          <table
            class="w-full border-collapse"
            [attr.aria-busy]="loading() || reordering() ? 'true' : null"
          >
            <caption class="sr-only">
              Payment methods
            </caption>
            <thead class="border-b border-line">
              <tr class="text-left">
                @if (canReorder()) {
                  <th scope="col" class="w-10 px-2 py-3">
                    <span class="sr-only">Reorder</span>
                  </th>
                }
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Order
                </th>
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Name
                </th>
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Code
                </th>
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Provider
                </th>
                <th
                  scope="col"
                  class="text-xs tracking-widest uppercase text-ink-muted font-normal px-4 py-3"
                >
                  Status
                </th>
              </tr>
            </thead>
            <tbody
              cdkDropList
              [cdkDropListData]="rows()"
              [cdkDropListDisabled]="!canReorder() || reordering() || loading()"
              (cdkDropListDropped)="drop($event)"
              data-testid="payment-methods-tbody"
            >
              @if (loading()) {
                @for (_ of placeholderRows; track $index) {
                  <tr class="border-b border-line">
                    @if (canReorder()) {
                      <td class="px-2 py-3"><app-skeleton height="0.75rem" width="1rem" /></td>
                    }
                    @for (__ of [0, 1, 2, 3, 4]; track $index) {
                      <td class="px-4 py-3"><app-skeleton height="0.75rem" /></td>
                    }
                  </tr>
                }
              } @else if (rows().length === 0) {
                <tr>
                  <td
                    [attr.colspan]="canReorder() ? 6 : 5"
                    class="px-4 py-16 text-center text-ink-muted tabular text-sm"
                  >
                    No payment methods configured.
                  </td>
                </tr>
              } @else {
                @for (m of rows(); track m.id; let i = $index) {
                  <tr
                    cdkDrag
                    [cdkDragDisabled]="!canReorder() || reordering()"
                    class="border-b border-line last:border-b-0 hover:bg-surface-elevated focus-within:bg-surface-elevated"
                    [attr.data-testid]="'payment-row-' + m.id"
                  >
                    @if (canReorder()) {
                      <td class="px-2 py-3 align-middle">
                        <button
                          type="button"
                          cdkDragHandle
                          class="w-6 h-6 inline-flex items-center justify-center text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2 disabled:opacity-40 cursor-grab active:cursor-grabbing"
                          [attr.aria-label]="
                            'Reorder ' +
                            label(m) +
                            '. Use ArrowUp or ArrowDown to move between rows.'
                          "
                          [attr.data-testid]="'drag-handle-' + m.id"
                          [disabled]="reordering()"
                          (keydown.arrowup)="onHandleKey($event, 'up', i)"
                          (keydown.arrowdown)="onHandleKey($event, 'down', i)"
                        >
                          <span aria-hidden="true">⋮⋮</span>
                        </button>
                      </td>
                    }
                    <td class="px-4 py-3 tabular text-xs text-ink-muted">
                      {{ m.sortOrder }}
                    </td>
                    <td class="px-4 py-3">
                      <a
                        [routerLink]="['/payment-methods', m.id]"
                        class="tabular text-sm text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                      >
                        {{ label(m) }}
                      </a>
                    </td>
                    <td class="px-4 py-3 tabular text-xs text-ink-muted">
                      <code class="font-mono">{{ m.code }}</code>
                    </td>
                    <td class="px-4 py-3 tabular text-sm text-ink-muted">
                      {{ providerName(m.provider) }}
                    </td>
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-2 flex-wrap">
                        <app-badge
                          [tone]="activeTone(m.isActive)"
                          [ariaLabel]="m.isActive ? 'Active' : 'Disabled'"
                        >
                          {{ m.isActive ? 'Active' : 'Disabled' }}
                        </app-badge>
                        @if (m.isTestMode) {
                          <app-badge [tone]="'warning'" [ariaLabel]="'Test mode enabled'">
                            Test mode
                          </app-badge>
                        }
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      </div>

      <app-pagination
        [page]="page()"
        [pageSize]="pageSize()"
        [total]="total()"
        [loading]="loading()"
        testIdPrefix="payment-methods"
        (pageChange)="goToPage($event)"
      />
    </section>
  `,
})
export class PaymentMethodsListPage implements OnInit, OnDestroy {
  private readonly service = inject(PaymentMethodsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly authStore = inject(AuthStore);
  private readonly storeSettings = inject(StoreSettingsStore);
  private readonly destroy$ = new Subject<void>();

  protected readonly placeholderRows = [0, 1, 2, 3];

  readonly loading = signal(true);
  readonly reordering = signal(false);
  readonly error = signal<string | null>(null);
  readonly rows = signal<readonly PaymentMethod[]>([]);
  readonly total = signal(0);

  readonly queryParams = toSignal(this.route.queryParams, {
    initialValue: {} as Record<string, string | undefined>,
  });
  readonly page = computed(() => Number(this.queryParams()['page'] ?? '1'));
  readonly pageSize = computed(() => Number(this.queryParams()['pageSize'] ?? '20'));
  readonly activeFilter = computed<'active' | 'disabled' | null>(() => {
    const raw = this.queryParams()['status'];
    return raw === 'active' || raw === 'disabled' ? raw : null;
  });
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));

  readonly canCreate = computed(() => this.authStore.hasPermission('payment_methods:create'));
  readonly canReorder = computed(() => this.authStore.hasPermission('payment_methods:update'));

  readonly activeOptions: ReadonlyArray<{ value: 'active' | 'disabled' | null; label: string }> = [
    { value: null, label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'disabled', label: 'Disabled' },
  ];

  protected readonly label = (m: Pick<PaymentMethod, 'name' | 'code'>): string =>
    methodLabel(m, this.authStore.locale(), this.storeSettings.defaultLocale());
  protected readonly activeTone = activeTone;
  protected readonly testModeTone = testModeTone;

  readonly providers = signal<readonly PaymentProviderCatalogueEntry[]>([]);

  protected providerName(id: string): string {
    return providerLabel(id, this.providers());
  }

  ngOnInit(): void {
    this.service
      .providers()
      .pipe(takeUntil(this.destroy$))
      // query-error-guard: allow, a catalogue failure only costs the pretty labels.
      .subscribe({
        next: (entries) => this.providers.set(entries),
        error: () => undefined,
      });
    this.route.queryParams.pipe(takeUntil(this.destroy$)).subscribe(() => this.fetch());
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  setActiveFilter(value: 'active' | 'disabled' | null): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { status: value, page: null },
      queryParamsHandling: 'merge',
    });
  }

  goToPage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page },
      queryParamsHandling: 'merge',
    });
  }

  drop(event: CdkDragDrop<readonly PaymentMethod[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    this.reorderRows(event.previousIndex, event.currentIndex);
  }

  onHandleKey(event: Event, direction: 'up' | 'down', index: number): void {
    event.preventDefault();
    event.stopPropagation();
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= this.rows().length) return;
    this.reorderRows(index, target);
  }

  private reorderRows(fromIndex: number, toIndex: number): void {
    const snapshot = this.rows();
    if (
      fromIndex < 0 ||
      fromIndex >= snapshot.length ||
      toIndex < 0 ||
      toIndex >= snapshot.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const next = snapshot.slice() as PaymentMethod[];
    moveItemInArray(next, fromIndex, toIndex);
    this.error.set(null);
    this.rows.set(next);
    this.reordering.set(true);
    const ids = next.map((m) => m.id);
    this.service
      .reorder({ ids })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.reordering.set(false);
          this.fetch();
        },
        error: (err: unknown) => {
          this.reordering.set(false);
          this.rows.set(snapshot);
          this.error.set(this.formatError(err));
        },
      });
  }

  private fetch(): void {
    const query: ListPaymentMethodsQuery = {
      page: this.page(),
      pageSize: this.pageSize(),
    };
    const status = this.activeFilter();
    if (status === 'active') query.isActive = true;
    if (status === 'disabled') query.isActive = false;

    this.loading.set(true);
    this.error.set(null);
    this.service
      .list(query)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.rows.set(res.data);
          this.total.set(res.meta.total);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  private formatError(err: unknown): string {
    if (err instanceof ApiForbiddenError)
      return 'You do not have permission to view payment methods.';
    if (err instanceof ApiNotFoundError) return 'Payment methods not found.';
    if (err instanceof ApiError && err.message) return err.message;
    return 'Could not load payment methods.';
  }
}

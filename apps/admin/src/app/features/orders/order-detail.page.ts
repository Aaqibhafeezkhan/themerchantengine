import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { BadgeComponent, ButtonComponent, LoadErrorComponent, SkeletonComponent } from '@admin-ui';
import {
  OrdersService,
  ReturnsService,
  type Order,
  type OrderAddress,
  type Return,
} from '@admin-services';
import { ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { Subject, takeUntil } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { TranslatablePipe } from '../../shared/pipes/translatable.pipe';
import { statusLabel as returnStatusLabel } from '../returns/returns.utils';
import { OrderActionsComponent } from './order-actions.component';
import { OrderPaymentActionsComponent } from './order-payment-actions.component';
import { OrderShipmentPanelComponent } from './order-shipment-panel.component';
import {
  canEditOrder,
  customerLabel,
  formatMoney,
  orderStatusLabel,
  orderStatusTone,
  paymentStatusLabel,
  paymentStatusTone,
} from './orders.utils';
import { AdminDatePipe } from '../../shared/pipes/admin-date.pipe';

/**
 * `/orders/:id` — order detail with optional management actions.
 *
 * Actions (status change, cancel, internal note) live in
 * `<app-order-actions>` and render only when the viewer holds the
 * `orders:manage` permission. Without that permission the page stays
 * read-only so the `orders:view` boundary remains clean.
 */
@Component({
  selector: 'app-order-detail-page',
  standalone: true,
  imports: [
    RouterLink,
    BadgeComponent,
    ButtonComponent,
    LoadErrorComponent,
    SkeletonComponent,
    TranslatablePipe,
    OrderActionsComponent,
    OrderPaymentActionsComponent,
    OrderShipmentPanelComponent,
    AdminDatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="p-6 md:p-10 flex flex-col gap-8"
      data-testid="order-detail-page"
      [attr.aria-busy]="loading() ? 'true' : null"
    >
      <nav class="text-xs tracking-widest uppercase text-ink-muted" aria-label="Breadcrumb">
        <a
          routerLink="/orders"
          class="hover:text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
        >
          Orders
        </a>
        <span aria-hidden="true" class="mx-2">/</span>
        <span class="text-ink" aria-current="page">
          {{ order()?.orderNumber ?? order()?.id ?? '…' }}
        </span>
      </nav>

      @if (error()) {
        <p
          class="border border-status-error text-ink p-3 tabular text-xs"
          data-testid="order-error"
          role="alert"
        >
          {{ error() }}
        </p>
      }

      @if (loading()) {
        <div class="flex flex-col gap-4">
          <app-skeleton height="2.5rem" width="40%" />
          <app-skeleton height="1rem" width="60%" />
          <app-skeleton height="12rem" width="100%" />
        </div>
      } @else if (order(); as o) {
        <header class="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p class="text-xs tracking-widest uppercase text-ink-muted">Order</p>
            <h1 class="mt-2 text-4xl md:text-5xl font-bold tracking-tight tabular">
              {{ o.orderNumber ?? o.id }}
            </h1>
            <p class="mt-3 text-ink-muted tabular text-sm">Placed {{ o.createdAt | adminDate }}</p>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <app-badge
              [tone]="statusTone(o.status)"
              [ariaLabel]="'Order status: ' + orderStatusLabel(o.status)"
            >
              {{ orderStatusLabel(o.status) }}
            </app-badge>
            @if (o.paymentStatus) {
              <app-badge
                [tone]="paymentTone(o.paymentStatus)"
                [ariaLabel]="'Payment status: ' + paymentStatusLabel(o.paymentStatus)"
              >
                Payment · {{ paymentStatusLabel(o.paymentStatus) }}
              </app-badge>
            }
          </div>
        </header>

        <h2 id="order-totals-heading" class="sr-only">Order totals</h2>
        <dl
          class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4"
          data-testid="order-totals"
          aria-labelledby="order-totals-heading"
        >
          <div class="border border-line bg-surface p-5">
            <dt class="text-xs tracking-widest uppercase text-ink-muted">Subtotal</dt>
            <dd class="mt-2 text-2xl font-bold tabular">
              {{ formatMoney(o.subtotal, o.currency) }}
            </dd>
          </div>
          <!-- Finding AD3: without this tile the region does not add up, and the
               missing figure sat in the Metadata block far below. -->
          <div class="border border-line bg-surface p-5">
            <dt class="text-xs tracking-widest uppercase text-ink-muted">Discount</dt>
            <dd class="mt-2 text-2xl font-bold tabular" data-testid="order-discount-tile">
              -{{ formatMoney(o.discountAmount, o.currency) }}
            </dd>
          </div>
          <div class="border border-line bg-surface p-5">
            <dt class="text-xs tracking-widest uppercase text-ink-muted">Shipping</dt>
            <dd class="mt-2 text-2xl font-bold tabular">
              {{ formatMoney(o.shippingAmount, o.currency) }}
            </dd>
          </div>
          <div class="border border-line bg-surface p-5">
            <dt class="text-xs tracking-widest uppercase text-ink-muted">Tax</dt>
            <dd class="mt-2 text-2xl font-bold tabular">
              {{ formatMoney(o.taxAmount, o.currency) }}
            </dd>
          </div>
          <div class="border border-ink bg-surface p-5">
            <dt class="text-xs tracking-widest uppercase text-ink-muted">Total</dt>
            <dd class="mt-2 text-2xl font-bold tabular text-ink">
              {{ formatMoney(o.total, o.currency) }}
            </dd>
          </div>
        </dl>

        <section
          class="border border-line bg-surface"
          data-testid="order-items"
          aria-labelledby="order-items-heading"
        >
          <header class="px-5 py-4 border-b border-line">
            <h2 id="order-items-heading" class="text-xs tracking-widest uppercase text-ink-muted">
              Line items
            </h2>
          </header>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse">
              <caption class="sr-only">
                Products on this order
              </caption>
              <thead class="border-b border-line">
                <tr class="text-left">
                  <th
                    scope="col"
                    class="text-xs tracking-widest uppercase text-ink-muted font-normal px-5 py-3"
                  >
                    Product
                  </th>
                  <th
                    scope="col"
                    class="text-xs tracking-widest uppercase text-ink-muted font-normal px-5 py-3"
                  >
                    SKU
                  </th>
                  <th
                    scope="col"
                    class="text-xs tracking-widest uppercase text-ink-muted font-normal px-5 py-3"
                  >
                    Qty
                  </th>
                  <th
                    scope="col"
                    class="text-xs tracking-widest uppercase text-ink-muted font-normal px-5 py-3"
                  >
                    Unit price
                  </th>
                  <th
                    scope="col"
                    class="text-xs tracking-widest uppercase text-ink-muted font-normal px-5 py-3"
                  >
                    Line total
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (item of o.items ?? []; track item.id) {
                  <tr
                    class="border-b border-line last:border-b-0"
                    [attr.data-testid]="'order-item-' + item.id"
                  >
                    <td class="px-5 py-3">
                      <!-- Raw Translatable: the pipe is the only safe binding (§3.2). -->
                      <p class="tabular text-sm text-ink">
                        {{ item.productName | translatable: item.sku ?? '—' }}
                      </p>
                      @if (item.variantLabel) {
                        <p class="tabular text-xs text-ink-muted">{{ item.variantLabel }}</p>
                      }
                    </td>
                    <td class="px-5 py-3 tabular text-sm text-ink-muted">
                      {{ item.sku ?? '—' }}
                    </td>
                    <td class="px-5 py-3 tabular text-sm text-ink tabular-nums">
                      {{ item.quantity }}
                    </td>
                    <td class="px-5 py-3 tabular text-sm text-ink-muted tabular-nums">
                      {{ formatMoney(item.unitPrice, o.currency) }}
                    </td>
                    <td class="px-5 py-3 tabular text-sm text-ink tabular-nums">
                      {{ formatMoney(item.total, o.currency) }}
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="px-5 py-10 text-center text-ink-muted tabular text-sm">
                      No line items recorded.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <section
            class="border border-line bg-surface"
            data-testid="order-shipping-address"
            aria-labelledby="order-shipping-address-heading"
          >
            <header class="px-5 py-4 border-b border-line">
              <h2
                id="order-shipping-address-heading"
                class="text-xs tracking-widest uppercase text-ink-muted"
              >
                Shipping address
              </h2>
            </header>
            <div class="px-5 py-4">
              @if (addressLines(o.shippingAddress); as lines) {
                @if (lines.length > 0) {
                  <address class="not-italic tabular text-sm text-ink flex flex-col gap-1">
                    @for (line of lines; track $index) {
                      <span>{{ line }}</span>
                    }
                  </address>
                } @else {
                  <p class="tabular text-sm text-ink-muted">No shipping address recorded.</p>
                }
              }
            </div>
          </section>

          <section
            class="border border-line bg-surface"
            data-testid="order-billing-address"
            aria-labelledby="order-billing-address-heading"
          >
            <header class="px-5 py-4 border-b border-line">
              <h2
                id="order-billing-address-heading"
                class="text-xs tracking-widest uppercase text-ink-muted"
              >
                Billing address
              </h2>
            </header>
            <div class="px-5 py-4">
              @if (addressLines(o.billingAddress); as lines) {
                @if (lines.length > 0) {
                  <address class="not-italic tabular text-sm text-ink flex flex-col gap-1">
                    @for (line of lines; track $index) {
                      <span>{{ line }}</span>
                    }
                  </address>
                } @else {
                  <p class="tabular text-sm text-ink-muted">No billing address recorded.</p>
                }
              }
            </div>
          </section>

          <section
            class="border border-line bg-surface"
            data-testid="order-payment"
            aria-labelledby="order-payment-heading"
          >
            <header class="px-5 py-4 border-b border-line">
              <h2
                id="order-payment-heading"
                class="text-xs tracking-widest uppercase text-ink-muted"
              >
                Payment
              </h2>
            </header>
            <dl class="divide-y divide-line">
              <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular items-center">
                <dt class="text-ink-muted">Status</dt>
                <dd>
                  <!-- The term names it, so no aria-label here: the header badge
                       already carries the announced "Payment status: …" form. -->
                  <app-badge [tone]="paymentTone(o.paymentStatus)">
                    {{ paymentStatusLabel(o.paymentStatus) }}
                  </app-badge>
                </dd>
              </div>
              <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
                <dt class="text-ink-muted">Method</dt>
                <dd data-testid="order-payment-method">{{ o.paymentMethodName ?? '—' }}</dd>
              </div>
              <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
                <dt class="text-ink-muted">Charged in</dt>
                <dd>{{ o.currency ?? '—' }}</dd>
              </div>
              <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
                <dt class="text-ink-muted">Coupon</dt>
                <dd>{{ o.couponCode ?? '—' }}</dd>
              </div>
              <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
                <dt class="text-ink-muted">Invoice</dt>
                <dd data-testid="order-payment-invoice">
                  {{ o.invoice?.invoiceNumber ?? 'Not generated yet' }}
                </dd>
              </div>
            </dl>
            <app-order-payment-actions
              class="block px-5 pb-4"
              [order]="o"
              [canManage]="canManagePayments()"
              (orderChanged)="onOrderChanged($event)"
            />
          </section>
        </div>

        <section
          class="border border-line bg-surface"
          data-testid="order-metadata"
          aria-labelledby="order-metadata-heading"
        >
          <header class="px-5 py-4 border-b border-line">
            <h2
              id="order-metadata-heading"
              class="text-xs tracking-widest uppercase text-ink-muted"
            >
              Metadata
            </h2>
          </header>
          <dl class="divide-y divide-line">
            <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
              <dt class="text-ink-muted">Shipping method</dt>
              <dd data-testid="order-shipping-method">{{ o.shippingMethodName ?? '—' }}</dd>
            </div>
            <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
              <dt class="text-ink-muted">Currency</dt>
              <dd>{{ o.currency ?? '—' }}</dd>
            </div>
            <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
              <dt class="text-ink-muted">Coupon</dt>
              <dd>{{ o.couponCode ?? '—' }}</dd>
            </div>
            <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
              <dt class="text-ink-muted">Customer</dt>
              <dd [title]="o.userId ?? ''">{{ customerLabel(o.user) }}</dd>
            </div>
            <div class="px-5 py-3 flex justify-between gap-3 text-sm tabular">
              <dt class="text-ink-muted">Last updated</dt>
              <dd>{{ o.updatedAt | adminDate }}</dd>
            </div>
          </dl>
        </section>

        <app-order-actions
          [order]="o"
          [canManage]="canManage()"
          (orderChanged)="onOrderChanged($event)"
        />

        @if (canManage()) {
          <div class="flex items-center gap-3 flex-wrap">
            <app-button
              variant="secondary"
              size="md"
              (clicked)="openInvoice()"
              [loading]="invoiceBusy()"
              [disabled]="invoiceBusy()"
              data-testid="order-invoice-open"
            >
              Print invoice
            </app-button>
            <span role="status" aria-live="polite" aria-atomic="true" class="sr-only">
              {{ invoiceStatus() }}
            </span>
            <!-- The API refuses every edit outside EDITABLE_STATUSES, so a link
                 on a DELIVERED order is a dead end, not an option. -->
            @if (canEdit(o.status)) {
              <a
                [routerLink]="['/orders', o.id, 'edit']"
                class="text-xs tracking-widest uppercase px-3 py-2 min-h-[44px] inline-flex items-center border border-line text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                data-testid="order-edit-link"
              >
                Edit order
              </a>
            }
          </div>
        }

        @if (canManage()) {
          <app-order-shipment-panel
            [order]="o"
            (changed)="refresh()"
            data-testid="order-shipment-panel"
          />
        }

        @if (canViewReturns() && relatedReturnError()) {
          <app-load-error
            [message]="relatedReturnError()!"
            [compact]="true"
            [retrying]="relatedReturnLoading()"
            retryLabel="related return"
            testId="order-related-return-degraded"
            (retry)="reloadRelatedReturn()"
          />
        }

        @if (canViewReturns() && relatedReturn(); as r) {
          <p class="text-ink-muted tabular text-xs" data-testid="order-related-return">
            A return for this order is
            <a
              [routerLink]="['/returns', r.id]"
              class="text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
              >{{ r.returnNumber ?? r.id }} · {{ returnStatusLabel(r.status) }}</a
            >.
          </p>
        }
      }
    </section>
  `,
})
export class OrderDetailPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly ordersService = inject(OrdersService);
  private readonly returnsService = inject(ReturnsService);
  private readonly authStore = inject(AuthStore);
  private readonly destroy$ = new Subject<void>();

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly order = signal<Order | null>(null);
  readonly relatedReturn = signal<Return | null>(null);
  readonly relatedReturnError = signal<string | null>(null);
  readonly relatedReturnLoading = signal(false);
  readonly invoiceBusy = signal(false);
  readonly invoiceStatus = signal<string>('');
  readonly canManage = computed(() => this.authStore.hasPermission('orders:manage'));
  readonly canManagePayments = computed(() => this.authStore.hasPermission('payments:manage'));

  /** Plain method, not a computed: it reads the order the template already holds. */
  canEdit(status: string | null | undefined): boolean {
    return canEditOrder(status);
  }

  /**
   * Flatten an address snapshot into display lines, dropping the parts the
   * checkout never captured. Country stays the stored ISO-2 code (humanising
   * it is finding B6, owned by plan B). Plain method for the same reason as
   * `canEdit`.
   */
  addressLines(address: OrderAddress | null | undefined): readonly string[] {
    if (!address) return [];
    const region = [address.city, address.state, address.postalCode].filter(Boolean).join(', ');
    return [
      address.fullName,
      address.phone,
      address.addressLine1,
      address.addressLine2,
      region,
      address.country,
    ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
  }
  readonly canViewReturns = computed(() => this.authStore.hasPermission('returns:view'));
  protected readonly formatMoney = formatMoney;
  protected readonly customerLabel = customerLabel;
  protected readonly returnStatusLabel = returnStatusLabel;
  protected readonly statusTone = orderStatusTone;
  protected readonly paymentTone = paymentStatusTone;
  protected readonly orderStatusLabel = orderStatusLabel;
  protected readonly paymentStatusLabel = paymentStatusLabel;

  onOrderChanged(next: Order): void {
    this.order.set(next);
  }

  refresh(): void {
    const current = this.order();
    if (current) this.fetch(current.id);
  }

  openInvoice(): void {
    const current = this.order();
    if (!current || this.invoiceBusy()) return;
    this.invoiceBusy.set(true);
    this.ordersService
      .getInvoice(current.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (payload) => {
          this.invoiceBusy.set(false);
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank', 'noopener');
          this.invoiceStatus.set('Invoice opened in a new tab.');
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        },
        error: () => {
          this.invoiceBusy.set(false);
          this.error.set('Could not load invoice.');
          this.invoiceStatus.set('Could not load invoice.');
        },
      });
  }

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      const id = params.get('id');
      if (!id) {
        this.error.set('Missing order id.');
        this.loading.set(false);
        return;
      }
      this.fetch(id);
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private fetch(id: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.ordersService
      .get(id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (order) => {
          this.order.set(order);
          this.loading.set(false);
          if (this.canViewReturns()) {
            this.fetchRelatedReturn(order.id);
          }
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  /** Re-fire the related-return lookup for the order currently on screen. */
  reloadRelatedReturn(): void {
    const id = this.order()?.id;
    if (id) this.fetchRelatedReturn(id);
  }

  private fetchRelatedReturn(orderId: string): void {
    // Returns endpoint has no order-id filter today — pull the first page and
    // match client-side. Cheap in the normal case (single digits per order).
    this.relatedReturnLoading.set(true);
    this.returnsService
      .list({ page: 1, pageSize: 50 })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          const match = res.data.find((r) => r.orderId === orderId) ?? null;
          this.relatedReturn.set(match);
          this.relatedReturnError.set(null);
          this.relatedReturnLoading.set(false);
        },
        error: () => {
          this.relatedReturn.set(null);
          this.relatedReturnError.set('Could not check whether this order has a return.');
          this.relatedReturnLoading.set(false);
        },
      });
  }

  private formatError(err: unknown): string {
    if (err instanceof ApiNotFoundError) return 'Order not found.';
    if (err instanceof ApiForbiddenError) return 'You do not have permission to view this order.';
    if (err instanceof ApiError && err.message) return err.message;
    return 'Could not load order. Please retry.';
  }
}

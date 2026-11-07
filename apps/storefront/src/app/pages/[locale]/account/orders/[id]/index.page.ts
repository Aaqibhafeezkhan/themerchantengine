import { isPlatformBrowser } from '@angular/common';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostListener,
  inject,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { OrdersService } from '@storefront-services';
import {
  pickTranslation,
  StorefrontConflictError,
  StorefrontError,
  StorefrontForbiddenError,
  StorefrontNotFoundError,
  StorefrontUnauthorizedError,
  type Order,
  type OrderStatus,
} from '@storefront-types';

import { LocaleService } from '../../../../../locale.service';
import { LOCALE_INTL_TAG } from '../../../../../../i18n/types';
import { AuthStateService } from '../../../../../services/auth-state.service';
import { StoreConfigService } from '../../../../../services/store-config.service';
import { APP_ROUTES } from '../../../../../../lib/routes';
import { formatMoney } from '../../../../../../lib/money';
import { OrderStatusBadgeComponent } from '../../../../../sections/account/order-status-badge.component';
import {
  OrderStatusTimelineComponent,
  type OrderTimelineEvent,
} from '../../../../../sections/account/order-status-timeline.component';
import { ButtonComponent } from '../../../../../ui/button.component';
import { PriceComponent } from '../../../../../ui/price.component';
import { SpinnerComponent } from '../../../../../ui/spinner.component';
import { ensureAuthedForAccount } from '../../_account-auth-guard';
import { AccountNavComponent } from '../../../../../sections/account/account-nav.component';
import { carrierTrackingUrl } from '../../../../../sections/account/carrier-links';
import { pageTitle } from '../../../../../../lib/seo';

type PageState = 'idle' | 'loading' | 'ready' | 'not-found' | 'not-yours' | 'error';

interface ShipmentInfo {
  carrier?: string | null;
  trackingNumber?: string | null;
  status?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
}

@Component({
  selector: 'app-account-order-detail-page',
  standalone: true,
  imports: [
    AccountNavComponent,
    ButtonComponent,
    CdkTrapFocus,
    OrderStatusBadgeComponent,
    OrderStatusTimelineComponent,
    PriceComponent,
    RouterLink,
    SpinnerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" data-testid="account-order-detail-page">
      @switch (state()) {
        @case ('loading') {
          <div class="loading" role="status" aria-live="polite" data-testid="account-order-loading">
            <app-spinner size="md" />
            <span>{{ strings().account.shared.loading }}</span>
          </div>
        }
        @case ('not-found') {
          <section
            class="status-message"
            aria-labelledby="account-order-not-found-title"
            data-testid="account-order-not-found"
          >
            <h1 id="account-order-not-found-title" class="status-title">
              {{ strings().account.orderDetail.notFound.title }}
            </h1>
            <p>{{ strings().account.orderDetail.notFound.body }}</p>
            <a class="back-link" [routerLink]="ordersListHref()">
              {{ strings().account.orderDetail.notFound.cta }}
            </a>
          </section>
        }
        @case ('not-yours') {
          <section
            class="status-message"
            aria-labelledby="account-order-not-yours-title"
            data-testid="account-order-not-yours"
          >
            <h1 id="account-order-not-yours-title" class="status-title">
              {{ strings().account.orderDetail.notYours.title }}
            </h1>
            <p>{{ strings().account.orderDetail.notYours.body }}</p>
            <a class="back-link" [routerLink]="ordersListHref()">
              {{ strings().account.orderDetail.notYours.cta }}
            </a>
          </section>
        }
        @case ('error') {
          <p class="error" role="alert" data-testid="account-order-error">
            {{ strings().account.shared.loadError }}
          </p>
        }
        @case ('ready') {
          @if (order(); as o) {
            <app-account-nav />
            <header class="header">
              <a class="back-link" [routerLink]="ordersListHref()">
                {{ strings().account.orderDetail.backToList }}
              </a>
              <h1 class="title" data-testid="account-order-heading">{{ headingText() }}</h1>
              <p class="placed-at">
                <time [attr.datetime]="o.createdAt">{{ placedAtText() }}</time>
              </p>
              <div class="status-row">
                <app-order-status-badge [status]="o.status" />
              </div>
              <!-- Finding K7: the page never said how the order was paid, on a
                   store whose only tender is cash on delivery. -->
              <p class="payment-row" data-testid="account-order-payment">
                <span class="payment-label"
                  >{{ strings().account.orderDetail.payment.methodLabel }}:</span
                >
                <span class="payment-value">{{ paymentMethodLabel() }}</span>
                <span class="payment-sep" aria-hidden="true">·</span>
                <span class="payment-value">{{ paymentStatusLabel() }}</span>
              </p>
              <p
                class="cancel-message"
                role="status"
                aria-live="polite"
                data-testid="account-order-cancel-message"
              >
                {{ cancelMessage() ?? '' }}
              </p>
              <p class="cancel-error" role="alert" data-testid="account-order-cancel-error">
                {{ cancelError() ?? '' }}
              </p>
            </header>

            <div class="grid">
              <section class="items" aria-labelledby="account-order-items-title">
                <h2 id="account-order-items-title" class="section-title">
                  {{ strings().account.orderDetail.itemsTitle }}
                </h2>
                <table
                  class="items-table"
                  [attr.aria-label]="strings().account.orderDetail.itemsTableLabel"
                  data-testid="account-order-items-table"
                >
                  <thead>
                    <tr>
                      <th scope="col">{{ strings().account.orderDetail.itemsTitle }}</th>
                      <th scope="col" class="numeric">
                        {{ strings().account.orderDetail.itemQuantity.replace('{quantity}', '') }}
                      </th>
                      <th scope="col" class="numeric">
                        {{ strings().account.orderDetail.itemUnitPrice.replace('{amount}', '') }}
                      </th>
                      <th scope="col" class="numeric">
                        {{ strings().account.orderDetail.itemLineTotal.replace('{amount}', '') }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (line of o.items; track line.id) {
                      <tr>
                        <td>
                          @if (productHref(line); as href) {
                            <a [routerLink]="href">{{ resolveName(line.productName) }}</a>
                          } @else {
                            {{ resolveName(line.productName) }}
                          }
                          @if (reviewHref(o.status, line); as reviewLink) {
                            <a
                              class="review-link"
                              [href]="reviewLink"
                              [attr.data-testid]="'account-order-review-link-' + line.id"
                            >
                              {{ strings().account.orderDetail.writeReview }}
                            </a>
                          }
                        </td>
                        <td class="numeric">{{ line.quantity }}</td>
                        <td class="numeric">
                          <app-price
                            [amount]="toNumber(line.unitPrice)"
                            [currency]="o.currency"
                            taxMention="excluded"
                          />
                        </td>
                        <td class="numeric">
                          <app-price
                            [amount]="toNumber(line.lineTotal)"
                            [currency]="o.currency"
                            taxMention="excluded"
                          />
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>

              <aside class="aside">
                <section class="totals" aria-labelledby="account-order-totals-title">
                  <h2 id="account-order-totals-title" class="section-title">
                    {{ strings().account.orderDetail.totalsTitle }}
                  </h2>
                  <dl class="totals-list">
                    <div class="row">
                      <dt>{{ strings().account.orderDetail.subtotal }}</dt>
                      <dd>
                        <app-price
                          [amount]="toNumber(o.subtotal)"
                          [currency]="o.currency"
                          taxMention="excluded"
                        />
                      </dd>
                    </div>
                    @if (o.shippingMethodName || toNumber(o.shippingAmount) > 0) {
                      <div class="row">
                        <dt>
                          {{ strings().account.orderDetail.shipping }}
                          @if (o.shippingMethodName) {
                            <span class="method" data-testid="account-order-shipping-method">{{
                              o.shippingMethodName
                            }}</span>
                          }
                        </dt>
                        <dd>
                          <app-price
                            [amount]="toNumber(o.shippingAmount)"
                            [currency]="o.currency"
                            taxMention="none"
                          />
                        </dd>
                      </div>
                    }
                    @if (toNumber(o.taxAmount) > 0) {
                      <div class="row">
                        <dt>{{ strings().account.orderDetail.tax }}</dt>
                        <dd>
                          <app-price
                            [amount]="toNumber(o.taxAmount)"
                            [currency]="o.currency"
                            taxMention="none"
                          />
                        </dd>
                      </div>
                    }
                    @if (toNumber(o.discountAmount) > 0) {
                      <div class="row" data-testid="account-order-discount">
                        <dt>{{ strings().account.orderDetail.discount }}</dt>
                        <!-- One flex row: the sign and the amount are a single
                             quantity and must never wrap apart (finding K8). -->
                        <dd class="signed-amount">
                          <bdi>-{{ formattedAmount(o.discountAmount, o.currency) }}</bdi>
                        </dd>
                      </div>
                    }
                    <div class="row total">
                      <dt>{{ strings().account.orderDetail.total }}</dt>
                      <dd>
                        <app-price
                          [amount]="toNumber(o.total)"
                          [currency]="o.currency"
                          taxMention="included"
                        />
                      </dd>
                    </div>
                  </dl>
                </section>

                @if (o.shippingAddress) {
                  <section class="address-section" aria-labelledby="account-order-shipping-title">
                    <h2 id="account-order-shipping-title" class="section-title">
                      {{ strings().account.orderDetail.shippingAddressTitle }}
                    </h2>
                    <p class="address-block">{{ formatAddress(o.shippingAddress) }}</p>
                  </section>
                }

                @if (o.billingAddress) {
                  <section class="address-section" aria-labelledby="account-order-billing-title">
                    <h2 id="account-order-billing-title" class="section-title">
                      {{ strings().account.orderDetail.billingAddressTitle }}
                    </h2>
                    @if (sameAsShipping()) {
                      <p class="address-block">
                        {{ strings().account.orderDetail.sameAsShipping }}
                      </p>
                    } @else {
                      <p class="address-block">{{ formatAddress(o.billingAddress) }}</p>
                    }
                  </section>
                }
              </aside>
            </div>

            <section class="tracking" aria-labelledby="account-order-tracking-title">
              <h2 id="account-order-tracking-title" class="section-title">
                {{ strings().account.orderDetail.tracking.title }}
              </h2>
              @if (shipment(); as s) {
                <dl class="tracking-list">
                  @if (s.carrier) {
                    <div class="row">
                      <dt>{{ strings().account.orderDetail.tracking.carrierLabel }}</dt>
                      <dd>{{ s.carrier }}</dd>
                    </div>
                  }
                  @if (s.trackingNumber) {
                    <div class="row">
                      <dt>{{ strings().account.orderDetail.tracking.trackingNumberLabel }}</dt>
                      <dd>
                        @if (carrierLink(); as link) {
                          <a
                            class="carrier-link"
                            [href]="link"
                            target="_blank"
                            rel="noopener noreferrer"
                            [attr.aria-label]="carrierLinkLabel()"
                          >
                            {{ s.trackingNumber }}
                          </a>
                        } @else {
                          {{ s.trackingNumber }}
                        }
                      </dd>
                    </div>
                  }
                </dl>
              } @else {
                <!-- An order can reach DELIVERED without a Shipment row ever
                     being posted, and telling that customer their tracking will
                     appear once the order ships is simply wrong (prior K6). -->
                <p class="muted" data-testid="account-order-no-tracking">
                  {{ noTrackingMessage() }}
                </p>
              }
            </section>

            <app-order-status-timeline [events]="timelineEvents()" />

            <div class="actions">
              @if (canCancel()) {
                @if (!confirmCancel()) {
                  <app-button
                    variant="tertiary"
                    size="md"
                    [disabled]="cancelling()"
                    (clicked)="askCancel()"
                  >
                    {{ strings().account.orderDetail.cancel.cta }}
                  </app-button>
                } @else {
                  <div
                    class="confirm-cancel"
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="account-order-cancel-title"
                    aria-describedby="account-order-cancel-body"
                    data-testid="account-order-cancel-confirm"
                    cdkTrapFocus
                    cdkTrapFocusAutoCapture
                  >
                    <h3 id="account-order-cancel-title" class="confirm-title">
                      {{ strings().account.orderDetail.cancel.confirmTitle }}
                    </h3>
                    <p id="account-order-cancel-body">
                      {{ strings().account.orderDetail.cancel.confirmBody }}
                      @if (order()?.paymentStatus === 'AUTHORIZED') {
                        {{ strings().account.orderDetail.cancel.confirmCardHold }}
                      }
                    </p>
                    <div class="confirm-actions">
                      <app-button variant="tertiary" size="md" (clicked)="dismissCancel()">
                        {{ strings().account.orderDetail.cancel.confirmNo }}
                      </app-button>
                      <app-button
                        variant="primary"
                        size="md"
                        [loading]="cancelling()"
                        (clicked)="confirmCancelOrder()"
                      >
                        {{ strings().account.orderDetail.cancel.confirmYes }}
                      </app-button>
                    </div>
                  </div>
                }
              }
              <app-button
                variant="secondary"
                size="md"
                [loading]="invoicing()"
                [disabled]="!canDownloadInvoice()"
                (clicked)="downloadInvoice()"
              >
                {{
                  invoicing()
                    ? strings().account.orderDetail.invoice.downloading
                    : strings().account.orderDetail.invoice.downloadCta
                }}
              </app-button>
              @if (invoiceReason(); as reason) {
                <p class="muted invoice-reason" data-testid="account-order-invoice-reason">
                  {{ reason }}
                </p>
              }
              @if (invoiceError()) {
                <p class="cancel-error" role="alert" data-testid="account-order-invoice-error">
                  {{ invoiceError() }}
                </p>
              }
            </div>
          }
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        padding-block: 1.5rem;
        padding-inline: 1rem;
        max-inline-size: 1280px;
        margin-inline: auto;
      }
      .header {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .back-link {
        color: var(--brand-primary);
        text-decoration: none;
        font-size: var(--brand-text-body);
      }
      .back-link:hover {
        text-decoration: underline;
      }
      .back-link:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md page title */
        font-size: clamp(var(--brand-text-display-mobile), 4vw, var(--brand-text-display));
        font-weight: 700;
        color: var(--brand-text);
      }
      .placed-at {
        margin: 0;
        color: var(--brand-text-muted);
        font-size: var(--brand-text-micro);
      }
      .status-row {
        display: flex;
        gap: 0.5rem;
        margin-block-start: 0.5rem;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 1.25rem;
      }
      @media (min-width: 960px) {
        .grid {
          grid-template-columns: minmax(0, 1fr) 320px;
        }
      }
      .method {
        display: block;
        font-size: var(--brand-text-micro, 0.75rem);
        color: var(--brand-text-muted);
        font-weight: 400;
      }
      .section-title {
        margin: 0;
        margin-block-end: 0.5rem;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .items-table {
        inline-size: 100%;
        border-collapse: collapse;
        font-size: var(--brand-text-body);
      }
      .items-table thead th {
        text-align: start;
        color: var(--brand-text-muted);
        font-weight: 500;
        padding-block: 0.5rem;
        border-block-end: 1px solid var(--brand-border);
      }
      .review-link {
        display: block;
        margin-block-start: 0.25rem;
        font-size: var(--brand-text-micro);
        color: var(--brand-primary);
      }
      /* Inline padding as well as block. Without it the narrow, right-aligned
         Qty and Unit-price columns butt straight up against each other and
         read as one token: "1QAR 480.00". */
      .items-table thead th,
      .items-table tbody td {
        padding-inline: 0.5rem;
      }
      .items-table thead th:first-child,
      .items-table tbody td:first-child {
        padding-inline-start: 0;
      }
      .items-table thead th:last-child,
      .items-table tbody td:last-child {
        padding-inline-end: 0;
      }
      .items-table tbody td {
        padding-block: 0.625rem;
        border-block-end: 1px solid var(--brand-border);
        color: var(--brand-text);
      }
      .items-table .numeric {
        text-align: end;
        /* Qty and the money columns sat flush against the description
           (finding K8). */
        padding-inline-start: 1rem;
      }
      .payment-row {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.375rem;
        margin: 0;
        margin-block-start: 0.375rem;
        color: var(--brand-text-muted);
        font-size: var(--brand-text-body);
      }
      .payment-value {
        color: var(--brand-text);
      }
      .signed-amount {
        display: flex;
        align-items: baseline;
        gap: 0.125rem;
      }
      .invoice-reason {
        margin-block: 0.375rem 0;
        font-size: var(--brand-text-micro);
      }
      .aside {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .totals,
      .address-section {
        background-color: var(--brand-surface);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
        padding-block: 0.875rem;
        padding-inline: 1rem;
      }
      .totals-list,
      .tracking-list {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        margin: 0;
      }
      .row dt {
        margin: 0;
        color: var(--brand-text-muted);
      }
      /* agent_docs/storefront/brand-tokens.md — mandatory wherever numbers stack. */
      .row dd {
        font-variant-numeric: tabular-nums;
      }
      .row dd {
        margin: 0;
        color: var(--brand-text);
      }
      .row.total {
        font-weight: 600;
        font-size: var(--brand-text-product, 1rem);
        margin-block-start: 0.375rem;
        padding-block-start: 0.375rem;
        border-block-start: 1px solid var(--brand-border);
      }
      .address-block {
        margin: 0;
        color: var(--brand-text);
        font-size: var(--brand-text-body);
        white-space: pre-wrap;
      }
      .tracking {
        background-color: var(--brand-surface);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
        padding-block: 0.875rem;
        padding-inline: 1rem;
      }
      .muted {
        margin: 0;
        color: var(--brand-text-muted);
      }
      .carrier-link {
        color: var(--brand-primary);
      }
      .carrier-link:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        align-items: center;
      }
      .confirm-cancel {
        flex: 1 1 100%;
        background-color: var(--brand-surface-strong);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
        padding-block: 0.875rem;
        padding-inline: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .confirm-title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .confirm-actions {
        display: flex;
        gap: 0.5rem;
      }
      .cancel-message {
        margin: 0;
        color: var(--brand-text);
      }
      .cancel-error {
        margin: 0;
        color: var(--brand-error);
      }
      .loading {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        color: var(--brand-text-muted);
        padding-block: 1rem;
      }
      .status-title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md page title */
        font-size: clamp(var(--brand-text-display-mobile), 4vw, var(--brand-text-display));
        font-weight: 700;
        color: var(--brand-text);
      }
      .status-message {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        align-items: start;
        padding-block: 2.5rem;
      }
      .error {
        margin: 0;
        padding-block: 0.75rem;
        padding-inline: 0.875rem;
        background-color: var(--brand-surface-strong);
        color: var(--brand-error);
        border-inline-start: 3px solid var(--brand-error);
        border-radius: var(--brand-radius-sm);
      }
    `,
  ],
})
export class AccountOrderDetailPageComponent implements OnInit {
  private readonly locale = inject(LocaleService);
  private readonly storeConfig = inject(StoreConfigService);
  private readonly authState = inject(AuthStateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly ordersSvc = inject(OrdersService);

  protected readonly strings = this.locale.strings;
  protected readonly state = signal<PageState>('idle');
  protected readonly order = signal<Order | null>(null);

  protected readonly confirmCancel = signal<boolean>(false);
  protected readonly cancelling = signal<boolean>(false);
  protected readonly cancelMessage = signal<string | null>(null);
  protected readonly cancelError = signal<string | null>(null);

  protected readonly invoicing = signal<boolean>(false);
  protected readonly invoiceError = signal<string | null>(null);

  protected readonly ordersListHref = computed(() =>
    APP_ROUTES.account.orders(this.locale.locale()),
  );

  protected readonly headingText = computed(() => {
    const o = this.order();
    if (!o) return '';
    return this.strings().account.orderDetail.heading.replace('{number}', o.orderNumber);
  });

  protected readonly placedAtText = computed(() => {
    const o = this.order();
    if (!o) return '';
    return this.strings().account.orderDetail.placedAt.replace(
      '{date}',
      this.formatDate(o.createdAt),
    );
  });

  protected readonly canCancel = computed(() => {
    const o = this.order() as (Order & { cancellable?: boolean }) | null;
    // The server decides. This page used to keep its own status allowlist,
    // which was wider than the API rule and offered a button the endpoint
    // answered with a 409 (finding AD4). Absent means an older API, and the
    // safe reading of absent is "do not offer it".
    return o?.cancellable === true;
  });

  /**
   * Finding K12 and prior K7. This used to guess from the status, and the guess
   * was wrong in both directions: it offered a download for a DELIVERED order
   * that has no invoice, and refused one for a CANCELLED order that does,
   * because cancelling after confirmation leaves the issued invoice in place.
   * The order carries the answer, so read it.
   */
  protected readonly canDownloadInvoice = computed(() => this.order()?.invoice != null);

  /**
   * Why the download is unavailable, or null when it is available. A disabled
   * button with no explanation is the defect; the two reasons are the two
   * situations a customer can actually be in.
   */
  protected readonly invoiceReason = computed<string | null>(() => {
    const o = this.order();
    if (!o || o.invoice != null) return null;
    const copy = this.strings().account.orderDetail.invoice;
    if (o.status === 'CANCELLED') return copy.reasonCancelled;
    return o.status === 'PENDING' ? copy.reasonNotConfirmed : copy.reasonPreparing;
  });

  protected readonly paymentMethodLabel = computed<string>(() => {
    const copy = this.strings().account.orderDetail.payment;
    // Null means "not recorded", and on a cash-on-delivery-only store that is
    // what every order placed before plan F phase F5 looks like.
    return this.order()?.paymentMethodName?.trim() || copy.cashOnDelivery;
  });

  protected readonly paymentStatusLabel = computed<string>(() => {
    const labels = this.strings().account.orderDetail.payment.statusLabels;
    const status = this.order()?.paymentStatus;
    return status ? (labels[status] ?? labels.PENDING) : labels.PENDING;
  });

  protected readonly noTrackingMessage = computed<string>(() => {
    const o = this.order();
    const copy = this.strings().account.orderDetail.tracking;
    if (!o) return copy.noneYet;
    if (o.status === 'DELIVERED') {
      // `deliveredAt` is the one transition time the order row keeps.
      return o.deliveredAt
        ? copy.deliveredOn.replace('{date}', this.formatDate(o.deliveredAt))
        : copy.shippedNoDetails;
    }
    if (o.status === 'SHIPPED') return copy.shippedNoDetails;
    return copy.noneYet;
  });

  protected readonly sameAsShipping = computed(() => {
    const o = this.order();
    if (!o || !o.shippingAddress || !o.billingAddress) return false;
    return JSON.stringify(o.shippingAddress) === JSON.stringify(o.billingAddress);
  });

  protected readonly shipment = computed<ShipmentInfo | null>(() => {
    const o = this.order() as (Order & { shipments?: ShipmentInfo[] }) | null;
    const shipments = o?.shipments;
    if (!Array.isArray(shipments) || shipments.length === 0) return null;
    return shipments[0] ?? null;
  });

  protected readonly carrierLink = computed<string | null>(() => {
    const s = this.shipment();
    return carrierTrackingUrl(s?.carrier, s?.trackingNumber);
  });

  protected readonly carrierLinkLabel = computed<string>(() => {
    const s = this.shipment();
    if (!s?.trackingNumber) return this.strings().account.orderDetail.tracking.carrierLink;
    return `${this.strings().account.orderDetail.tracking.carrierLink} (${s.trackingNumber})`;
  });

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.confirmCancel()) this.dismissCancel();
  }

  protected readonly timelineEvents = computed<OrderTimelineEvent[]>(() => {
    const o = this.order() as
      | (Order & {
          statusHistory?: { status: OrderStatus; at: string; note?: string }[];
        })
      | null;
    if (!o) return [];
    // No fallback. The API records every transition since plan M phase M2, so
    // an empty history means there is nothing to show yet, and synthesising a
    // row from `{ status, createdAt }` made a real event out of the absence:
    // a DELIVERED order rendered one row reading "delivered" stamped with the
    // time it was placed (finding AD6).
    if (!Array.isArray(o.statusHistory)) return [];
    return o.statusHistory.map((e) => ({ status: e.status, at: e.at, note: e.note ?? null }));
  });

  ngOnInit(): void {
    this.title.setTitle(
      pageTitle(this.strings().account.meta.orderDetailTitle, this.strings().brand.name),
    );
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });

    if (!isPlatformBrowser(this.platformId)) return;
    void this.init();
  }

  /**
   * Browser-side entry. The state flips to `'loading'` BEFORE the guard is
   * awaited so the page never sits in the unrendered `'idle'` branch while
   * the session boot settles (finding N4).
   */
  private async init(): Promise<void> {
    this.state.set('loading');
    if (
      !(await ensureAuthedForAccount(
        { authState: this.authState, locale: this.locale, router: this.router },
        this.router.url,
      ))
    ) {
      return;
    }
    void this.load();
  }

  private async load(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.state.set('not-found');
      return;
    }
    this.state.set('loading');
    try {
      const order = await this.ordersSvc.getById(id);
      this.order.set(order);
      this.state.set('ready');
    } catch (cause) {
      if (cause instanceof StorefrontUnauthorizedError) {
        this.authState.clearSession();
        void ensureAuthedForAccount(
          { authState: this.authState, locale: this.locale, router: this.router },
          this.router.url,
        );
        return;
      }
      if (cause instanceof StorefrontForbiddenError) {
        this.state.set('not-yours');
        return;
      }
      if (cause instanceof StorefrontNotFoundError) {
        this.state.set('not-found');
        return;
      }
      if (cause instanceof StorefrontError) {
        this.state.set('error');
        return;
      }
      this.state.set('error');
    }
  }

  protected askCancel(): void {
    this.cancelError.set(null);
    this.confirmCancel.set(true);
  }

  protected dismissCancel(): void {
    this.confirmCancel.set(false);
  }

  protected async confirmCancelOrder(): Promise<void> {
    if (this.cancelling()) return;
    const o = this.order();
    if (!o) return;
    this.cancelling.set(true);
    this.cancelError.set(null);
    try {
      const updated = await this.ordersSvc.cancel(o.id);
      this.order.set(updated);
      this.cancelMessage.set(this.strings().account.orderDetail.cancel.success);
      this.confirmCancel.set(false);
    } catch (cause) {
      const code =
        cause !== null && typeof cause === 'object' && 'code' in cause
          ? String((cause as { code: string }).code)
          : null;
      if (code === 'ORDER_CANCEL_INELIGIBLE' || cause instanceof StorefrontConflictError) {
        const copy = this.strings().account.orderDetail.cancel;
        // The server names which refusal it is, so the customer gets a next
        // step instead of a dead end.
        this.cancelError.set(
          this.cancelRefusalReason(cause) === 'HAS_SHIPMENT' ? copy.hasShipment : copy.ineligible,
        );
      } else {
        this.cancelError.set(this.strings().account.orderDetail.cancel.error);
      }
    } finally {
      this.cancelling.set(false);
    }
  }

  /** `details.reason` off an ORDER_CANCEL_INELIGIBLE conflict, when present. */
  private cancelRefusalReason(cause: unknown): string | null {
    if (cause === null || typeof cause !== 'object' || !('details' in cause)) return null;
    const details = (cause as { details?: unknown }).details;
    if (details === null || typeof details !== 'object' || !('reason' in details)) return null;
    const reason = (details as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : null;
  }

  protected async downloadInvoice(): Promise<void> {
    if (this.invoicing()) return;
    const o = this.order();
    if (!o) return;
    this.invoicing.set(true);
    this.invoiceError.set(null);
    try {
      const invoice = (await this.ordersSvc.invoice(o.id)) as {
        downloadUrl?: string;
        url?: string;
      };
      const href = invoice.downloadUrl ?? invoice.url;
      if (href && typeof window !== 'undefined') {
        window.location.href = href;
      } else {
        this.invoiceError.set(this.strings().account.orderDetail.invoice.error);
      }
    } catch (cause) {
      const code =
        cause !== null && typeof cause === 'object' && 'code' in cause
          ? String((cause as { code: string }).code)
          : null;
      if (code === 'ORDER_INVOICE_NOT_READY' || cause instanceof StorefrontNotFoundError) {
        this.invoiceError.set(this.strings().account.orderDetail.invoice.notReady);
      } else {
        this.invoiceError.set(this.strings().account.orderDetail.invoice.error);
      }
    } finally {
      this.invoicing.set(false);
    }
  }

  protected toNumber(value: unknown): number {
    if (value === undefined || value === null || value === '') return 0;
    return Number(value);
  }

  /**
   * The catalogue route for an order line, or null when there is nothing live
   * to point at.
   *
   * The name cell was plain text, so a placed order was a dead end: nothing
   * led back to the product. The API sends `productSlug` per line only when
   * the product still exists, so an item bought and later archived falls back
   * to plain text rather than a link into a 404.
   */
  protected productHref(line: unknown): string | null {
    const slug = (line as { productSlug?: unknown } | null)?.productSlug;
    return typeof slug === 'string' && slug.length > 0
      ? APP_ROUTES.product(this.locale.locale(), slug)
      : null;
  }

  /**
   * The product's reviews section, for a line the customer has received.
   *
   * The one moment a customer is both eligible and motivated to review had no
   * path to the form. Eligibility is a DELIVERED or COMPLETED order carrying
   * the product, the same rule `getReviewEligibility` enforces server-side.
   *
   * A full-path href, not a bare `#reviews`: a fragment-only href resolves
   * against `<base href="/">` and navigates to the home page.
   */
  protected reviewHref(status: string | undefined, line: unknown): string | null {
    if (status !== 'DELIVERED' && status !== 'COMPLETED') return null;
    const product = this.productHref(line);
    return product ? `${product}#reviews` : null;
  }

  /**
   * One formatted string for the amount and its sign.
   *
   * The discount row rendered a text-node minus next to the price component,
   * which is a flex host, so the sign sat alone on its line and the amount
   * wrapped underneath it. The confirmation page already emitted a single
   * `bdi`; this matches it.
   */
  protected formattedAmount(value: unknown, currency: string): string {
    return formatMoney(this.toNumber(value), this.storeConfig.money(), currency);
  }

  protected resolveName(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      return pickTranslation(value as never, this.locale.locale()) ?? '';
    }
    return '';
  }

  /**
   * The stored value is an ISO 3166-1 alpha-2 code, and the page printed it raw,
   * so a customer read the bare code on their own order (finding K8). The code
   * itself is the fallback: an unrecognised one still has to render something.
   */
  private countryName(code: unknown): string {
    if (typeof code !== 'string' || code.length !== 2) {
      return typeof code === 'string' ? code : '';
    }
    try {
      const tag = LOCALE_INTL_TAG[this.locale.locale()];
      // `fallback: 'code'` is explicit rather than relied on: an unmapped code
      // has to come back as itself, never as an empty line.
      return (
        new Intl.DisplayNames([tag], { type: 'region', fallback: 'code' }).of(code.toUpperCase()) ??
        code
      );
    } catch {
      return code;
    }
  }

  protected formatAddress(addr: unknown): string {
    if (!addr || typeof addr !== 'object') return '';
    const a = addr as Record<string, unknown>;
    const lines = [
      a['fullName'],
      a['addressLine1'],
      a['addressLine2'],
      [a['city'], a['state'], a['postalCode']].filter(Boolean).join(', '),
      this.countryName(a['country']),
      a['phone'],
    ]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0);
    return lines.join('\n');
  }

  private formatDate(value: string): string {
    const tag = LOCALE_INTL_TAG[this.locale.locale()];
    try {
      return new Intl.DateTimeFormat(tag, { dateStyle: 'medium' }).format(new Date(value));
    } catch {
      return value;
    }
  }
}

export default AccountOrderDetailPageComponent;

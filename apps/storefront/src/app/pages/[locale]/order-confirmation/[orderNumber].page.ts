import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { CheckoutService, OrdersService } from '@storefront-services';
import type { Order, PaymentAction, StorefrontCheckoutSettings } from '@storefront-types';
import { StorefrontUnauthorizedError } from '@storefront-types';

import { EmbeddedPaymentHostComponent } from '../../../sections/checkout/embedded-payment-host.component';
import {
  browserPaymentActionEnv,
  runPaymentAction,
} from '../../../sections/checkout/payment-action';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { APP_ROUTES, TRACK_ORDER_QUERY_PARAM } from '../../../../lib/routes';
import { DEFAULT_LOCALE, LOCALE_INTL_TAG, type Locale } from '../../../../i18n/types';
import { formatMoney } from '../../../../lib/money';
import { pageTitle } from '../../../../lib/seo';
import { StoreConfigService } from '../../../services/store-config.service';

/**
 * `guest-track` is an anonymous visitor holding an order number but no way to
 * prove the order is theirs: a deep link, a shared URL, or a return long after
 * the cart session expired. This page used to answer all of those with a login
 * form, which is useless to someone who has no account (finding K3).
 */
const PROVIDER_RETURN_PARAMS = [
  'payment_intent',
  'payment_intent_client_secret',
  'redirect_status',
  'setup_intent',
  'setup_intent_client_secret',
] as const;

type PageState = 'loading' | 'ready' | 'not-found' | 'error' | 'guest-track';

/**
 * S10 order-confirmation page. Reads `orderNumber` from the route params,
 * resolves it to the full order via either the navigation-state hint
 * (router.getCurrentNavigation().extras.state.orderId — written by the
 * checkout page on success) or a fallback list+find against `orders.list`.
 *
 * OwnerGuard at the API edge guarantees the customer never sees another
 * customer's order — the fallback list is scoped to req.user.id by the
 * backend per docs/storefront-api-reference.md:605-616.
 */
@Component({
  selector: 'app-order-confirmation-page',
  standalone: true,
  imports: [RouterLink, EmbeddedPaymentHostComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page" data-testid="order-confirmation-page">
      @if (state() === 'loading') {
        <p class="state" role="status" aria-live="polite">
          {{ strings().orderConfirmation.loading }}
        </p>
      } @else if (state() === 'not-found') {
        <section class="state" data-testid="order-confirmation-not-found">
          <div role="alert">
            <h1 class="not-found-title">{{ strings().orderConfirmation.notFoundTitle }}</h1>
            <p>{{ strings().orderConfirmation.notFoundBody }}</p>
          </div>
          <a class="cta primary" [routerLink]="homeHref()">
            {{ strings().orderConfirmation.notFoundCta }}
          </a>
        </section>
      } @else if (state() === 'guest-track') {
        <section class="state" data-testid="order-confirmation-guest-track">
          <h1 class="not-found-title">{{ strings().orderConfirmation.guestTrackTitle }}</h1>
          <p>{{ strings().orderConfirmation.guestTrackBody }}</p>
          <a
            class="cta primary"
            [routerLink]="guestTrackHref()"
            [queryParams]="guestTrackQueryParams()"
          >
            {{ strings().orderConfirmation.publicTrackCta }}
          </a>
          <a class="cta secondary" [routerLink]="homeHref()">
            {{ strings().orderConfirmation.notFoundCta }}
          </a>
        </section>
      } @else if (state() === 'error') {
        <p class="state" role="alert">{{ strings().orderConfirmation.loadError }}</p>
      } @else if (state() === 'ready' && order(); as o) {
        <header class="head">
          <h1 class="heading">
            {{
              o.status === 'CANCELLED'
                ? strings().orderConfirmation.cancelledHeading
                : strings().orderConfirmation.heading
            }}
          </h1>
          <p class="order-number" data-testid="order-confirmation-number">
            {{ subheading() }}
          </p>
          <p class="delivery">{{ deliveryText() }}</p>
        </header>

        <section class="card" aria-labelledby="oc-items-title">
          <h2 id="oc-items-title" class="card-title">
            {{ strings().orderConfirmation.itemsSection.title }}
          </h2>
          <ul class="items">
            @for (line of o.items; track line.id) {
              <li class="item" [attr.data-line-id]="line.id">
                <span class="qty"
                  ><span>{{ line.quantity }}×</span></span
                >
                <span class="name">{{ resolveName(line.productName) }}</span>
                <span class="amount"
                  ><span>{{ formatted(lineTotal(line)) }}</span>
                  @if (taxMentionCatalogue(); as mention) {
                    <span class="tax-mention">{{ mention }}</span>
                  }
                </span>
              </li>
            }
          </ul>
        </section>

        @if (o.shippingAddress; as addr) {
          <section class="card" aria-labelledby="oc-address-title">
            <h2 id="oc-address-title" class="card-title">
              {{ strings().orderConfirmation.addressSection.title }}
            </h2>
            <p class="address">{{ formatAddress(addr) }}</p>
          </section>
        }

        <section class="card totals" aria-labelledby="oc-summary-title">
          <h2 id="oc-summary-title" class="card-title">
            {{ strings().orderConfirmation.summarySection.title }}
          </h2>
          <dl class="rows">
            <div class="row">
              <dt>{{ strings().orderConfirmation.summarySection.subtotal }}</dt>
              <dd>
                <span>{{ formatted(Number(o.subtotal)) }}</span>
                @if (taxMentionCatalogue(); as mention) {
                  <span class="tax-mention">{{ mention }}</span>
                }
              </dd>
            </div>
            @if (Number(o.discountAmount ?? 0) > 0) {
              <div class="row">
                <dt>{{ strings().orderConfirmation.summarySection.discount }}</dt>
                <dd>
                  <span>-{{ formatted(Number(o.discountAmount ?? 0)) }}</span>
                </dd>
              </div>
            }
            <div class="row">
              <dt>
                {{ strings().orderConfirmation.summarySection.shipping }}
                @if (o.shippingMethodName) {
                  <span class="method">{{ o.shippingMethodName }}</span>
                }
              </dt>
              <dd>
                @if (Number(o.shippingAmount ?? 0) > 0) {
                  <span data-testid="order-confirmation-shipping">{{
                    formatted(Number(o.shippingAmount ?? 0))
                  }}</span>
                } @else {
                  <span>{{ strings().orderConfirmation.summarySection.shippingFree }}</span>
                }
              </dd>
            </div>
            @if (Number(o.taxAmount ?? 0) > 0) {
              <div class="row">
                <dt>{{ strings().orderConfirmation.summarySection.tax }}</dt>
                <dd>
                  <span>{{ formatted(Number(o.taxAmount ?? 0)) }}</span>
                </dd>
              </div>
            }
            <!-- Finding K7: the confirmation never said how the order was
                 paid, so the one page a customer reads right after placing it
                 could not say the thing they most want confirmed. -->
            <div class="row" data-testid="order-confirmation-payment">
              <dt>{{ strings().orderConfirmation.summarySection.payment }}</dt>
              <dd>
                <span>{{ paymentMethodLabel() }}</span>
              </dd>
            </div>
            @if (paymentStatusText(); as statusText) {
              <div class="row">
                <dt>{{ strings().orderConfirmation.paymentStatusLabel }}</dt>
                <dd>
                  <span data-testid="order-confirmation-payment-status">{{ statusText }}</span>
                </dd>
              </div>
            }
            <div class="row total">
              <dt>{{ strings().orderConfirmation.summarySection.total }}</dt>
              <dd>
                <span data-testid="order-confirmation-total">{{ formatted(Number(o.total)) }}</span>
                <!-- order.total is composed as taxableBase + shipping + tax in
                     orders.service.ts, so the tax-inclusive mention is the
                     truthful one here, for a store that shows a mention. -->
                @if (taxMentionIncluded(); as mention) {
                  <span class="tax-mention" data-testid="order-confirmation-tax-mention">{{
                    mention
                  }}</span>
                }
              </dd>
            </div>
          </dl>
        </section>

        @if (paymentError(); as message) {
          <p class="state" role="alert" data-testid="order-confirmation-payment-error">
            {{ message }}
          </p>
        }
        @if (embeddedAction(); as embedded) {
          <section data-testid="order-confirmation-embedded">
            <h2>{{ strings().orderConfirmation.paymentEmbeddedTitle }}</h2>
            <app-embedded-payment-host [action]="embedded" [returnUrl]="returnUrl()" />
          </section>
        }

        <div class="actions">
          @if (canPayAgain()) {
            <button
              type="button"
              class="cta primary"
              [disabled]="payAgainBusy()"
              (click)="payAgain()"
              data-testid="order-confirmation-pay-again"
            >
              {{
                payAgainBusy()
                  ? strings().orderConfirmation.payAgainBusy
                  : strings().orderConfirmation.payAgainCta
              }}
            </button>
          }
          <a
            class="cta primary"
            [routerLink]="trackingHref()"
            data-testid="order-confirmation-tracking"
          >
            {{ strings().orderConfirmation.trackingCta }}
          </a>
          <!-- The public track page had zero inbound links anywhere in the
               app (finding N3). This is the surface that has the order number
               in hand and serves the customer most likely to lose their
               session, so it is where that page gets its entrance. -->
          <a
            class="cta secondary"
            [routerLink]="publicTrackHref()"
            [queryParams]="publicTrackQueryParams()"
            data-testid="order-confirmation-public-track"
          >
            {{ strings().orderConfirmation.publicTrackCta }}
          </a>
          <!-- postPurchaseRedirectUrl overrides where "keep shopping" goes,
               and nothing else. An automatic redirect would destroy this page,
               the order-number handoff and its e2e contract (decision K-F6). -->
          @if (continueShoppingIsExternal()) {
            <a
              class="cta secondary"
              [href]="continueShoppingHref()"
              rel="noopener"
              data-testid="order-confirmation-home"
            >
              {{ strings().orderConfirmation.continueShoppingCta }}
            </a>
          } @else {
            <a
              class="cta secondary"
              [routerLink]="continueShoppingHref()"
              data-testid="order-confirmation-home"
            >
              {{ strings().orderConfirmation.continueShoppingCta }}
            </a>
          }
        </div>
      }
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        background-color: var(--brand-bg);
      }
      .page {
        max-inline-size: 720px;
        margin-inline: auto;
        padding-inline: clamp(1rem, 4vw, 2rem);
        padding-block: clamp(1.5rem, 4vh, 3rem);
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        min-block-size: 100dvh;
      }
      .head {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .heading {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md page title */
        font-size: var(--brand-text-display);
        font-weight: 700;
        color: var(--brand-text);
      }
      .order-number {
        margin: 0;
        color: var(--brand-text-muted);
      }
      .delivery {
        margin: 0;
        color: var(--brand-text);
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding-block: 1rem;
        padding-inline: 1rem;
        border: 1px solid var(--brand-border);
      }
      .card-title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .items {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .item {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 0.75rem;
        font-size: var(--brand-text-body);
        color: var(--brand-text);
      }
      /* agent_docs/storefront/brand-tokens.md — mandatory wherever numbers stack. */
      .amount,
      .qty,
      .row dd {
        font-variant-numeric: tabular-nums;
      }
      .qty {
        color: var(--brand-text-muted);
      }
      .amount {
        font-weight: 600;
      }
      /* agent_docs/storefront/brand-tokens.md — every displayed price carries HT or TTC. */
      .tax-mention {
        margin-inline-start: 0.375rem;
        font-size: var(--brand-text-micro);
        font-weight: 500;
        color: var(--brand-text-muted);
        font-variant-numeric: normal;
      }
      .address {
        margin: 0;
        color: var(--brand-text);
      }
      .rows {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
      }
      .method {
        display: block;
        font-size: var(--brand-text-micro);
        color: var(--brand-text-muted);
        font-weight: 400;
      }
      .row.total {
        padding-block-start: 0.5rem;
        border-block-start: 1px solid var(--brand-border);
        font-weight: 600;
        font-size: var(--brand-text-product);
      }
      .row dt,
      .row dd {
        margin: 0;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
      }
      .cta {
        padding-inline: 1.25rem;
        padding-block: 0.75rem;
        font-weight: 600;
        text-decoration: none;
      }
      .cta.primary {
        background-color: var(--brand-primary);
        color: var(--brand-on-primary);
      }
      .cta.secondary {
        border: 1px solid var(--brand-primary);
        color: var(--brand-primary);
        background: transparent;
      }
      .cta:focus-visible {
        outline: 2px solid var(--brand-text);
        outline-offset: 2px;
      }
      .state {
        margin: 0;
        color: var(--brand-text);
      }
      .not-found-title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md page title */
        font-size: clamp(var(--brand-text-display-mobile), 4vw, var(--brand-text-display));
        font-weight: 700;
        color: var(--brand-text);
      }
    `,
  ],
})
export default class OrderConfirmationPage implements OnInit, OnDestroy {
  protected readonly state = signal<PageState>('loading');
  protected readonly order = signal<Order | null>(null);

  protected readonly Number = Number;

  private readonly platformId = inject(PLATFORM_ID);
  private readonly storeConfig = inject(StoreConfigService);
  private readonly route = inject(ActivatedRoute);
  private readonly orders = inject(OrdersService);
  private readonly checkoutSvc = inject(CheckoutService);
  private readonly authState = inject(AuthStateService);
  private readonly router = inject(Router);
  private readonly meta = inject(Meta);
  private readonly title = inject(Title);
  private readonly locale = inject(LocaleService);
  private readonly document = inject(DOCUMENT);
  protected readonly strings = this.locale.strings;

  protected returnUrl(): string {
    const number = this.order()?.orderNumber ?? this.orderNumberParam() ?? '';
    const path = APP_ROUTES.orderConfirmation(this.locale.locale(), number);
    return `${this.document.location.origin}${path}`;
  }

  protected readonly homeHref = computed(() => APP_ROUTES.home(this.locale.locale()));

  /**
   * The operator's post-purchase destination, when they configured one. This
   * setting had no consumer at all: the admin round-tripped it into a void
   * (finding D1).
   */
  private readonly settings = signal<StorefrontCheckoutSettings | null>(null);

  protected readonly continueShoppingHref = computed(
    () => this.settings()?.checkout?.postPurchaseRedirectUrl || this.homeHref(),
  );

  /** An operator URL may live off-site; a route never does. */
  protected readonly continueShoppingIsExternal = computed(() =>
    /^https?:\/\//i.test(this.continueShoppingHref()),
  );
  protected readonly trackingHref = computed(() => {
    const o = this.order();
    return o
      ? APP_ROUTES.account.order(this.locale.locale(), o.id)
      : APP_ROUTES.home(this.locale.locale());
  });

  /**
   * Null means "not recorded", which is every order placed before plan F phase
   * F5 wires the write, and on a cash-on-delivery-only store that is the real
   * answer rather than a gap. Same rule as the account order-detail page.
   */
  protected readonly paymentMethodLabel = computed<string>(
    () =>
      this.order()?.paymentMethodName?.trim() ||
      this.strings().account.orderDetail.payment.cashOnDelivery,
  );

  /** Route param, kept so the guest-track panel can prefill the number. */
  private readonly orderNumberParam = signal<string | null>(null);

  protected readonly guestTrackHref = computed(() => APP_ROUTES.track(this.locale.locale()));

  protected readonly guestTrackQueryParams = computed<Record<string, string>>(() => {
    const n = this.orderNumberParam();
    const params: Record<string, string> = {};
    if (n) params[TRACK_ORDER_QUERY_PARAM] = n;
    return params;
  });

  protected readonly publicTrackHref = computed(() =>
    this.order() ? APP_ROUTES.track(this.locale.locale()) : APP_ROUTES.home(this.locale.locale()),
  );

  /**
   * Prefills the track form with the order NUMBER, never the internal id: the
   * lookup is keyed by number and the id would never resolve. Bound through
   * `[queryParams]` rather than baked into the path, because `routerLink`
   * percent-encodes a `?` it finds inside one.
   */
  protected readonly publicTrackQueryParams = computed<Record<string, string>>(() => {
    const o = this.order();
    const params: Record<string, string> = {};
    if (o) params[TRACK_ORDER_QUERY_PARAM] = o.orderNumber;
    return params;
  });

  protected readonly subheading = computed(() => {
    const o = this.order();
    if (!o) return '';
    return this.strings().orderConfirmation.subheading.replace('{orderNumber}', o.orderNumber);
  });

  protected readonly deliveryText = computed(() => {
    const o = this.order();
    if (!o) return '';
    const eta = (o as { estimatedDeliveryAt?: string }).estimatedDeliveryAt;
    if (!eta) return this.strings().orderConfirmation.deliveryEstimateUnknown;
    const locale: Locale = this.locale.locale();
    const formatted = new Intl.DateTimeFormat(LOCALE_INTL_TAG[locale], {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(eta));
    return this.strings().orderConfirmation.deliveryEstimate.replace('{date}', formatted);
  });

  /** Latest known payment status: the order's, then what the confirm call said. */
  private readonly confirmedStatus = signal<string | null>(null);
  protected readonly paymentError = signal<string | null>(null);
  protected readonly payAgainBusy = signal(false);
  protected readonly embeddedAction = signal<Extract<PaymentAction, { type: 'embedded' }> | null>(
    null,
  );

  private readonly paymentStatus = computed(
    () => this.confirmedStatus() ?? this.order()?.paymentStatus ?? null,
  );

  protected readonly paymentStatusText = computed<string | null>(() => {
    const o = this.order();
    const status = this.paymentStatus();
    if (!o?.paymentMethodCode || !status) return null;
    const copy = this.strings().orderConfirmation;
    // A pending order the API will not retry is offline (cash on delivery), not an unfinished online payment.
    if (status === 'PENDING' && o.paymentRetryable !== true && o.status !== 'CANCELLED')
      return copy.paymentOnDelivery;
    const labels = copy.paymentStatus as Record<string, string>;
    return labels[status] ?? status;
  });

  /**
   * `paymentRetryable` is read once with the order, so it goes stale when the
   * return confirmation moves the status. Same statuses the API retries on.
   */
  protected readonly canPayAgain = computed(() => {
    const status = this.paymentStatus();
    const order = this.order();
    return (
      order?.paymentRetryable === true &&
      order.status !== 'CANCELLED' &&
      (status === 'PENDING' || status === 'FAILED')
    );
  });

  /**
   * A provider may finish off-site and send the customer back here. The API
   * has no return-URL concept, so a still-pending order asks the provider for
   * the truth once per load. A failure leaves the stored status in place.
   */
  private async confirmOnReturn(order: Order): Promise<void> {
    if (!order.paymentMethodCode || order.paymentStatus !== 'PENDING') return;
    if (order.paymentRetryable !== true) return;
    try {
      this.confirmedStatus.set(await this.orders.confirmPayment(order.id, crypto.randomUUID()));
    } catch {
      // The stored status stays on screen; the pay-again button still works.
    }
  }

  protected async payAgain(): Promise<void> {
    const o = this.order();
    if (!o || this.payAgainBusy()) return;
    this.payAgainBusy.set(true);
    this.paymentError.set(null);
    try {
      const action = await this.orders.retryPayment(o.id, crypto.randomUUID());
      const outcome = runPaymentAction(action, browserPaymentActionEnv);
      if (outcome.kind === 'embedded') {
        this.embeddedAction.set(outcome.action);
      } else if (outcome.kind === 'done') {
        await this.confirmOnReturn({ ...o, paymentStatus: 'PENDING' });
      }
    } catch (cause) {
      this.paymentError.set(this.paymentErrorMessageFor(cause));
    } finally {
      this.payAgainBusy.set(false);
    }
  }

  private paymentErrorMessageFor(err: unknown): string {
    const errors = this.strings().checkout.errors;
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? String((err as { code: string }).code)
        : null;
    switch (code) {
      case 'ORDER_PAYMENT_NOT_RETRYABLE':
        return errors.paymentNotRetryable;
      case 'PAYMENT_PROVIDER_UNAVAILABLE':
      case 'PAYMENT_PROVIDER_REJECTED':
      case 'PAYMENT_CONFIG_ENCRYPTION_UNAVAILABLE':
      case 'PAYMENT_PROVIDER_UNKNOWN':
      case 'ORDER_PAYMENT_NOT_OPENED':
        return errors.paymentProviderUnavailable;
      case 'ORDER_PAYMENT_METHOD_UNAVAILABLE':
        return errors.paymentMethodUnavailable;
      default:
        return errors.generic;
    }
  }

  ngOnDestroy(): void {
    this.meta.removeTag("name='robots'");
  }

  ngOnInit(): void {
    this.title.setTitle(
      pageTitle(this.strings().orderConfirmation.meta.title, this.strings().brand.name),
    );
    this.meta.updateTag({
      name: 'description',
      content: this.strings().orderConfirmation.meta.description,
    });
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });

    if (!isPlatformBrowser(this.platformId)) return;

    this.stripProviderReturnParams();
    void this.bootstrap();
  }

  /**
   * A provider redirect appends its params to the return URL, and Stripe's
   * includes the PaymentIntent client secret. The server confirms the payment
   * by order id, so nothing here reads them; keeping them in the address bar
   * would leak the secret into history, shared links and referrers.
   */
  private stripProviderReturnParams(): void {
    const url = new URL(window.location.href);
    const found = PROVIDER_RETURN_PARAMS.filter((name) => url.searchParams.has(name));
    if (found.length === 0) return;
    found.forEach((name) => url.searchParams.delete(name));
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }

  private async bootstrap(): Promise<void> {
    // The boot OUTCOME, not a mid-flight read of it (finding N4). The public
    // checkout settings resolve alongside it: they decide where "keep
    // shopping" goes, and a failure there must never cost the customer their
    // confirmation, so it is swallowed and the CTA falls back to home.
    await Promise.all([
      this.authState.whenBooted(),
      this.checkoutSvc
        .getSettings()
        .then((s) => this.settings.set(s))
        .catch(() => undefined),
    ]);
    const orderNumber = this.route.snapshot.paramMap.get('orderNumber');
    if (!orderNumber) {
      this.state.set('not-found');
      return;
    }
    this.orderNumberParam.set(orderNumber);
    const orderIdHint = this.readOrderIdHint();
    const authed = this.authState.isAuthed();

    // A guest has no order list to search and no account to sign into. Without
    // the id from the create navigation there is nothing this page can prove,
    // so it hands them the public track page instead of a login form.
    if (!authed && !orderIdHint) {
      this.state.set('guest-track');
      return;
    }

    try {
      if (orderIdHint) {
        // Guest-capable since plan F phase F3: the API matches the anonymous
        // cart session that placed the order against its `guestSessionId`.
        const direct = await this.orders.getById(orderIdHint);
        if (direct.orderNumber === orderNumber) {
          this.order.set(direct);
          this.state.set('ready');
          void this.confirmOnReturn(direct);
          return;
        }
      }
      if (!authed) {
        // The hint did not resolve to this order and there is no list to fall
        // back to.
        this.state.set('guest-track');
        return;
      }
      // Fallback: list the most-recent N orders and locate by orderNumber.
      const list = await this.orders.list({ pageSize: 5 });
      const found = list.data.find((o) => o.orderNumber === orderNumber);
      if (!found) {
        this.state.set('not-found');
        return;
      }
      const detail = await this.orders.getById(found.id);
      this.order.set(detail);
      this.state.set('ready');
      void this.confirmOnReturn(detail);
    } catch (cause) {
      if (cause instanceof StorefrontUnauthorizedError) {
        // The row belongs to an account, so signing in is genuinely the remedy
        // here. It is not the remedy for a guest, which is why this branch is
        // reached from a failed read rather than from being anonymous.
        void this.router.navigateByUrl(
          `${APP_ROUTES.auth.login(this.locale.locale())}?from=${encodeURIComponent(
            `/${this.locale.locale()}/order-confirmation/${orderNumber}`,
          )}`,
        );
        return;
      }
      this.state.set('error');
    }
  }

  /**
   * The order id the create navigation carried.
   *
   * `getCurrentNavigation()` only answers while the navigation is in flight,
   * which is true for the redirect out of checkout and false for a reload. The
   * browser keeps navigation state across a reload in `history.state`, so a
   * guest who refreshes their confirmation still sees their order rather than
   * being bounced to the track page.
   */
  private readOrderIdHint(): string | null {
    const navState = this.router.getCurrentNavigation()?.extras?.state ?? null;
    const fromNav =
      navState && typeof navState === 'object' && 'orderId' in navState
        ? (navState as { orderId?: string }).orderId
        : null;
    if (fromNav) return fromNav;
    if (!isPlatformBrowser(this.platformId)) return null;
    const historyState = window.history.state as { orderId?: unknown } | null;
    return typeof historyState?.orderId === 'string' ? historyState.orderId : null;
  }

  protected lineTotal(line: { unitPrice: unknown; quantity: number; lineTotal?: unknown }): number {
    if (line.lineTotal != null) return Number(line.lineTotal);
    return Number(line.unitPrice ?? 0) * line.quantity;
  }

  protected resolveName(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const locale: Locale = this.locale.locale();
      const map = value as Record<string, string | undefined>;
      return map[locale] ?? map[DEFAULT_LOCALE] ?? '';
    }
    return '';
  }

  protected formatAddress(addr: unknown): string {
    if (!addr || typeof addr !== 'object') return '';
    const a = addr as Record<string, unknown>;
    const bits = [
      a['fullName'],
      a['addressLine1'],
      a['addressLine2'],
      a['city'],
      a['state'],
      a['postalCode'],
      a['country'],
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);
    return bits.join(', ');
  }

  /**
   * The two mentions this page renders, or null for a store that displays
   * none (`money.taxDisplay`).
   *
   * The line rows are catalogue prices, so they carry whatever the store
   * displays its catalogue as; labelling them tax-exclusive outright was the
   * same defect the price component had, fixed everywhere else and left here.
   * The order total is composed with tax in `orders.service.ts`, so it is the
   * tax-inclusive one whatever the catalogue quotes.
   */
  protected readonly taxMentionCatalogue = computed<string | null>(() => {
    const display = this.storeConfig.money().taxDisplay;
    if (display === 'none') return null;
    const generic = this.strings().generic;
    return display === 'TTC' ? generic.taxIncluded : generic.taxExcluded;
  });

  protected readonly taxMentionIncluded = computed<string | null>(() =>
    this.storeConfig.money().taxDisplay === 'none' ? null : this.strings().generic.taxIncluded,
  );

  protected formatted(value: number): string {
    return formatMoney(value, this.storeConfig.money(), this.order()?.currency);
  }
}

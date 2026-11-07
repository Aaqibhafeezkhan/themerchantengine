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
import { Router, RouterLink } from '@angular/router';

import { CartService, CheckoutService, OrdersService, UsersService } from '@storefront-services';
import type {
  Address,
  Cart,
  CreateOrderRequest,
  PaymentAction,
  ShippingMethodQuote,
  StorefrontCheckoutSettings,
  StorefrontPaymentMethod,
} from '@storefront-types';
import {
  StorefrontError,
  StorefrontUnauthorizedError,
  StorefrontConflictError,
} from '@storefront-types';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { AnalyticsTrackerService } from '../../../services/analytics-tracker.service';
import { APP_ROUTES } from '../../../../lib/routes';
import { ButtonComponent } from '../../../ui/button.component';
import { SpinnerComponent } from '../../../ui/spinner.component';
import { AddressPickerComponent } from '../../../sections/checkout/address-picker.component';
import {
  CheckoutStepShellComponent,
  type CheckoutStepState,
} from '../../../sections/checkout/checkout-step-shell.component';
import { EmbeddedPaymentHostComponent } from '../../../sections/checkout/embedded-payment-host.component';
import { OrderSummaryComponent } from '../../../sections/checkout/order-summary.component';
import { ShippingMethodStepComponent } from '../../../sections/checkout/shipping-method-step.component';
import {
  GuestContactComponent,
  type GuestContact,
} from '../../../sections/checkout/guest-contact.component';
import { PaymentMethodStepComponent } from '../../../sections/checkout/payment-method-step.component';
import { buildStepSummary } from '../../../sections/checkout/step-summary';
import { PlaceOrderCtaComponent } from '../../../sections/checkout/place-order-cta.component';
import {
  browserPaymentActionEnv,
  runPaymentAction,
} from '../../../sections/checkout/payment-action';
import { pageTitle } from '../../../../lib/seo';
import { formatMoney } from '../../../../lib/money';
import { resolveDiscountLabel } from '../../../sections/cart/discount-label';
import { StoreConfigService } from '../../../services/store-config.service';

type PageState = 'loading' | 'ready' | 'empty' | 'error' | 'unauthed';

/** 1 address, 2 delivery method, 3 summary, 4 payment, 5 place. */
type CheckoutStep = 1 | 2 | 3 | 4 | 5;

/**
 * S10 checkout page. SSR shell + browser-side hydration of cart + addresses.
 *
 * Idempotency-key generation: a single UUID is generated at the moment the
 * cart fetch resolves and held in a signal. The same key is reused across
 * (a) double-tap submit, (b) any browser-side retry on a transient error,
 * and (c) the optimistic page-revisit during the post-submit redirect
 * window. Constitution §3.6 — Redis dedup at the API guarantees the replay
 * returns the original order.
 */
@Component({
  selector: 'app-checkout-page',
  standalone: true,
  imports: [
    AddressPickerComponent,
    ButtonComponent,
    CheckoutStepShellComponent,
    EmbeddedPaymentHostComponent,
    GuestContactComponent,
    OrderSummaryComponent,
    PaymentMethodStepComponent,
    PlaceOrderCtaComponent,
    RouterLink,
    ShippingMethodStepComponent,
    SpinnerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page" data-testid="checkout-page">
      @if (state() === 'loading') {
        <div class="state" role="status" aria-live="polite">
          <app-spinner />
          <p>{{ strings().checkout.loading }}</p>
        </div>
      } @else if (state() === 'unauthed') {
        <div class="state" role="status">
          <p>{{ strings().checkout.errors.sessionExpired }}</p>
        </div>
      } @else if (state() === 'error') {
        <div class="state" role="alert">
          <p>{{ strings().checkout.loadError }}</p>
          <app-button variant="secondary" (clicked)="reload()">
            {{ strings().checkout.retry }}
          </app-button>
        </div>
      } @else if (state() === 'empty') {
        <section class="empty" data-testid="checkout-empty">
          <h1>{{ strings().checkout.emptyCartTitle }}</h1>
          <p>{{ strings().checkout.emptyCartBody }}</p>
          <a class="empty-cta" [routerLink]="cartHref()" data-testid="checkout-empty-cta">
            {{ strings().checkout.emptyCartCta }}
          </a>
        </section>
      } @else if (state() === 'ready') {
        <header class="head">
          <h1 class="heading">{{ strings().checkout.heading }}</h1>
        </header>

        @if (paymentUnavailable()) {
          <p class="blocked" role="alert" data-testid="checkout-payment-unavailable">
            {{ strings().checkout.steps.payment.empty }}
          </p>
        }

        <app-checkout-step-shell
          [step]="1"
          [title]="strings().checkout.steps.address.title"
          [state]="step1State()"
          [summaryText]="step1Summary()"
          (editClicked)="goToStep(1)"
        >
          @if (isGuest()) {
            <app-guest-contact
              [requiredFields]="requiredFields()"
              (contactChanged)="onGuestContactChanged($event)"
            />
            <p class="guest-signin">
              <a [routerLink]="loginHref()" data-testid="checkout-guest-signin">
                {{ strings().checkout.guest.signInCta }}
              </a>
            </p>
          }
          <app-address-picker
            [addresses]="addresses()"
            [guest]="isGuest()"
            (addressSelected)="onAddressSelected($event)"
            (addressSaved)="onAddressSaved($event)"
          />
          @if (step1Complete()) {
            <div class="step-actions">
              <app-button variant="primary" (clicked)="advanceFromStep(1)">
                {{ strings().checkout.steps.address.continue }}
              </app-button>
            </div>
          }
        </app-checkout-step-shell>

        <app-checkout-step-shell
          [step]="2"
          [title]="strings().checkout.steps.shipping.title"
          [state]="step2State()"
          [summaryText]="step2Summary()"
          (editClicked)="goToStep(2)"
        >
          <app-shipping-method-step
            [rates]="shippingRates()"
            [selectedMethodId]="selectedShippingMethodId()"
            [loading]="shippingQuoteLoading()"
            [failed]="shippingQuoteFailed()"
            (methodSelected)="onShippingMethodSelected($event)"
            (retryRequested)="retryShippingQuote()"
          />
          @if (selectedShippingMethodId()) {
            <div class="step-actions">
              <app-button variant="primary" (clicked)="advanceFromStep(2)">
                {{ strings().checkout.steps.shipping.continue }}
              </app-button>
            </div>
          }
        </app-checkout-step-shell>

        <app-checkout-step-shell
          [step]="3"
          [title]="strings().checkout.steps.summary.title"
          [state]="step3State()"
          [summaryText]="step3Summary()"
          (editClicked)="goToStep(3)"
        >
          <app-order-summary [cart]="cart()!" [selectedShippingRate]="selectedShippingRate()" />
          <div class="step-actions">
            <app-button variant="primary" (clicked)="advanceFromStep(3)">
              {{ strings().checkout.steps.summary.continue }}
            </app-button>
          </div>
        </app-checkout-step-shell>

        <app-checkout-step-shell
          [step]="4"
          [title]="strings().checkout.steps.payment.title"
          [state]="step4State()"
          [summaryText]="step4Summary()"
          (editClicked)="goToStep(4)"
        >
          <app-payment-method-step
            [methods]="paymentMethods()"
            [checkoutMessage]="checkoutMessage()"
            [selectedCode]="selectedPaymentCode()"
            [loading]="settingsLoading()"
            [failed]="settingsFailed()"
            (methodSelected)="onPaymentMethodSelected($event)"
            (retryRequested)="retrySettings()"
          />
          @if (selectedPaymentCode()) {
            <div class="step-actions">
              <app-button variant="primary" (clicked)="advanceFromStep(4)">
                {{ strings().checkout.steps.payment.continue }}
              </app-button>
            </div>
          }
        </app-checkout-step-shell>

        <app-checkout-step-shell
          [step]="5"
          [title]="strings().checkout.steps.place.title"
          [state]="step5State()"
        >
          <app-place-order-cta
            [submitting]="submitting()"
            [termsHref]="termsHref()"
            [disabled]="!canPlaceOrder()"
            [errorMessage]="errorMessage()"
            [paymentProvider]="selectedPaymentProvider()"
            (placeOrder)="placeOrder()"
          />
        </app-checkout-step-shell>

        @if (embeddedPayment(); as embedded) {
          <section data-testid="checkout-embedded-payment">
            <h2>{{ strings().orderConfirmation.paymentEmbeddedTitle }}</h2>
            <app-embedded-payment-host
              [action]="embedded.action"
              [returnUrl]="returnUrl(embedded.orderNumber)"
            />
          </section>
        }
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
        gap: 1rem;
        min-block-size: 100dvh;
      }
      .head {
        margin-block-end: 0.5rem;
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
      .state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        padding-block: 4rem;
        color: var(--brand-text);
      }
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        padding-block: 4rem;
      }
      .empty h1 {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .empty p {
        margin: 0;
        color: var(--brand-text-muted);
      }
      .empty-cta {
        margin-block-start: 0.5rem;
        padding-inline: 1.5rem;
        padding-block: 0.75rem;
        background-color: var(--brand-primary);
        color: var(--brand-on-primary);
        text-decoration: none;
        font-weight: 600;
      }
      .empty-cta:focus-visible {
        outline: 2px solid var(--brand-text);
        outline-offset: 2px;
      }
      .guest-signin {
        margin: 0 0 1rem;
        font-size: var(--brand-text-micro);
      }
      .guest-signin a {
        color: var(--brand-primary);
        text-decoration: underline;
      }
      .blocked {
        margin: 0;
        padding-inline: 1rem;
        padding-block: 0.75rem;
        border: 1px solid var(--brand-error);
        color: var(--brand-error);
        font-size: var(--brand-text-body);
      }
      .step-actions {
        margin-block-start: 1rem;
        display: flex;
        align-items: center;
        gap: 1rem;
      }
    `,
  ],
})
export default class CheckoutPage implements OnInit, OnDestroy {
  protected readonly state = signal<PageState>('loading');
  protected readonly cart = signal<Cart | null>(null);
  protected readonly addresses = signal<Address[]>([]);
  protected readonly selectedAddress = signal<Address | null>(null);
  protected readonly idempotencyKey = signal<string | null>(null);
  protected readonly currentStep = signal<CheckoutStep>(1);
  protected readonly step3Confirmed = signal(false);
  /**
   * The zone's live quotes for the chosen address (findings K2, D3).
   *
   * `GET /v1/cart/estimate` has always returned these; the page called it only
   * to prime the VAT row and dropped `rates` on the floor, so a store with two
   * active methods offered neither and every order took the zone default.
   */
  protected readonly shippingRates = signal<ShippingMethodQuote[]>([]);
  protected readonly selectedShippingMethodId = signal<string | null>(null);
  protected readonly shippingQuoteLoading = signal(false);
  protected readonly shippingQuoteFailed = signal(false);
  /**
   * The public checkout bootstrap: the operator's settings group plus the
   * enabled tenders (findings K2 payment half, D1, D2, D3). Both halves were
   * admin-only, so the settings round-tripped into a void and checkout printed
   * a hardcoded cash-on-delivery note whatever was configured.
   */
  protected readonly settings = signal<StorefrontCheckoutSettings | null>(null);
  protected readonly settingsLoading = signal(false);
  protected readonly settingsFailed = signal(false);
  protected readonly selectedPaymentCode = signal<string | null>(null);
  /**
   * Checkout with no account (finding K3, pass-2 D1). Set once per bootstrap
   * from the boot outcome, so nothing downstream re-reads `isAuthed()` mid-flow
   * and changes shape under the customer.
   */
  protected readonly isGuest = signal(false);
  protected readonly guestContact = signal<GuestContact | null>(null);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  private readonly platformId = inject(PLATFORM_ID);
  private readonly cartSvc = inject(CartService);
  private readonly checkoutSvc = inject(CheckoutService);
  private readonly users = inject(UsersService);
  private readonly orders = inject(OrdersService);
  private readonly authState = inject(AuthStateService);
  private readonly analytics = inject(AnalyticsTrackerService);
  private readonly router = inject(Router);
  private readonly meta = inject(Meta);
  private readonly title = inject(Title);
  private readonly locale = inject(LocaleService);
  private readonly document = inject(DOCUMENT);
  private readonly storeConfig = inject(StoreConfigService);
  protected readonly strings = this.locale.strings;

  protected returnUrl(orderNumber: string): string {
    const path = APP_ROUTES.orderConfirmation(this.locale.locale(), orderNumber);
    return `${this.document.location.origin}${path}`;
  }

  protected readonly cartHref = computed(() => APP_ROUTES.cart(this.locale.locale()));
  protected readonly loginHref = computed(() => APP_ROUTES.auth.login(this.locale.locale()));

  /**
   * The operator's own words above the tender list, exactly where the setting's
   * DTO comment says they belong. A plain string, not Translatable: upgrading
   * the storage shape is admin-side work, so it renders verbatim under both
   * locales (decision K-F6).
   */
  protected readonly checkoutMessage = computed(
    () => this.settings()?.checkout?.checkoutMessage ?? null,
  );

  /**
   * The operator's terms URL, which may point off-site, handed to the consent
   * line as an override. Null falls back to the storefront's own terms policy
   * route inside the CTA: never the home page, which is what an unset value
   * used to produce (finding D7).
   */
  protected readonly termsHref = computed(
    () => this.settings()?.checkout?.termsOfServiceUrl || null,
  );

  /** The operator's `requiredFields`, which shapes the guest contact form. */
  protected readonly requiredFields = computed(
    () => this.settings()?.checkout?.requiredFields ?? [],
  );

  /**
   * Step 1 needs an address, and for a guest a valid contact as well: the
   * confirmation mail and the track-by-email challenge both key off it.
   */
  protected readonly step1Complete = computed(
    () => Boolean(this.selectedAddress()) && (!this.isGuest() || Boolean(this.guestContact())),
  );

  protected readonly step1State = computed<CheckoutStepState>(() => {
    if (this.currentStep() === 1) return 'active';
    return this.step1Complete() ? 'complete' : 'pristine';
  });

  protected readonly step2State = computed<CheckoutStepState>(() => {
    if (this.currentStep() === 2) return this.shippingQuoteFailed() ? 'invalid' : 'active';
    return this.selectedShippingMethodId() ? 'complete' : 'pristine';
  });

  protected readonly step3State = computed<CheckoutStepState>(() => {
    if (this.currentStep() === 3) return 'active';
    if (this.step3Confirmed()) return 'complete';
    return 'pristine';
  });

  protected readonly step4State = computed<CheckoutStepState>(() => {
    if (this.currentStep() === 4) return this.settingsFailed() ? 'invalid' : 'active';
    return this.selectedPaymentCode() ? 'complete' : 'pristine';
  });

  protected readonly step5State = computed<CheckoutStepState>(() => {
    if (this.currentStep() === 5) return this.errorMessage() ? 'invalid' : 'active';
    return 'pristine';
  });

  protected readonly paymentMethods = computed<StorefrontPaymentMethod[]>(
    () => this.settings()?.paymentMethods ?? [],
  );

  protected readonly selectedPaymentMethod = computed<StorefrontPaymentMethod | null>(() => {
    const code = this.selectedPaymentCode();
    if (!code) return null;
    return this.paymentMethods().find((m) => m.code === code) ?? null;
  });

  /** Drives the cash-on-delivery legal note, which used to render always. */
  protected readonly selectedPaymentProvider = computed(
    () => this.selectedPaymentMethod()?.provider ?? null,
  );

  /**
   * A store with no enabled tender cannot take an order (finding D2). The API
   * refuses it too; blocking here is what lets the page say why instead of
   * surfacing a create error after the customer has clicked.
   */
  protected readonly canPlaceOrder = computed(() => Boolean(this.selectedPaymentCode()));

  /**
   * Zero enabled tenders, stated at the top of the page rather than three
   * steps in: a customer should learn the store cannot take their money
   * before they fill in an address, not after.
   */
  protected readonly paymentUnavailable = computed(
    () => !this.settingsLoading() && !this.settingsFailed() && this.paymentMethods().length === 0,
  );

  protected readonly step4Summary = computed(() => this.selectedPaymentMethod()?.name ?? null);

  /** The picked quote, for the summary's shipping row and total. */
  protected readonly selectedShippingRate = computed<ShippingMethodQuote | null>(() => {
    const id = this.selectedShippingMethodId();
    if (!id) return null;
    return this.shippingRates().find((r) => r.methodId === id) ?? null;
  });

  protected readonly step1Summary = computed(() => {
    const a = this.selectedAddress();
    if (!a) return null;
    const bits = [a.fullName, a.addressLine1, a.city, a.country].filter(Boolean);
    return bits.join(', ');
  });

  /**
   * The collapsed step-2 summary line. Built by `buildStepSummary` so the rule
   * can be tested against a cart literal rather than through a whole checkout.
   */
  protected readonly step3Summary = computed(() =>
    buildStepSummary(
      this.cart(),
      this.strings(),
      this.storeConfig.money(),
      this.storeConfig.money().taxDisplay,
    ),
  );

  /** The collapsed shipping line: method name, then its price. */
  protected readonly step2Summary = computed(() => {
    const rate = this.selectedShippingRate();
    if (!rate) return null;
    const s = this.strings().checkout.steps.shipping;
    const price = Number(rate.price ?? 0);
    return s.summary
      .replace('{method}', resolveDiscountLabel(rate.name, this.locale.locale(), s.title))
      .replace('{price}', price > 0 ? formatMoney(price, this.storeConfig.money()) : s.free);
  });

  ngOnInit(): void {
    this.title.setTitle(pageTitle(this.strings().checkout.meta.title, this.strings().brand.name));
    this.meta.updateTag({ name: 'description', content: this.strings().checkout.meta.description });
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });
    if (!isPlatformBrowser(this.platformId)) {
      // SSR shell renders the loading state — hydration triggers the data fetch.
      return;
    }
    this.bootstrap();
  }

  ngOnDestroy(): void {
    // Strip the noindex,nofollow robots tag so navigating away does not leak
    // the per-customer meta-state onto the next page (S5 phase-log precedent).
    this.meta.removeTag("name='robots'");
  }

  protected reload(): void {
    this.bootstrap();
  }

  protected onAddressSaved(addr: Address): void {
    this.addresses.update((list) => (list.some((a) => a.id === addr.id) ? list : [...list, addr]));
  }

  protected async onAddressSelected(addr: Address): Promise<void> {
    this.selectedAddress.set(addr);
    // A rate quoted for the previous destination is not a rate for this one,
    // and `createOrder` rejects an unmatched id outright. Drop the selection
    // before the re-quote rather than after it.
    this.selectedShippingMethodId.set(null);
    this.shippingRates.set([]);
    await this.refreshEstimate(addr);
  }

  protected onGuestContactChanged(contact: GuestContact | null): void {
    this.guestContact.set(contact);
  }

  protected onShippingMethodSelected(methodId: string): void {
    this.selectedShippingMethodId.set(methodId);
  }

  protected retryShippingQuote(): void {
    const addr = this.selectedAddress();
    if (addr) void this.refreshEstimate(addr);
  }

  protected onPaymentMethodSelected(code: string): void {
    this.selectedPaymentCode.set(code);
  }

  protected retrySettings(): void {
    void this.loadSettings();
  }

  /**
   * Read the public checkout surface once per bootstrap.
   *
   * Failure does not strand checkout: the step renders its own retry, and the
   * API validates the tender again on create, so the worst case is a customer
   * who has to press retry rather than one who cannot reach the page.
   */
  private async loadSettings(): Promise<void> {
    this.settingsLoading.set(true);
    this.settingsFailed.set(false);
    try {
      const settings = await this.checkoutSvc.getSettings();
      this.settings.set(settings);
      const methods = settings.paymentMethods ?? [];
      // One tender has no ambiguity to resolve, so preselect it and let the
      // step pass unattended. Several require a deliberate choice, which is
      // exactly what the hardcoded COD copy used to take away.
      this.selectedPaymentCode.set(methods.length === 1 ? (methods[0]?.code ?? null) : null);
    } catch {
      this.settings.set(null);
      this.selectedPaymentCode.set(null);
      this.settingsFailed.set(true);
    } finally {
      this.settingsLoading.set(false);
    }
  }

  /**
   * Resolve shipping and VAT for the chosen delivery address.
   *
   * `Cart.taxEstimate` has exactly one writer in the API, the
   * `GET /v1/cart/estimate` handler, and nothing in the storefront called it:
   * the only caller of `CartService.estimate` was its own spec. So the tax
   * estimate was null on every request, the checkout summary's VAT row never
   * had a value to show, and the total it displayed excluded tax entirely.
   * With a 19 per cent rate seeded that is the difference between the number
   * the customer reads and the number they are charged.
   *
   * Failure is swallowed on purpose. An estimate is an enhancement to the
   * summary, not a precondition for checkout, and the order-create path
   * recomputes both figures server-side regardless. Blocking the flow on it
   * would trade a missing row for an unplaceable order.
   */
  private async refreshEstimate(addr: Address): Promise<void> {
    const country = addr.country;
    if (!country) return;
    this.shippingQuoteLoading.set(true);
    this.shippingQuoteFailed.set(false);
    try {
      const estimate = await this.cartSvc.estimate({
        country,
        ...(addr.postalCode ? { postalCode: addr.postalCode } : {}),
      });
      const rates = estimate.rates ?? [];
      this.shippingRates.set(rates);
      // Preselect the zone default, which is also the rate the API caches on
      // the cart and the one `createOrder` resolves when no id is sent, so the
      // preselected state and the no-choice state agree on the price.
      const preselected = rates.find((r) => r.isDefault) ?? rates[0] ?? null;
      this.selectedShippingMethodId.set(preselected?.methodId ?? null);
      this.cart.set(await this.cartSvc.get());
    } catch {
      // No silent fallback to the default: that is the defect this step
      // exists to remove. The step renders a retry instead.
      this.shippingRates.set([]);
      this.selectedShippingMethodId.set(null);
      this.shippingQuoteFailed.set(true);
    } finally {
      this.shippingQuoteLoading.set(false);
    }
  }

  protected goToStep(step: CheckoutStep): void {
    this.currentStep.set(step);
    if (step <= 3) this.step3Confirmed.set(false);
    this.focusStepHeading(step);
  }

  protected advanceFromStep(step: CheckoutStep): void {
    if (step === 1 && this.step1Complete()) {
      this.currentStep.set(2);
      this.focusStepHeading(2);
    } else if (step === 2 && this.selectedShippingMethodId()) {
      this.currentStep.set(3);
      this.focusStepHeading(3);
    } else if (step === 3 && this.cart()?.items?.length) {
      this.step3Confirmed.set(true);
      this.currentStep.set(4);
      this.focusStepHeading(4);
    } else if (step === 4 && this.selectedPaymentCode()) {
      this.currentStep.set(5);
      this.focusStepHeading(5);
    }
  }

  private focusStepHeading(step: CheckoutStep): void {
    if (!isPlatformBrowser(this.platformId)) return;
    // Defer one tick so the new step's body has rendered before we move focus.
    queueMicrotask(() => {
      const heading = document.getElementById(`checkout-step-${step}-title`);
      if (!heading) return;
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    });
  }

  private async bootstrap(): Promise<void> {
    // Same race the account guard had (finding N4): reading `isAuthed()` while
    // the shell's single `getSession()` is in flight bounced a valid customer
    // off checkout. Await the boot outcome first; it is instant once settled.
    this.state.set('loading');
    // The settings read comes before the auth decision, not after it: whether
    // an anonymous visitor may proceed IS one of those settings, and reading it
    // is the whole of finding K3's fix. It is a public endpoint, so it works
    // for exactly the visitor whose fate it decides, and it does not depend on
    // the boot outcome, so the two resolve together rather than in sequence.
    await Promise.all([this.authState.whenBooted(), this.loadSettings()]);
    const authed = this.authState.isAuthed();
    // A failed settings read leaves the flag unknown, and unknown is not
    // "allowed": without it the page cannot tell a store that permits guests
    // from one that does not, and the pre-guest behaviour is the safe way to
    // be wrong.
    const guestAllowed = this.settings()?.checkout?.guestCheckoutEnabled === true;
    if (!authed && !guestAllowed) {
      const target = APP_ROUTES.checkout(this.locale.locale());
      this.state.set('unauthed');
      void this.router.navigateByUrl(
        `${APP_ROUTES.auth.login(this.locale.locale())}?from=${encodeURIComponent(target)}`,
      );
      return;
    }
    this.isGuest.set(!authed);
    this.state.set('loading');
    this.errorMessage.set(null);
    try {
      // `GET /v1/users/me` is `@OwnerGuard()`, so a guest must not call it: the
      // 401 would land on the session-expired branch and bounce the visitor
      // guest checkout just admitted.
      const [cart, user] = await Promise.all([
        this.cartSvc.get(),
        authed ? this.users.getMe() : Promise.resolve(null),
      ]);
      this.cart.set(cart);
      this.addresses.set((user?.addresses as Address[] | undefined) ?? []);
      if ((cart.items?.length ?? 0) === 0) {
        this.state.set('empty');
        return;
      }
      // Generate the idempotency-key once per cart-snapshot. Re-mounts of the
      // page (e.g. browser back from a 409) start a fresh key only if the cart
      // identity has changed; we approximate that by re-using the existing key
      // if one is already present.
      if (!this.idempotencyKey()) {
        this.idempotencyKey.set(crypto.randomUUID());
      }
      this.state.set('ready');
      // Deduped on the idempotency key, which is already one per cart
      // snapshot, so a re-mount cannot inflate the funnel's second rung.
      void this.analytics.trackBeginCheckout({
        key: this.idempotencyKey()!,
        total: Number(cart.total ?? 0),
      });
    } catch (cause) {
      if (cause instanceof StorefrontUnauthorizedError) {
        this.state.set('unauthed');
        void this.router.navigateByUrl(
          `${APP_ROUTES.auth.login(this.locale.locale())}?from=${encodeURIComponent(APP_ROUTES.checkout(this.locale.locale()))}`,
        );
        return;
      }
      this.state.set('error');
    }
  }

  /** Set when the provider needs a component on this page (`embedded`). */
  protected readonly embeddedPayment = signal<{
    orderId: string;
    orderNumber: string;
    action: Extract<PaymentAction, { type: 'embedded' }>;
  } | null>(null);

  protected async placeOrder(): Promise<void> {
    const addr = this.selectedAddress();
    const key = this.idempotencyKey();
    const c = this.cart();
    if (!addr || !key || !c) return;
    // A guest order with no contact is unreachable by its own buyer: no
    // confirmation mail, and nothing for the track page to challenge against.
    const guest = this.isGuest() ? this.guestContact() : null;
    if (this.isGuest() && !guest) return;
    // A store with no enabled tender cannot take an order (finding D2).
    if (!this.canPlaceOrder()) return;
    if (this.submitting()) return;
    this.submitting.set(true);
    this.errorMessage.set(null);
    const payload: CreateOrderRequest = {
      // A guest address exists nowhere but in this payload, so it travels
      // inline. The picker signals that with an empty id.
      ...(guest
        ? { guestEmail: guest.email, shippingAddress: toOrderAddress(addr) }
        : { shippingAddressId: addr.id }),
      ...(guest?.note ? { notes: guest.note } : {}),
      ...(this.selectedShippingMethodId()
        ? { shippingMethodId: this.selectedShippingMethodId()! }
        : {}),
      ...(this.selectedPaymentCode() ? { paymentMethodCode: this.selectedPaymentCode()! } : {}),
      ...(c.couponCode ? { couponCode: c.couponCode } : {}),
      ...(c.giftCard?.code ? { giftCardCode: c.giftCard.code } : {}),
    } as CreateOrderRequest;
    try {
      const order = await this.orders.create(payload, key);
      // On the create-success path, not on the confirmation page: a
      // confirmation-page hook re-fires on every reload, and a doubled
      // purchase doubles the revenue the operator reads. Not awaited, so a
      // slow beacon cannot delay the redirect below.
      void this.analytics.trackPurchase({
        orderId: order.id,
        orderNumber: order.orderNumber,
        total: Number(order.total ?? 0),
      });
      // Best-effort cart refresh — the API clears the cart server-side on order
      // create per docs/storefront-api-reference.md:603. Ignore failures so the
      // post-success redirect is not blocked by a transient cart fetch error.
      this.cartSvc.get().catch(() => undefined);
      const outcome = runPaymentAction(order.paymentAction, browserPaymentActionEnv);
      if (outcome.kind === 'left') return;
      if (outcome.kind === 'embedded') {
        this.embeddedPayment.set({
          orderId: order.id,
          orderNumber: order.orderNumber,
          action: outcome.action,
        });
        return;
      }
      void this.router.navigateByUrl(
        APP_ROUTES.orderConfirmation(this.locale.locale(), order.orderNumber),
        { state: { orderId: order.id } },
      );
    } catch (cause) {
      this.errorMessage.set(this.placeOrderErrorMessageFor(cause));
      if (cause instanceof StorefrontUnauthorizedError) {
        void this.router.navigateByUrl(
          `${APP_ROUTES.auth.login(this.locale.locale())}?from=${encodeURIComponent(APP_ROUTES.checkout(this.locale.locale()))}`,
        );
      }
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * Map a backend `POST /v1/orders` failure to a localized message. Declared
   * error codes from `apps/api/src/modules/orders/order-*.exception.ts` get
   * dedicated strings in both FR + EN; unknown 409s fall back to the
   * payment-refused copy, validation 400s to the generic copy, and network
   * outages to the network-unavailable copy. Replaces the previous
   * English-substring catch (`message.includes('out of stock')`) — see
   * `specs/features/full-stack-audit-2026-05-14/plan.md` §1.1 rows #6-8.
   */
  private placeOrderErrorMessageFor(err: unknown): string {
    const errors = this.strings().checkout.errors;
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? String((err as { code: string }).code)
        : null;
    if (code === 'ORDER_INSUFFICIENT_STOCK') return errors.outOfStock;
    if (code === 'ORDER_CART_EMPTY') return errors.cartEmpty;
    if (code === 'ORDER_IDEMPOTENCY_IN_PROGRESS') return errors.idempotencyInFlight;
    if (code === 'SHIPPING_METHOD_INVALID') return errors.shippingMethodInvalid;
    if (code === 'SHIPPING_UNAVAILABLE') return errors.shippingUnavailable;
    if (code === 'ORDER_PAYMENT_METHOD_INVALID') return errors.paymentMethodInvalid;
    if (code === 'ORDER_PAYMENT_METHOD_UNAVAILABLE') return errors.paymentMethodUnavailable;
    if (code === 'ORDER_PAYMENT_NOT_RETRYABLE') return errors.paymentNotRetryable;
    if (
      code === 'PAYMENT_PROVIDER_UNAVAILABLE' ||
      code === 'PAYMENT_PROVIDER_REJECTED' ||
      code === 'PAYMENT_CONFIG_ENCRYPTION_UNAVAILABLE' ||
      code === 'PAYMENT_PROVIDER_UNKNOWN' ||
      code === 'ORDER_PAYMENT_NOT_OPENED'
    ) {
      return errors.paymentProviderUnavailable;
    }
    if (code === 'ORDER_GUEST_CHECKOUT_DISABLED') return errors.guestCheckoutDisabled;
    if (err instanceof StorefrontUnauthorizedError) {
      // The submit handler navigates to login; surface a transient message
      // so screen readers still hear something while the route swaps.
      return errors.generic;
    }
    if (err instanceof StorefrontConflictError) return errors.paymentRefused;
    if (err instanceof StorefrontError) return errors.generic;
    return errors.networkUnavailable;
  }
}

/**
 * The inline shipping address `CreateOrderDto` accepts, from the address the
 * guest just typed. Only the fields the DTO declares travel: it runs under
 * `whitelist: true`, and an `id` of `''` would be stripped anyway, but sending
 * a shape the server does not model is how drift starts.
 */
function toOrderAddress(addr: Address): NonNullable<CreateOrderRequest['shippingAddress']> {
  return {
    fullName: addr.fullName,
    phone: addr.phone,
    addressLine1: addr.addressLine1,
    ...(addr.addressLine2 ? { addressLine2: addr.addressLine2 } : {}),
    city: addr.city,
    ...(addr.state ? { state: addr.state } : {}),
    ...(addr.postalCode ? { postalCode: addr.postalCode } : {}),
    country: addr.country,
  };
}

import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { OrdersService } from '@storefront-services';
import {
  trackOrderRequestSchema,
  type OrderStatus,
  type TrackingResponse,
  type TrackingShipment,
} from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { APP_ROUTES } from '../../../lib/routes';
import { ButtonComponent } from '../../ui/button.component';
import { SpinnerComponent } from '../../ui/spinner.component';
import { OrderStatusBadgeComponent } from '../../sections/account/order-status-badge.component';
import { carrierTrackingUrl } from '../../sections/account/carrier-links';
import {
  OrderStatusTimelineComponent,
  type OrderTimelineEvent,
} from '../../sections/account/order-status-timeline.component';
import { pageTitle } from '../../../lib/seo';
import { browserPaymentActionEnv, runPaymentAction } from '../../sections/checkout/payment-action';

type PageState = 'idle' | 'submitting' | 'ready' | 'not-found';

const ORDER_STATUSES: ReadonlyArray<OrderStatus> = [
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'ON_HOLD',
  'RETURN_REQUESTED',
  'RETURNED',
];

/**
 * The public order-track page, at `/{locale}/track` (findings K9, K10, K11).
 *
 * Three things were wrong with what this replaces. It lived under
 * `/account/orders/:id/track` and read the route segment as the order number,
 * so it showed a signed-in customer their internal cuid and called it their
 * order number. It asked that same signed-in customer for their email. And it
 * sent that email in a query string, which writes it to the access log, to the
 * `Referer` of the next request, and to the browser history.
 *
 * Now: no route parameter carries identity, both halves of the challenge are
 * typed into the form, and they go out in a `POST /v1/orders/track` body. An
 * `?order=` query parameter prefills the number when the customer arrives from
 * their confirmation page; it is a convenience, not the credential.
 *
 * Both "no such order" and "wrong email" collapse to one 404 in the API per
 * constitution §3.7, so the page surfaces one generic not-found either way.
 */
@Component({
  selector: 'app-track-page',
  standalone: true,
  imports: [
    ButtonComponent,
    OrderStatusBadgeComponent,
    OrderStatusTimelineComponent,
    ReactiveFormsModule,
    RouterLink,
    SpinnerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" data-testid="track-page">
      <header class="header">
        <h1 class="title">{{ strings().track.heading }}</h1>
        <p class="body">{{ strings().track.body }}</p>
      </header>

      <form
        class="form"
        [formGroup]="form"
        (ngSubmit)="onSubmit()"
        novalidate
        data-testid="track-form"
      >
        <label class="field">
          <span class="label">{{ strings().track.orderNumberLabel }}</span>
          <input
            id="track-order-number"
            formControlName="orderNumber"
            type="text"
            autocomplete="off"
            spellcheck="false"
            required
            [placeholder]="strings().track.orderNumberPlaceholder"
            [attr.aria-describedby]="showOrderNumberError() ? 'track-order-number-error' : null"
            [attr.aria-invalid]="showOrderNumberError() ? 'true' : null"
            data-testid="track-order-number-input"
          />
          <span id="track-order-number-error" class="error" aria-live="polite">
            @if (showOrderNumberError()) {
              {{ orderNumberErrorMessage() }}
            }
          </span>
        </label>

        <label class="field">
          <span class="label">{{ strings().track.emailLabel }}</span>
          <input
            id="track-email"
            formControlName="email"
            type="email"
            inputmode="email"
            autocomplete="email"
            required
            [placeholder]="strings().track.emailPlaceholder"
            [attr.aria-describedby]="showEmailError() ? 'track-email-error' : null"
            [attr.aria-invalid]="showEmailError() ? 'true' : null"
            data-testid="track-email-input"
          />
          <span id="track-email-error" class="error" aria-live="polite">
            @if (showEmailError()) {
              {{ emailErrorMessage() }}
            }
          </span>
        </label>

        <app-button
          type="submit"
          variant="primary"
          [loading]="state() === 'submitting'"
          testId="track-submit"
        >
          {{ state() === 'submitting' ? strings().track.submitting : strings().track.submit }}
        </app-button>
      </form>

      @if (state() === 'submitting') {
        <div class="loading" role="status" aria-live="polite">
          <app-spinner size="md" />
          <span>{{ strings().account.shared.loading }}</span>
        </div>
      }

      @if (state() === 'not-found') {
        <section class="not-found" data-testid="track-not-found" role="alert">
          <h2 class="not-found-heading">{{ strings().track.notFoundTitle }}</h2>
          <p>{{ strings().track.notFoundBody }}</p>
        </section>
      }

      @if (state() === 'ready' && tracking(); as t) {
        <section class="result" data-testid="track-result">
          <h2 class="result-heading">{{ resultHeading() }}</h2>
          <p class="result-status">
            <span>{{ strings().account.orderDetail.status }}:</span>
            <app-order-status-badge [status]="resolvedStatus(t.status)" />
          </p>

          @if (t.status.toUpperCase() === 'CANCELLED') {
            <p class="payment-note" data-testid="track-cancelled-note">
              {{ strings().track.cancelledNote }}
            </p>
          } @else if (t.paymentRetryable) {
            <p class="payment-note">{{ strings().track.paymentPendingNote }}</p>
            <p class="pay-again" data-testid="track-pay-again">
              <app-button variant="primary" [loading]="payAgainBusy()" (clicked)="payAgain()">
                {{ strings().track.payAgain }}
              </app-button>
            </p>
          }
          @if (paymentError(); as message) {
            <p class="payment-error" role="alert" data-testid="track-payment-error">
              {{ message }}
            </p>
          }

          @if (shipments().length > 0) {
            <h3 class="shipments-heading">{{ strings().track.shipmentsHeading }}</h3>
            <ul class="shipments" role="list">
              @for (shipment of shipments(); track shipment.id) {
                <li class="shipment" data-testid="track-shipment">
                  @if (shipment.carrier) {
                    <p>
                      <span>{{ strings().track.carrierLabel }}:</span>
                      <strong>{{ shipment.carrier }}</strong>
                    </p>
                  }
                  @if (shipment.trackingNumber) {
                    <p>
                      <span>{{ strings().track.trackingNumberLabel }}:</span>
                      <strong>{{ shipment.trackingNumber }}</strong>
                    </p>
                  }
                  @if (carrierLink(shipment); as link) {
                    <p>
                      <a
                        class="carrier-link"
                        [href]="link"
                        target="_blank"
                        rel="noopener noreferrer"
                        [attr.aria-label]="carrierLinkLabel(shipment)"
                        data-testid="track-carrier-link"
                      >
                        {{ strings().track.carrierLink }}
                      </a>
                    </p>
                  }
                  @if (shipment.status) {
                    <p class="shipment-status">
                      <app-order-status-badge [status]="resolvedStatus(shipment.status)" />
                    </p>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="no-shipments" data-testid="track-no-shipments">
              {{ strings().track.noShipments }}
            </p>
          }

          @if (timelineEvents().length > 0) {
            <app-order-status-timeline [events]="timelineEvents()" />
          }
        </section>
      }

      <p class="back-row">
        <a class="back-link" [routerLink]="homeHref()">
          {{ strings().notFound.cta }}
        </a>
      </p>
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
        gap: 1.25rem;
        padding-block: 2rem;
        padding-inline: 1rem;
        max-inline-size: 720px;
        margin-inline: auto;
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
      .body {
        margin: 0;
        color: var(--brand-text-muted);
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 0.875rem;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .label {
        color: var(--brand-text);
        font-size: var(--brand-text-body);
      }
      input {
        background-color: var(--brand-surface);
        color: var(--brand-text);
        /* agent_docs/storefront/brand-tokens.md: a control resting boundary is load-bearing. */
        border: 1px solid var(--brand-border-interactive);
        padding-block: 0.625rem;
        padding-inline: 0.875rem;
        font-size: var(--brand-text-body);
        border-radius: var(--brand-radius-sm);
      }
      input:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .error {
        color: var(--brand-error);
        font-size: var(--brand-text-micro);
        min-block-size: 1rem;
      }
      .loading {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        color: var(--brand-text-muted);
      }
      .not-found,
      .result {
        background-color: var(--brand-surface);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
        padding-block: 1rem;
        padding-inline: 1rem;
      }
      .shipments-heading {
        margin-block: 1rem 0.5rem;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
      }
      .shipments {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .shipment {
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-sm);
        padding-block: 0.75rem;
        padding-inline: 0.75rem;
      }
      .shipment p {
        margin: 0;
      }
      .shipment-status {
        margin-block-start: 0.5rem;
      }
      .carrier-link {
        color: var(--brand-primary);
      }
      .carrier-link:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .no-shipments {
        margin-block: 1rem 0;
        color: var(--brand-text-muted);
      }
      .not-found-heading,
      .result-heading {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
      }
      .payment-note {
        margin: 0;
        color: var(--brand-text-muted);
      }
      .payment-error {
        margin: 0;
        color: var(--brand-error);
      }
      .back-row {
        margin: 0;
      }
      .back-link {
        color: var(--brand-primary);
        text-decoration: none;
      }
      .back-link:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
    `,
  ],
})
export class TrackPageComponent implements OnInit {
  private readonly locale = inject(LocaleService);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly fb = inject(FormBuilder);
  private readonly ordersSvc = inject(OrdersService);

  protected readonly strings = this.locale.strings;
  protected readonly state = signal<PageState>('idle');
  protected readonly tracking = signal<TrackingResponse | null>(null);
  protected readonly payAgainBusy = signal(false);
  protected readonly paymentError = signal<string | null>(null);
  /** The lookup that produced the result; the form may be edited after submit. */
  private lastLookup: { orderNumber: string; email: string } | null = null;

  protected readonly form: FormGroup = this.fb.nonNullable.group({
    orderNumber: ['', [Validators.required, Validators.maxLength(32)]],
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly homeHref = computed(() => APP_ROUTES.home(this.locale.locale()));

  protected readonly resultHeading = computed(() =>
    this.strings().track.successHeading.replace('{number}', this.tracking()?.orderNumber ?? ''),
  );

  protected readonly shipments = computed<TrackingShipment[]>(
    () => this.tracking()?.shipments ?? [],
  );

  /**
   * The timeline the API now sends (plan M phase M2), one row per real
   * transition with its own timestamp. Before M2 this list was always empty and
   * the page fell back to deriving events from `createdAt` plus the shipment
   * stamps; that fallback stays for an order placed before the backfill ran.
   */
  protected readonly timelineEvents = computed<OrderTimelineEvent[]>(() => {
    const t = this.tracking();
    if (!t) return [];
    if (t.timeline.length > 0) {
      return t.timeline.map((entry) => ({
        status: this.resolvedStatus(entry.status),
        at: entry.at,
        note: entry.note ?? null,
      }));
    }

    const events: OrderTimelineEvent[] = [];
    if (t.createdAt) {
      events.push({ status: 'PENDING', at: t.createdAt, note: null });
    }
    for (const shipment of t.shipments) {
      if (shipment.shippedAt) {
        events.push({ status: 'SHIPPED', at: shipment.shippedAt, note: null });
      }
      if (shipment.deliveredAt) {
        events.push({ status: 'DELIVERED', at: shipment.deliveredAt, note: null });
      }
    }
    const current = this.resolvedStatus(t.status);
    // The current status is only worth a row when no derived event already
    // says the same thing, otherwise a delivered order gets DELIVERED twice.
    if (events.length === 0 || events[events.length - 1].status !== current) {
      const last = events[events.length - 1];
      events.push({ status: current, at: last?.at ?? t.createdAt ?? '', note: null });
    }
    return events;
  });

  protected resolvedStatus(value: string): OrderStatus {
    const normalized = value.toUpperCase();
    return (ORDER_STATUSES as readonly string[]).includes(normalized)
      ? (normalized as OrderStatus)
      : 'PENDING';
  }

  protected carrierLink(shipment: TrackingShipment): string | null {
    return carrierTrackingUrl(shipment.carrier, shipment.trackingNumber);
  }

  protected carrierLinkLabel(shipment: TrackingShipment): string {
    const label = this.strings().track.carrierLink;
    return shipment.trackingNumber ? `${label} (${shipment.trackingNumber})` : label;
  }

  ngOnInit(): void {
    this.title.setTitle(pageTitle(this.strings().track.metaTitle, this.strings().brand.name));
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });

    if (!isPlatformBrowser(this.platformId)) return;
    // Convenience only: arriving from the confirmation page prefills the
    // number. The email is still required, so this grants no access.
    const prefill = this.route.snapshot.queryParamMap.get('order');
    if (prefill) this.form.patchValue({ orderNumber: prefill });
  }

  /**
   * Plain methods, not `computed()`. A Reactive-Forms getter is untracked, so a
   * `computed()` over one memoizes its first answer and never updates
   * (constitution §3.10, and the zoneless-form-getter rule this repo already
   * swept for once).
   */
  protected showOrderNumberError(): boolean {
    return this.controlShowsError('orderNumber');
  }

  protected showEmailError(): boolean {
    return this.controlShowsError('email');
  }

  protected orderNumberErrorMessage(): string {
    const ctrl = this.form.get('orderNumber');
    if (!ctrl) return '';
    if (ctrl.hasError('required')) return this.strings().track.requiredField;
    if (ctrl.hasError('maxlength') || ctrl.hasError('pattern')) {
      return this.strings().track.invalidOrderNumber;
    }
    return '';
  }

  protected emailErrorMessage(): string {
    const ctrl = this.form.get('email');
    if (!ctrl) return '';
    if (ctrl.hasError('required')) return this.strings().track.requiredField;
    if (ctrl.hasError('email')) return this.strings().track.invalidEmail;
    return '';
  }

  private controlShowsError(name: string): boolean {
    const ctrl = this.form.get(name);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  protected async onSubmit(): Promise<void> {
    if (this.state() === 'submitting') return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const raw = this.form.getRawValue() as { orderNumber: string; email: string };
    // Uppercased on the way in: the API's pattern refuses lowercase, and a
    // customer copying a number off a printed page should not be turned away
    // over case.
    const parsed = trackOrderRequestSchema.safeParse({
      orderNumber: raw.orderNumber.trim().toUpperCase(),
      email: raw.email.trim(),
    });
    if (!parsed.success) {
      this.form.get('orderNumber')?.setErrors({ pattern: true });
      this.form.markAllAsTouched();
      this.state.set('idle');
      return;
    }
    this.state.set('submitting');
    this.tracking.set(null);
    this.paymentError.set(null);
    this.lastLookup = parsed.data;
    await this.lookup(parsed.data);
  }

  private async lookup(body: { orderNumber: string; email: string }): Promise<void> {
    try {
      const result = await this.ordersSvc.track(body);
      this.tracking.set(result);
      this.state.set('ready');
    } catch {
      this.state.set('not-found');
    }
  }

  protected async payAgain(): Promise<void> {
    const body = this.lastLookup;
    if (!body || this.payAgainBusy()) return;
    this.payAgainBusy.set(true);
    this.paymentError.set(null);
    try {
      const action = await this.ordersSvc.retryTrackedPayment(body, crypto.randomUUID());
      const outcome = await runPaymentAction(action, browserPaymentActionEnv);
      if (outcome.kind === 'done') {
        await this.lookup(body);
      } else if (outcome.kind === 'embedded') {
        // The track page has no embedded form; the confirmation page does.
        this.paymentError.set(this.strings().checkout.errors.generic);
      }
    } catch (error) {
      this.paymentError.set(this.paymentErrorMessageFor(error));
    } finally {
      this.payAgainBusy.set(false);
    }
  }

  private paymentErrorMessageFor(error: unknown): string {
    const errors = this.strings().checkout.errors;
    const code = (error as { code?: string } | null)?.code;
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
}

export default TrackPageComponent;

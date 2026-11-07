import { currencyEntry } from '@common/constants/currencies.constants';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { z } from 'zod';
import { PaymentProviderRejectedException } from '../payment-provider-rejected.exception';
import { PaymentProviderUnavailableException } from '../payment-provider-unavailable.exception';
import { PaymentTransitionNotAllowedException } from '../payment-transition-not-allowed.exception';
import { PaymentWebhookSignatureInvalidException } from '../payment-webhook-signature-invalid.exception';
import { PaymentWebhookIgnoredException } from '../payment-webhook-ignored.exception';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import type {
  PaymentCaptureInput,
  PaymentMutationInput,
  PaymentOperationInput,
  PaymentProvider,
  PaymentProviderResult,
  PaymentRefundInput,
  PaymentSessionInput,
  PaymentSessionResult,
  PaymentWebhookEvent,
  PaymentWebhookInput,
} from './payment-provider.interface';

export const STRIPE_TIMEOUT_MS = 5000;
export const STRIPE_FAILURE_THRESHOLD = 5;
export const STRIPE_COOLDOWN_MS = 30_000;

const stripeConfigSchema = z.object({
  /** embedded: Payment Element on our page. redirect: hosted Stripe Checkout. */
  checkoutMode: z.enum(['embedded', 'redirect']).default('embedded'),
  secretKey: z.string().min(1).optional(),
  webhookSecret: z.string().min(1).optional(),
  publishableKey: z.string().min(1).optional(),
});
type StripeConfig = z.infer<typeof stripeConfigSchema>;

const intentSchema = z.object({
  id: z.string(),
  status: z.string(),
  client_secret: z.string().nullish(),
});
const checkoutSessionSchema = z.object({
  id: z.string(),
  url: z.string().nullish(),
  payment_intent: z.string().nullish(),
});
const sessionListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
const refundSchema = z.object({ status: z.string().nullish() });
const intentEventSchema = z.object({
  id: z.string(),
  metadata: z.record(z.string(), z.string()).nullish(),
});
const chargeEventSchema = z.object({
  payment_intent: z.string(),
  amount: z.number().int(),
  amount_refunded: z.number().int(),
});

const INTENT_EVENTS: Record<string, PaymentStatus> = {
  'payment_intent.amount_capturable_updated': PaymentStatus.AUTHORIZED,
  'payment_intent.succeeded': PaymentStatus.CAPTURED,
  // A failed attempt is retryable: the intent goes back to requires_payment_method.
  'payment_intent.payment_failed': PaymentStatus.PENDING,
  'payment_intent.canceled': PaymentStatus.CANCELLED,
};

/**
 * Example card provider on Stripe Payment Intents with manual capture. The
 * API key and the webhook signing secret come from env (STRIPE_API_KEY,
 * STRIPE_WEBHOOK_SECRET), so every stripe method row shares them. Without a
 * key the app still boots and every call answers 503.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider<StripeConfig> {
  static readonly providerId = 'stripe' as const;
  /** Checkout offers Stripe: the storefront runs its redirect and embedded actions. */
  static readonly offeredAtCheckout = true;
  private readonly logger = new Logger(StripePaymentProvider.name);
  readonly id = StripePaymentProvider.providerId;
  readonly label = 'Stripe';
  readonly actionTypes = ['embedded', 'redirect'] as const;
  readonly secretFields = ['secretKey', 'webhookSecret'] as const;
  readonly configSchema = stripeConfigSchema;

  private readonly client: Stripe | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly envPublishableKey: string | undefined;
  private readonly clients = new Map<string, Stripe>();
  private readonly breaker = new CircuitBreaker({
    threshold: STRIPE_FAILURE_THRESHOLD,
    cooldownMs: STRIPE_COOLDOWN_MS,
    isFailure: (error) => isOutage(error),
  });

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('STRIPE_API_KEY');
    this.client = apiKey ? this.buildClient(apiKey) : undefined;
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET') || undefined;
    this.envPublishableKey = config.get<string>('STRIPE_PUBLISHABLE_KEY') || undefined;
  }

  async createSession(input: PaymentSessionInput<StripeConfig>): Promise<PaymentSessionResult> {
    const client = this.requireClient(input.config);
    const amount = this.toMinorUnits(input.amount, input.currencyCode);
    if (input.config.checkoutMode === 'redirect') {
      return this.createHostedSession(client, input, amount);
    }
    const intent = await this.call(intentSchema, () =>
      client.paymentIntents.create(
        {
          amount,
          currency: input.currencyCode.toLowerCase(),
          capture_method: 'manual',
          metadata: { orderId: input.orderId },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: `checkout-session:${input.orderId}` },
      ),
    );
    if (!intent.client_secret) {
      throw new PaymentProviderRejectedException(this.id, 'missing_client_secret');
    }
    const publicConfig: Record<string, string> = { provider: this.id };
    const publishableKey = input.config.publishableKey ?? this.envPublishableKey;
    if (publishableKey) publicConfig['publishableKey'] = publishableKey;
    return {
      reference: intent.id,
      status: intentStatus(intent.status),
      action: { type: 'embedded', clientToken: intent.client_secret, publicConfig },
    };
  }

  /** Hosted Stripe Checkout. The reference is the session id until a PaymentIntent exists. */
  private async createHostedSession(
    client: Stripe,
    input: PaymentSessionInput<StripeConfig>,
    amount: number,
  ): Promise<PaymentSessionResult> {
    const returnUrl = input.returnUrl;
    if (!returnUrl) throw new PaymentProviderRejectedException(this.id, 'missing_return_url');
    const session = await this.call(checkoutSessionSchema, () =>
      client.checkout.sessions.create(
        {
          mode: 'payment',
          client_reference_id: input.orderId,
          success_url: returnUrl,
          cancel_url: returnUrl,
          ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currencyCode.toLowerCase(),
                unit_amount: amount,
                product_data: { name: `Order ${input.orderId}` },
              },
            },
          ],
          payment_intent_data: {
            capture_method: 'manual',
            metadata: { orderId: input.orderId, checkoutMode: 'redirect' },
          },
        },
        // A replayed key returns the first session, which may be expired or abandoned by Pay again.
        { idempotencyKey: `checkout-session:${input.orderId}:${randomUUID()}` },
      ),
    );
    if (!session.url) throw new PaymentProviderRejectedException(this.id, 'missing_checkout_url');
    return {
      reference: session.id,
      status: PaymentStatus.PENDING,
      action: { type: 'redirect', url: session.url },
    };
  }

  async authorize(input: PaymentOperationInput<StripeConfig>): Promise<PaymentProviderResult> {
    const client = this.requireClient(input.config);
    this.assertFrom(input, 'authorize', [PaymentStatus.PENDING]);
    const intent = await this.retrieveIntent(client, input.reference);
    if (!intent || intentStatus(intent.status) !== PaymentStatus.AUTHORIZED) {
      throw new PaymentTransitionNotAllowedException(this.id, input.status, 'authorize');
    }
    return { reference: input.reference, status: PaymentStatus.AUTHORIZED };
  }

  async capture(input: PaymentCaptureInput<StripeConfig>): Promise<PaymentProviderResult> {
    const client = this.requireClient(input.config);
    this.assertFrom(input, 'capture', [PaymentStatus.AUTHORIZED]);
    const amount = this.toMinorUnits(input.amount, input.currencyCode);
    const intentId = await this.requireIntentId(client, input.reference);
    const intent = await this.call(intentSchema, () =>
      client.paymentIntents.capture(
        intentId,
        { amount_to_capture: amount },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    return { reference: input.reference, status: intentStatus(intent.status) };
  }

  async cancel(input: PaymentMutationInput<StripeConfig>): Promise<PaymentProviderResult> {
    const client = this.requireClient(input.config);
    this.assertFrom(input, 'cancel', [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED]);
    const intentId = await this.resolveIntentId(client, input.reference);
    if (!intentId) {
      // A hosted session nobody paid on: expire it so the link stops working.
      await this.call(checkoutSessionSchema, () =>
        client.checkout.sessions.expire(input.reference),
      );
      return { reference: input.reference, status: PaymentStatus.CANCELLED };
    }
    const intent = await this.call(intentSchema, () =>
      client.paymentIntents.cancel(intentId, {}, { idempotencyKey: input.idempotencyKey }),
    );
    return { reference: input.reference, status: intentStatus(intent.status) };
  }

  async refund(input: PaymentRefundInput<StripeConfig>): Promise<PaymentProviderResult> {
    const client = this.requireClient(input.config);
    this.assertFrom(input, 'refund', [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED]);
    if (input.amount.lte(0) || input.amount.gt(input.refundableAmount)) {
      throw new PaymentTransitionNotAllowedException(this.id, input.status, 'refund');
    }
    const amount = this.toMinorUnits(input.amount, input.currencyCode);
    const intentId = await this.requireIntentId(client, input.reference);
    const refund = await this.call(refundSchema, () =>
      client.refunds.create(
        { payment_intent: intentId, amount },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    if (refund.status === 'failed' || refund.status === 'canceled') {
      throw new PaymentProviderRejectedException(this.id, `refund_${refund.status}`);
    }
    const status = input.amount.gte(input.refundableAmount)
      ? PaymentStatus.REFUNDED
      : PaymentStatus.PARTIALLY_REFUNDED;
    return { reference: input.reference, status };
  }

  async getStatus(input: PaymentOperationInput<StripeConfig>): Promise<PaymentProviderResult> {
    const client = this.requireClient(input.config);
    const intent = await this.retrieveIntent(client, input.reference);
    const status = intent ? intentStatus(intent.status) : PaymentStatus.PENDING;
    const refunded =
      input.status === PaymentStatus.REFUNDED || input.status === PaymentStatus.PARTIALLY_REFUNDED;
    return {
      reference: input.reference,
      status: refunded && status === PaymentStatus.CAPTURED ? input.status : status,
    };
  }

  async parseWebhook(input: PaymentWebhookInput<StripeConfig>): Promise<PaymentWebhookEvent> {
    const webhookSecret = input.config.webhookSecret || this.webhookSecret;
    if (!webhookSecret) throw new PaymentProviderUnavailableException(this.id);
    const signature = input.headers['stripe-signature'];
    if (typeof signature !== 'string') throw new PaymentWebhookSignatureInvalidException(this.id);

    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(input.rawBody, signature, webhookSecret);
    } catch {
      throw new PaymentWebhookSignatureInvalidException(this.id);
    }

    const object = event.data.object;
    const intentEventStatus = INTENT_EVENTS[event.type];
    if (intentEventStatus) {
      const intent = this.parse(intentEventSchema, object);
      const reference = await this.referenceFor(input.config, intent);
      return { eventId: event.id, reference, status: intentEventStatus };
    }
    if (event.type === 'charge.refunded') {
      const charge = this.parse(chargeEventSchema, object);
      const status =
        charge.amount_refunded >= charge.amount
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED;
      const reference = await this.referenceForIntent(input.config, charge.payment_intent);
      return { eventId: event.id, reference, status };
    }
    throw new PaymentWebhookIgnoredException(this.id, event.type);
  }

  /** Redirect payments are stored under the session id, so a webhook maps the intent back to it. */
  private async referenceFor(
    config: StripeConfig,
    intent: z.infer<typeof intentEventSchema>,
  ): Promise<string> {
    if (intent.metadata?.['checkoutMode'] !== 'redirect') return intent.id;
    return this.referenceForIntent(config, intent.id);
  }

  /**
   * A charge event carries no metadata, and the method may have flipped mode since the
   * payment, so the session lookup does not depend on the current mode.
   */
  private async referenceForIntent(config: StripeConfig, intentId: string): Promise<string> {
    const client = this.requireClient(config);
    const sessions = await this.call(sessionListSchema, () =>
      client.checkout.sessions.list({ payment_intent: intentId, limit: 1 }),
    );
    return sessions.data[0]?.id ?? intentId;
  }

  /** A cs_ reference is a hosted session; the intent exists only once the shopper paid. */
  private async resolveIntentId(client: Stripe, reference: string): Promise<string | null> {
    if (!reference.startsWith('cs_')) return reference;
    const session = await this.call(checkoutSessionSchema, () =>
      client.checkout.sessions.retrieve(reference),
    );
    return session.payment_intent ?? null;
  }

  private async requireIntentId(client: Stripe, reference: string): Promise<string> {
    const intentId = await this.resolveIntentId(client, reference);
    if (!intentId) throw new PaymentProviderRejectedException(this.id, 'payment_not_started');
    return intentId;
  }

  private async retrieveIntent(
    client: Stripe,
    reference: string,
  ): Promise<z.infer<typeof intentSchema> | null> {
    const intentId = await this.resolveIntentId(client, reference);
    if (!intentId) return null;
    return this.call(intentSchema, () => client.paymentIntents.retrieve(intentId));
  }

  /** The method config key wins; the env key is the fallback. Clients are cached per key. */
  private requireClient(config: StripeConfig): Stripe {
    const apiKey = config.secretKey;
    if (!apiKey) {
      if (!this.client) throw new PaymentProviderUnavailableException(this.id);
      return this.client;
    }
    let client = this.clients.get(apiKey);
    if (!client) {
      client = this.buildClient(apiKey);
      this.clients.set(apiKey, client);
    }
    return client;
  }

  private buildClient(apiKey: string): Stripe {
    return new Stripe(apiKey, { timeout: STRIPE_TIMEOUT_MS });
  }

  private async call<T>(schema: z.ZodType<T>, fn: () => Promise<unknown>): Promise<T> {
    let response: unknown;
    try {
      response = await this.breaker.run(fn);
    } catch (error) {
      if (error instanceof CircuitOpenError || isOutage(error)) {
        throw new PaymentProviderUnavailableException(this.id);
      }
      if (error instanceof Stripe.errors.StripeError) {
        this.logger.warn(
          `Stripe rejected the call: type=${error.type} code=${error.code ?? 'none'} status=${error.statusCode ?? 'none'}`,
        );
        throw new PaymentProviderRejectedException(this.id, error.code ?? error.type);
      }
      throw error;
    }
    return this.parse(schema, response);
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new PaymentProviderRejectedException(this.id, 'invalid_response');
    return parsed.data;
  }

  /**
   * Stripe takes integer minor units. An unknown currency is refused rather than
   * guessed, and an amount finer than the currency allows is refused, never rounded.
   */
  private toMinorUnits(amount: Prisma.Decimal, currencyCode: string): number {
    const entry = currencyEntry(currencyCode);
    if (!entry) throw new PaymentProviderRejectedException(this.id, 'unsupported_currency');
    const places = entry.decimalPlaces;
    const minor = amount.mul(new Prisma.Decimal(10).pow(places));
    if (!minor.isInteger()) throw new PaymentProviderRejectedException(this.id, 'amount_precision');
    return minor.toNumber();
  }

  private assertFrom(
    input: PaymentOperationInput<StripeConfig>,
    action: string,
    allowed: PaymentStatus[],
  ): void {
    if (!allowed.includes(input.status)) {
      throw new PaymentTransitionNotAllowedException(this.id, input.status, action);
    }
  }
}

function isOutage(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError
  );
}

function intentStatus(status: string): PaymentStatus {
  switch (status) {
    case 'requires_capture':
      return PaymentStatus.AUTHORIZED;
    case 'succeeded':
      return PaymentStatus.CAPTURED;
    case 'canceled':
      return PaymentStatus.CANCELLED;
    default:
      return PaymentStatus.PENDING;
  }
}

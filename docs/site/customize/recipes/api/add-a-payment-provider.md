---
title: Add a payment provider
description: "How a payment provider plugs into the engine: the PaymentProvider interface, the one registry list, the gateway that holds the config, the payment action the storefront runs, secrets the operator enters in the admin and the engine encrypts, the conformance suite every provider passes, signed and deduped webhooks, and retry and confirm. Stripe is the worked example."
primaryQuery: add a payment gateway nestjs ecommerce stripe
updated: 2026-11-07
schema: HowTo
---

## When you need this

You want a payment provider the engine does not ship. The engine ships three:

- `cod`, cash on delivery.
- `manual`, a bank transfer the operator confirms.
- `stripe`, a card provider. It runs as an embedded Payment Element on Payment Intents, or as a hosted Checkout Session, and the operator picks one per payment method. It is offered at checkout.

Gift cards are not a provider. A gift card is a code applied to the cart, and `GiftCardsService.redeem` in `apps/api/src/modules/gift-cards/gift-cards.service.ts` is an atomic, WHERE-guarded decrement.

Every provider sits behind one interface and one gateway. Adding one is a class, one line in the registry, one entry in the conformance suite, and the config fields it reads. The admin form is built from the provider, so it needs no edit. The storefront needs an edit only if your provider uses the `embedded` action.

## Files you touch

- `apps/api/src/modules/payments/providers/payment-provider.interface.ts`: the `PaymentProvider<TConfig>` interface, the `PaymentAction` union and the input and result types.
- `apps/api/src/modules/payments/providers/<id>-payment.provider.ts`: your provider. `stripe-payment.provider.ts` is the card example, `offline-payment.provider.ts` the base for providers where the money moves outside the engine.
- `apps/api/src/modules/payments/payment-providers.ts`: `PAYMENT_PROVIDER_IMPLEMENTATIONS`, the one list of providers the engine runs.
- `apps/api/src/modules/payments/providers/payment-provider.conformance.spec.ts`: the shared suite every provider passes.
- `apps/api/src/modules/payments/payment-gateway.service.ts`: the only door from orders to a provider. You read it, you do not change it.
- `apps/api/src/modules/payments/payment-config-crypto.ts`: encrypts and decrypts the secret fields. You read it, you do not change it.
- `apps/storefront/src/app/sections/checkout/embedded-payment-host.component.ts`: only if your provider uses the `embedded` action.
- `tools/setup/src/steps/payments.ts` and `tools/setup/src/output/compose-env.ts`: only if you want an env fallback for your keys.
- `prisma/seeds/store-config/payment-methods.ts`: the seed that plants `cod`, create-only.

The admin form at `apps/admin/src/app/features/payments/payment-method-new.page.ts` is not on the list. It reads `GET /v1/admin/payment-providers`, which lists every registered provider with its label, action types, secret fields and config schema. A new provider shows up there by itself.

## The pattern

### 1. The interface

`apps/api/src/modules/payments/providers/payment-provider.interface.ts` declares what a provider is and does:

- `id`, `label` and `configSchema`, a Zod schema for the method row's `config` blob.
- `actionTypes`: the payment actions this provider can answer with.
- `secretFields`: the `config` keys that hold secrets.
- `createSession(input)`: called once at order create. Gets `orderId`, `amount` (a `Prisma.Decimal`), `currencyCode`, the parsed `config`, and when known a `returnUrl` and the `customerEmail`. Returns a `reference`, a `status` and an `action`.
- `authorize`, `getStatus`: read or confirm the remote state.
- `capture`, `cancel`, `refund`: move money. Each gets an `idempotencyKey`. `capture` and `refund` also get `amount` and `currencyCode`, and `refund` gets `refundableAmount`.
- `parseWebhook(input)`: gets the `headers`, the exact `rawBody` bytes and the `config`. Verifies the signature and returns `{ eventId, reference, status }`.

The `action` tells the storefront what to do next. It is one of four:

- `none`: nothing to do. Cash on delivery and bank transfer answer this.
- `redirect`: send the shopper to a `url`.
- `form_post`: post a form of `fields` to a `url`.
- `embedded`: render a form on the checkout page. It carries a `clientToken` and a `publicConfig`, and `publicConfig.provider` names the component that renders it.

A provider never writes to the database. It answers with a status and an action. The orders module persists both and hands the action to the storefront without reading it.

### 2. Register it

Add the class to `apps/api/src/modules/payments/payment-providers.ts`:

```ts
export const PAYMENT_PROVIDER_IMPLEMENTATIONS = [
  CodPaymentProvider,
  ManualPaymentProvider,
  StripePaymentProvider,
] as const;
```

Each class carries two static fields:

- `providerId`: the value stored in `PaymentMethod.provider`. The admin allow-list and `REGISTERED_PAYMENT_PROVIDER_IDS` derive from it.
- `offeredAtCheckout`: whether the storefront may list a method of this provider. `CHECKOUT_PAYMENT_PROVIDER_IDS` filters on it, and `STOREFRONT_PAYMENT_PROVIDERS` in `payment-methods.service.ts` is that list.

```ts
@Injectable()
export class StripePaymentProvider implements PaymentProvider<StripeConfig> {
  static readonly providerId = 'stripe' as const;
  static readonly offeredAtCheckout = true;
  readonly id = StripePaymentProvider.providerId;
  readonly label = 'Stripe';
  readonly actionTypes = ['embedded', 'redirect'] as const;
  readonly secretFields = ['secretKey', 'webhookSecret'] as const;
  readonly configSchema = stripeConfigSchema;
```

### 3. The gateway holds the config

`PaymentGatewayService` resolves a method code to `{ provider, config }`, decrypts the secret fields, parses `config` through `provider.configSchema`, and calls the provider. The config never leaves the service. Callers pass a method code:

- `openSession(code, ...)` only opens on a live method row.
- `capture`, `refund`, `cancel`, `authorize` and `providerIdFor` still resolve an inactive or soft-deleted method, so an existing order can always be settled.
- `parseWebhook(providerId, headers, rawBody)` tries every method row of that provider in `sortOrder`, deleted rows included, and returns the event with the codes of the methods whose config verified it.

### 4. Secrets are entered in the admin

The operator types the provider keys on the payment method form. They land in the method row's `config`.

- List every secret key in `secretFields`. Stripe lists `secretKey` and `webhookSecret`. A key that is not listed is stored as plain text.
- The engine encrypts each secret field with AES-256-GCM before it is saved, using `PAYMENT_CONFIG_ENCRYPTION_KEY` (32 bytes, base64). Every admin read returns the field as `***`.
- To rotate the key, put the new one in `PAYMENT_CONFIG_ENCRYPTION_KEY` and keep the old ones in `PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS`, comma separated. Old values stay readable. To move them to the new key, run `npx ts-node -r tsconfig-paths/register --transpile-only apps/api/scripts/reencrypt-payment-config.ts` once. It rewrites every stored secret and reports how many rows changed. Then you can drop the old keys.
- Without a key the app still boots. Saving a secret then answers 503 `PAYMENT_CONFIG_ENCRYPTION_UNAVAILABLE`.
- A setting that is not a secret goes in `configSchema` as a plain field. Stripe has `checkoutMode` and `publishableKey`.
- Several method rows of one provider can be active at once, each with its own keys.

An env fallback is optional. The Stripe example still reads `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PUBLISHABLE_KEY` when the row has no value, and the row wins when both are set:

```ts
  constructor(config: ConfigService) {
    const apiKey = config.get<string>('STRIPE_API_KEY');
    this.client = apiKey ? this.buildClient(apiKey) : undefined;
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET') || undefined;
    this.envPublishableKey = config.get<string>('STRIPE_PUBLISHABLE_KEY') || undefined;
  }
```

If you add a fallback, add the prompts to `tools/setup/src/steps/payments.ts` and the keys to `compose-env.ts`. Without any key the call answers 503 `PAYMENT_PROVIDER_UNAVAILABLE`.

### 5. Calling the remote API

The Stripe example shows the rules a remote provider follows:

- A timeout on every call (`STRIPE_TIMEOUT_MS`, 5 s).
- A circuit breaker from `providers/circuit-breaker.ts` that counts only connection and server errors. After `STRIPE_FAILURE_THRESHOLD` failures it stays open for `STRIPE_COOLDOWN_MS`. An outage or an open circuit answers 503 `PAYMENT_PROVIDER_UNAVAILABLE`.
- Any other provider error answers `PAYMENT_PROVIDER_REJECTED` with the provider's code.
- Every response is parsed with Zod. A shape you did not expect is rejected as `invalid_response`, never trusted.
- `idempotencyKey` is forwarded on capture, cancel and refund, so a retried admin action does not move money twice. A refund is keyed by the order, its status and the amount, not the request, so a second request key cannot refund twice. `createSession` sends `checkout-session:<orderId>`, so a retried order create does not open a second intent.
- Amounts go out in integer minor units from `currencyEntry(code).decimalPlaces`. A currency the catalogue does not know is refused as `unsupported_currency`, never guessed. An amount finer than the currency allows is refused as `amount_precision`, never rounded.
- A status outside the allowed set is refused with `PAYMENT_TRANSITION_NOT_ALLOWED` before any remote call.

### 6. Refunds

`OrdersService` computes the refund, not the provider. It nets the refund amount of processed returns off the order total and passes the rest as both `amount` and `refundableAmount`. When nothing is left it refuses with `ORDER_NOTHING_TO_REFUND` before calling the gateway. A provider still refuses a zero, a negative amount or more than `refundableAmount`, and answers `REFUNDED` when the amount covers what is left, `PARTIALLY_REFUNDED` otherwise.

### 7. Webhooks

`POST /v1/webhooks/payments/:providerId` in `apps/api/src/modules/orders/payment-webhook.controller.ts` is `@Public()` (the signature is the auth) and `@RateLimit.Skip()`. `req.rawBody` is captured in `apps/api/src/main.ts` before the JSON parser runs, and `parseWebhook` must verify over those exact bytes.

`PaymentWebhookService` verifies, dedups, applies, then records:

```ts
    const { event, methodCodes } = await this.paymentGateway.parseWebhook(
      providerId,
      headers,
      rawBody,
    );
    const dedupKey = `payments:${providerId}`;

    if (await this.processedWebhooks.isProcessed(dedupKey, event.eventId)) {
      return { ok: true, replay: true };
    }

    await this.orders.applyPaymentWebhookEvent(providerId, event, methodCodes);
```

- A missing or bad signature answers `PAYMENT_WEBHOOK_SIGNATURE_INVALID`. A provider that takes no webhooks answers `PAYMENT_WEBHOOK_UNSUPPORTED`. For a verified event type you do not map, throw `PaymentWebhookIgnoredException` from `parseWebhook`: the service answers 200 without a write, so the provider stops retrying it.
- Two deliveries that race to the same status are fine: the second sees the status already landed and answers 200. A race to a different status answers `PAYMENT_TRANSITION_NOT_ALLOWED`.
- The order the event names must use one of the method codes whose secret verified it. A soft-deleted method's secret cannot move another method's orders.
- `ProcessedWebhook` has `@@unique([provider, externalEventId])`. `recordInboundEvent` runs after the apply, so a failed apply stays retryable, and a replay answers 200 with `replay: true` so the provider stops retrying.

The Stripe example maps:

- `payment_intent.amount_capturable_updated` to `AUTHORIZED`.
- `payment_intent.succeeded` to `CAPTURED`.
- `payment_intent.payment_failed` to `PENDING`. A failed attempt is not final: the intent goes back to `requires_payment_method` and the customer can try again. Map a retryable failure to a terminal status and the order can never be paid.
- `payment_intent.canceled` to `CANCELLED`.
- `charge.refunded` to `REFUNDED` when the whole charge is refunded, `PARTIALLY_REFUNDED` otherwise.

### 8. Offer it at checkout

The storefront has one handler for the payment action. It runs `none`, `redirect` and `form_post` for any provider, so a provider that uses only those needs no storefront change.

For `embedded`, the storefront renders the component registered for `publicConfig.provider` in `EMBEDDED_PAYMENT_COMPONENTS`, in `embedded-payment-host.component.ts`. Add one component and one line there. The component gets the inputs `clientToken`, `publicConfig` and `returnUrl`. A provider with no entry shows the `checkout.errors.paymentEmbeddedUnsupported` message.

Set `offeredAtCheckout = true` only if the storefront can run every action type your provider lists. Until then the admin can create the method, but `GET /v1/checkout/settings` never lists it and order create refuses it.

Order create reads the enabled set itself rather than trusting the client. No method enabled is `ORDER_PAYMENT_METHOD_UNAVAILABLE`, an unknown or disabled code is `ORDER_PAYMENT_METHOD_INVALID`. The create is idempotent: `IdempotencyKeyPipe` requires an `X-Idempotency-Key` UUID v4, Redis keeps it 24 hours, a different body is 409 `IDEMPOTENCY_KEY_CONFLICT`, a different caller 403 `IDEMPOTENCY_KEY_FORBIDDEN`, and a failure calls `abortRequest` so the client can retry with the same key.

The order exists before the shopper pays. A failed or abandoned payment leaves a pending order, and two routes let the shopper finish it. Both need `X-Idempotency-Key` and an owner or guest session:

- `POST /v1/orders/:id/payment` starts a fresh payment for an unpaid order and answers a new `paymentAction`. It answers 409 when the order cannot be retried.
- `POST /v1/orders/:id/payment/confirm` asks the provider for the live status when the shopper comes back, and answers `{ paymentStatus }`.

Webhooks stay the source of truth. Confirm only speeds up what the shopper sees.

## Tests to run

```bash
npx nx test api
npx nx test storefront
npm run test:e2e
npx nx e2e storefront-e2e
```

- Add a harness to `HARNESSES` in `payment-provider.conformance.spec.ts`. The suite checks the id, refuses every status outside the allowed set without a remote call, checks capture, cancel, full and partial refunds, refuses an over-refund, a zero and a negative amount, checks that the idempotency key is forwarded, and expects a 4xx on an unsigned webhook.
- `payment-provider.catalogue.spec.ts` checks that every registered provider appears in the admin catalogue with its secret fields.
- Write a provider spec beside it for what is only yours: the event mapping, the minor units, the outage handling. `stripe-payment.provider.spec.ts` is the model.
- For an `embedded` provider, add a spec beside your component, like `embedded-payment-host.component.spec.ts`.
- `npm run test:e2e` runs `apps/api/test/order-payments.e2e-spec.ts` (capture, refund, cancel and the Stripe webhook replay dedup) and `test/e2e/checkout-settings.e2e-spec.ts` (a method not offered at checkout never reaches the public list, and a planted secret never appears on the wire).
- `npx nx e2e storefront-e2e` runs the checkout journeys once the provider is offered.

## Gotchas

- Offering a provider whose action type the storefront cannot run produces orders nobody can pay.
- An empty enabled set refuses every order. Keep `cod` or `manual` active until the new path is proven. The `cod` seed is create-only, so a deploy does not re-enable a row the operator turned off.
- A PATCH that sends `***` back keeps the stored secret, `null` deletes the key, anything else overwrites. Never log the `config` blob.
- A secret you forget to list in `secretFields` is stored and returned as plain text.
- Losing `PAYMENT_CONFIG_ENCRYPTION_KEY` makes the stored secrets unreadable. Keep a copy, and keep retired keys in `PAYMENT_CONFIG_ENCRYPTION_KEYS_PREVIOUS`.
- The idempotency cache replays the serialized order create response for 24 hours. A field you add to it is in the replay too.
- `ProcessedWebhook` rows are never deleted. No retention job exists in `apps/api/src`.
- Keys that live in `config` are per method row. An env fallback is shared by every row of the provider.

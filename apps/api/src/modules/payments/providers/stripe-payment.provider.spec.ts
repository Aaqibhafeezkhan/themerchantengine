import { Logger } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PaymentProviderRejectedException } from '../payment-provider-rejected.exception';
import { PaymentProviderUnavailableException } from '../payment-provider-unavailable.exception';
import { PaymentTransitionNotAllowedException } from '../payment-transition-not-allowed.exception';
import { PaymentWebhookSignatureInvalidException } from '../payment-webhook-signature-invalid.exception';
import { PaymentWebhookIgnoredException } from '../payment-webhook-ignored.exception';
import { STRIPE_FAILURE_THRESHOLD, StripePaymentProvider } from './stripe-payment.provider';

const API_KEY = 'sk_test_example';
const WEBHOOK_SECRET = 'whsec_example';

function makeConfig(values: Record<string, string>) {
  return { get: jest.fn((k: string) => values[k]) } as never;
}

function makeProvider(
  values: Record<string, string> = {
    STRIPE_API_KEY: API_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  },
) {
  const provider = new StripePaymentProvider(makeConfig(values));
  const client = (provider as unknown as { client: Stripe | undefined }).client;
  return { provider, client };
}

function intent(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'pi_123',
    object: 'payment_intent',
    status,
    client_secret: 'pi_123_secret',
    ...extra,
  };
}

const base = {
  reference: 'pi_123',
  config: { checkoutMode: 'embedded' as const },
  idempotencyKey: 'op-key',
};

describe('StripePaymentProvider', () => {
  it('is labelled stripe and reads an empty config as embedded mode', () => {
    const { provider } = makeProvider();
    expect(provider.id).toBe('stripe');
    expect(StripePaymentProvider.providerId).toBe('stripe');
    expect(provider.configSchema.parse({})).toEqual({ checkoutMode: 'embedded' });
  });

  describe('admin-entered credentials', () => {
    it('declares the secret fields and both checkout modes', () => {
      const { provider } = makeProvider();
      expect([...provider.secretFields]).toEqual(['secretKey', 'webhookSecret']);
      expect([...provider.actionTypes].sort()).toEqual(['embedded', 'redirect']);
      expect(provider.configSchema.parse({ checkoutMode: 'redirect' })).toEqual({
        checkoutMode: 'redirect',
      });
      expect(() => provider.configSchema.parse({ checkoutMode: 'popup' })).toThrow();
    });

    function fakeClient() {
      const create = jest.fn().mockResolvedValue(intent('requires_payment_method'));
      return { create, client: { paymentIntents: { create } } as unknown as Stripe };
    }
    const session = {
      orderId: 'o1',
      amount: new Prisma.Decimal('10.00'),
      currencyCode: 'EUR',
    };

    it('uses the secret key from the method config instead of the env key', async () => {
      const { provider, client: envClient } = makeProvider();
      const envCreate = jest.spyOn(envClient!.paymentIntents, 'create');
      const fake = fakeClient();
      const build = jest
        .spyOn(provider as unknown as { buildClient: (k: string) => Stripe }, 'buildClient')
        .mockReturnValue(fake.client);

      await provider.createSession({
        ...session,
        config: { checkoutMode: 'embedded', secretKey: 'sk_test_from_admin' },
      });
      await provider.createSession({
        ...session,
        config: { checkoutMode: 'embedded', secretKey: 'sk_test_from_admin' },
      });

      expect(build).toHaveBeenCalledTimes(1);
      expect(build).toHaveBeenCalledWith('sk_test_from_admin');
      expect(fake.create).toHaveBeenCalledTimes(2);
      expect(envCreate).not.toHaveBeenCalled();
    });

    it('serves a method config with a key even when the env has none', async () => {
      const { provider } = makeProvider({ STRIPE_API_KEY: '', STRIPE_WEBHOOK_SECRET: '' });
      const fake = fakeClient();
      jest
        .spyOn(provider as unknown as { buildClient: (k: string) => Stripe }, 'buildClient')
        .mockReturnValue(fake.client);

      const result = await provider.createSession({
        ...session,
        config: { checkoutMode: 'embedded', secretKey: 'sk_test_from_admin' },
      });

      expect(result.action).toEqual({
        type: 'embedded',
        clientToken: 'pi_123_secret',
        publicConfig: { provider: 'stripe' },
      });
    });

    it('verifies a webhook with the secret from the method config before the env one', async () => {
      const { provider } = makeProvider();
      const payload = JSON.stringify({
        id: 'evt_cfg',
        object: 'event',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_123' } },
      });
      const header = Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: 'whsec_from_admin',
      });

      const event = await provider.parseWebhook({
        headers: { 'stripe-signature': header },
        rawBody: Buffer.from(payload),
        config: { checkoutMode: 'embedded' as const, webhookSecret: 'whsec_from_admin' },
      });

      expect(event).toEqual({
        eventId: 'evt_cfg',
        reference: 'pi_123',
        status: PaymentStatus.CAPTURED,
      });
      await expect(
        provider.parseWebhook({
          headers: { 'stripe-signature': header },
          rawBody: Buffer.from(payload),
          config: { checkoutMode: 'embedded' as const },
        }),
      ).rejects.toBeInstanceOf(PaymentWebhookSignatureInvalidException);
    });
  });

  it('builds the SDK client with a 5 s timeout', () => {
    const { client } = makeProvider();
    expect(client?.getApiField('timeout')).toBe(5000);
  });

  describe('without STRIPE_API_KEY', () => {
    it('boots and refuses every call as unavailable', async () => {
      const { provider } = makeProvider({ STRIPE_API_KEY: '', STRIPE_WEBHOOK_SECRET: '' });
      await expect(
        provider.createSession({
          orderId: 'o1',
          amount: new Prisma.Decimal('10.00'),
          currencyCode: 'EUR',
          config: { checkoutMode: 'embedded' as const },
        }),
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableException);
      await expect(
        provider.getStatus({ ...base, status: PaymentStatus.PENDING }),
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableException);
    });
  });

  describe('createSession', () => {
    it('creates a manual-capture PaymentIntent in minor units', async () => {
      const { provider, client } = makeProvider();
      const create = jest
        .spyOn(client!.paymentIntents, 'create')
        .mockResolvedValue(intent('requires_payment_method') as never);

      const result = await provider.createSession({
        orderId: 'o1',
        amount: new Prisma.Decimal('125.500'),
        currencyCode: 'KWD',
        config: { checkoutMode: 'embedded' as const },
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 125500,
          currency: 'kwd',
          capture_method: 'manual',
          metadata: { orderId: 'o1' },
        }),
        { idempotencyKey: 'checkout-session:o1' },
      );
      expect(result).toEqual({
        reference: 'pi_123',
        status: PaymentStatus.PENDING,
        action: {
          type: 'embedded',
          clientToken: 'pi_123_secret',
          publicConfig: { provider: 'stripe' },
        },
      });
    });

    it('uses two decimals for a two-decimal currency', async () => {
      const { provider, client } = makeProvider();
      const create = jest
        .spyOn(client!.paymentIntents, 'create')
        .mockResolvedValue(intent('requires_payment_method') as never);

      await provider.createSession({
        orderId: 'o1',
        amount: new Prisma.Decimal('10.50'),
        currencyCode: 'EUR',
        config: { checkoutMode: 'embedded' as const },
      });

      expect(create.mock.calls[0][0]).toMatchObject({ amount: 1050, currency: 'eur' });
    });

    it('refuses an unknown currency without a call, never guessing its decimals', async () => {
      const { provider, client } = makeProvider();
      const create = jest.spyOn(client!.paymentIntents, 'create');

      await expect(
        provider.createSession({
          orderId: 'o1',
          amount: new Prisma.Decimal('7.25'),
          currencyCode: 'XTS',
          config: { checkoutMode: 'embedded' as const },
        }),
      ).rejects.toMatchObject({
        response: {
          error: { details: expect.objectContaining({ reason: 'unsupported_currency' }) },
        },
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses an amount finer than the currency allows, without a call', async () => {
      const { provider, client } = makeProvider();
      const create = jest.spyOn(client!.paymentIntents, 'create');
      await expect(
        provider.createSession({
          orderId: 'o1',
          amount: new Prisma.Decimal('10.555'),
          currencyCode: 'EUR',
          config: { checkoutMode: 'embedded' as const },
        }),
      ).rejects.toBeInstanceOf(PaymentProviderRejectedException);
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a response that does not match the schema', async () => {
      const { provider, client } = makeProvider();
      jest.spyOn(client!.paymentIntents, 'create').mockResolvedValue({ id: 42 } as never);
      await expect(
        provider.createSession({
          orderId: 'o1',
          amount: new Prisma.Decimal('10.00'),
          currencyCode: 'EUR',
          config: { checkoutMode: 'embedded' as const },
        }),
      ).rejects.toBeInstanceOf(PaymentProviderRejectedException);
    });

    it('embedded mode tells the storefront which provider and publishable key to mount', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.paymentIntents, 'create')
        .mockResolvedValue(intent('requires_payment_method') as never);

      const result = await provider.createSession({
        orderId: 'o1',
        amount: new Prisma.Decimal('10.00'),
        currencyCode: 'EUR',
        config: { checkoutMode: 'embedded', publishableKey: 'pk_test_example' },
      });

      expect(result.action).toEqual({
        type: 'embedded',
        clientToken: 'pi_123_secret',
        publicConfig: { provider: 'stripe', publishableKey: 'pk_test_example' },
      });
    });

    it('embedded mode falls back to STRIPE_PUBLISHABLE_KEY when the method has no key', async () => {
      const { provider, client } = makeProvider({
        STRIPE_API_KEY: API_KEY,
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_PUBLISHABLE_KEY: 'pk_test_env',
      });
      jest
        .spyOn(client!.paymentIntents, 'create')
        .mockResolvedValue(intent('requires_payment_method') as never);

      const result = await provider.createSession({
        orderId: 'o1',
        amount: new Prisma.Decimal('10.00'),
        currencyCode: 'EUR',
        config: { checkoutMode: 'embedded' },
      });

      expect(result.action).toMatchObject({
        publicConfig: { provider: 'stripe', publishableKey: 'pk_test_env' },
      });
    });

    describe('redirect mode', () => {
      const redirectInput = {
        orderId: 'o1',
        amount: new Prisma.Decimal('10.50'),
        currencyCode: 'EUR',
        returnUrl: 'https://shop.example.test/en/orders/o1/payment-return',
        config: { checkoutMode: 'redirect' as const },
      };

      function checkoutSession(extra: Record<string, unknown> = {}) {
        return {
          id: 'cs_123',
          object: 'checkout.session',
          status: 'open',
          url: 'https://checkout.stripe.test/c/pay/cs_123',
          ...extra,
        };
      }

      it('opens a hosted Checkout Session with manual capture and returns its URL', async () => {
        const { provider, client } = makeProvider();
        const intentCreate = jest.spyOn(client!.paymentIntents, 'create');
        const create = jest
          .spyOn(client!.checkout.sessions, 'create')
          .mockResolvedValue(checkoutSession() as never);

        const result = await provider.createSession(redirectInput);

        expect(intentCreate).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'payment',
            success_url: redirectInput.returnUrl,
            cancel_url: redirectInput.returnUrl,
            client_reference_id: 'o1',
            line_items: [
              expect.objectContaining({
                quantity: 1,
                price_data: expect.objectContaining({ currency: 'eur', unit_amount: 1050 }),
              }),
            ],
            payment_intent_data: expect.objectContaining({
              capture_method: 'manual',
              metadata: { orderId: 'o1', checkoutMode: 'redirect' },
            }),
          }),
          { idempotencyKey: expect.stringMatching(/^checkout-session:o1:[0-9a-f-]{36}$/) },
        );
        expect(result).toEqual({
          reference: 'cs_123',
          status: PaymentStatus.PENDING,
          action: { type: 'redirect', url: 'https://checkout.stripe.test/c/pay/cs_123' },
        });
      });

      it('prefills the Stripe email field with the customer email', async () => {
        const { provider, client } = makeProvider();
        const create = jest
          .spyOn(client!.checkout.sessions, 'create')
          .mockResolvedValue(checkoutSession() as never);

        await provider.createSession({ ...redirectInput, customerEmail: 'buyer@example.test' });

        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({ customer_email: 'buyer@example.test' }),
          expect.anything(),
        );
      });

      it('sends no customer_email when none is known', async () => {
        const { provider, client } = makeProvider();
        const create = jest
          .spyOn(client!.checkout.sessions, 'create')
          .mockResolvedValue(checkoutSession() as never);

        await provider.createSession(redirectInput);

        expect(create.mock.calls[0][0]).not.toHaveProperty('customer_email');
      });

      it('opens a fresh session on every call, so Pay again never replays a dead one', async () => {
        const { provider, client } = makeProvider();
        const create = jest
          .spyOn(client!.checkout.sessions, 'create')
          .mockResolvedValue(checkoutSession() as never);

        await provider.createSession(redirectInput);
        await provider.createSession(redirectInput);

        const keys = create.mock.calls.map((call) => call[1]?.idempotencyKey);
        expect(keys[0]).not.toBe(keys[1]);
      });

      it('refuses to open a session without a return URL, without a call', async () => {
        const { provider, client } = makeProvider();
        const create = jest.spyOn(client!.checkout.sessions, 'create');

        await expect(
          provider.createSession({ ...redirectInput, returnUrl: undefined }),
        ).rejects.toMatchObject({
          response: {
            error: { details: expect.objectContaining({ reason: 'missing_return_url' }) },
          },
        });
        expect(create).not.toHaveBeenCalled();
      });

      it('refuses a session that came back without a URL', async () => {
        const { provider, client } = makeProvider();
        jest
          .spyOn(client!.checkout.sessions, 'create')
          .mockResolvedValue(checkoutSession({ url: null }) as never);

        await expect(provider.createSession(redirectInput)).rejects.toBeInstanceOf(
          PaymentProviderRejectedException,
        );
      });
    });

    describe('checkout mode per order', () => {
      const orderInput = {
        amount: new Prisma.Decimal('10.00'),
        currencyCode: 'EUR',
        returnUrl: 'https://shop.example.test/en/orders/o/payment-return',
      };

      it('a mode flip takes effect on the next order, in both directions', async () => {
        const { provider, client } = makeProvider();
        jest
          .spyOn(client!.paymentIntents, 'create')
          .mockResolvedValue(intent('requires_payment_method') as never);
        jest.spyOn(client!.checkout.sessions, 'create').mockResolvedValue({
          id: 'cs_123',
          object: 'checkout.session',
          status: 'open',
          url: 'https://checkout.stripe.test/c/pay/cs_123',
        } as never);

        const first = await provider.createSession({
          ...orderInput,
          orderId: 'o1',
          config: { checkoutMode: 'embedded' },
        });
        const second = await provider.createSession({
          ...orderInput,
          orderId: 'o2',
          config: { checkoutMode: 'redirect' },
        });
        const third = await provider.createSession({
          ...orderInput,
          orderId: 'o3',
          config: { checkoutMode: 'embedded' },
        });

        expect(first.action.type).toBe('embedded');
        expect(second.action.type).toBe('redirect');
        expect(third.action.type).toBe('embedded');
      });

      it.each([
        ['embedded', 'paymentIntents'],
        ['redirect', 'checkout.sessions'],
      ] as const)(
        'a declined card in %s mode is rejected and never opens the breaker',
        async (checkoutMode, target) => {
          const { provider, client } = makeProvider();
          const declined = new Stripe.errors.StripeCardError({
            message: 'declined',
            code: 'card_declined',
          });
          const create = jest
            .spyOn(
              target === 'paymentIntents' ? client!.paymentIntents : client!.checkout.sessions,
              'create',
            )
            .mockRejectedValue(declined as never);

          for (let i = 0; i <= STRIPE_FAILURE_THRESHOLD; i += 1) {
            await expect(
              provider.createSession({
                ...orderInput,
                orderId: `o${i}`,
                config: { checkoutMode },
              }),
            ).rejects.toBeInstanceOf(PaymentProviderRejectedException);
          }
          expect(create).toHaveBeenCalledTimes(STRIPE_FAILURE_THRESHOLD + 1);
        },
      );

      it('logs the Stripe rejection type and code, never the message', async () => {
        const { provider, client } = makeProvider();
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(client!.paymentIntents, 'create').mockRejectedValue(
          new Stripe.errors.StripeInvalidRequestError({
            message: 'No such customer: cus_secret',
            code: 'resource_missing',
          }) as never,
        );
        await expect(
          provider.createSession({
            ...orderInput,
            orderId: 'o1',
            config: { checkoutMode: 'embedded' },
          }),
        ).rejects.toBeInstanceOf(PaymentProviderRejectedException);
        const logged = warn.mock.calls.map((call) => String(call[0])).join(' ');
        expect(logged).toContain('resource_missing');
        expect(logged).toContain('StripeInvalidRequestError');
        expect(logged).not.toContain('cus_secret');
        warn.mockRestore();
      });
    });
  });

  describe('authorize', () => {
    it('confirms a held PaymentIntent as AUTHORIZED', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.paymentIntents, 'retrieve')
        .mockResolvedValue(intent('requires_capture') as never);
      await expect(provider.authorize({ ...base, status: PaymentStatus.PENDING })).resolves.toEqual(
        { reference: 'pi_123', status: PaymentStatus.AUTHORIZED },
      );
    });

    it('refuses when Stripe holds no funds yet', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.paymentIntents, 'retrieve')
        .mockResolvedValue(intent('requires_payment_method') as never);
      await expect(
        provider.authorize({ ...base, status: PaymentStatus.PENDING }),
      ).rejects.toBeInstanceOf(PaymentTransitionNotAllowedException);
    });
  });

  describe('hosted checkout references', () => {
    const hosted = { ...base, reference: 'cs_123' };

    it('authorizes through the PaymentIntent behind the session', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.checkout.sessions, 'retrieve')
        .mockResolvedValue({ id: 'cs_123', payment_intent: 'pi_123' } as never);
      const retrieve = jest
        .spyOn(client!.paymentIntents, 'retrieve')
        .mockResolvedValue(intent('requires_capture') as never);

      await expect(
        provider.authorize({ ...hosted, status: PaymentStatus.PENDING }),
      ).resolves.toEqual({ reference: 'cs_123', status: PaymentStatus.AUTHORIZED });
      expect(retrieve).toHaveBeenCalledWith('pi_123');
    });

    it('reports PENDING while the shopper has not paid on the hosted page', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.checkout.sessions, 'retrieve')
        .mockResolvedValue({ id: 'cs_123', payment_intent: null } as never);
      const retrieve = jest.spyOn(client!.paymentIntents, 'retrieve');

      await expect(
        provider.getStatus({ ...hosted, status: PaymentStatus.PENDING }),
      ).resolves.toEqual({ reference: 'cs_123', status: PaymentStatus.PENDING });
      expect(retrieve).not.toHaveBeenCalled();
    });

    it('captures on the PaymentIntent behind the session', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.checkout.sessions, 'retrieve')
        .mockResolvedValue({ id: 'cs_123', payment_intent: 'pi_123' } as never);
      const capture = jest
        .spyOn(client!.paymentIntents, 'capture')
        .mockResolvedValue(intent('succeeded') as never);

      await provider.capture({
        ...hosted,
        status: PaymentStatus.AUTHORIZED,
        amount: new Prisma.Decimal('10.00'),
        currencyCode: 'EUR',
      });

      expect(capture).toHaveBeenCalledWith(
        'pi_123',
        { amount_to_capture: 1000 },
        { idempotencyKey: 'op-key' },
      );
    });

    it('expires an unpaid session on cancel instead of cancelling an intent', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.checkout.sessions, 'retrieve')
        .mockResolvedValue({ id: 'cs_123', payment_intent: null } as never);
      const expire = jest
        .spyOn(client!.checkout.sessions, 'expire')
        .mockResolvedValue({ id: 'cs_123' } as never);
      const cancel = jest.spyOn(client!.paymentIntents, 'cancel');

      await expect(provider.cancel({ ...hosted, status: PaymentStatus.PENDING })).resolves.toEqual({
        reference: 'cs_123',
        status: PaymentStatus.CANCELLED,
      });
      expect(expire).toHaveBeenCalledWith('cs_123');
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  describe('capture', () => {
    it('captures the amount with the idempotency key', async () => {
      const { provider, client } = makeProvider();
      const capture = jest
        .spyOn(client!.paymentIntents, 'capture')
        .mockResolvedValue(intent('succeeded') as never);

      const result = await provider.capture({
        ...base,
        status: PaymentStatus.AUTHORIZED,
        amount: new Prisma.Decimal('125.500'),
        currencyCode: 'KWD',
      });

      expect(capture).toHaveBeenCalledWith(
        'pi_123',
        { amount_to_capture: 125500 },
        { idempotencyKey: 'op-key' },
      );
      expect(result).toEqual({ reference: 'pi_123', status: PaymentStatus.CAPTURED });
    });

    it('refuses from PENDING without a call', async () => {
      const { provider, client } = makeProvider();
      const capture = jest.spyOn(client!.paymentIntents, 'capture');
      await expect(
        provider.capture({
          ...base,
          status: PaymentStatus.PENDING,
          amount: new Prisma.Decimal('1.00'),
          currencyCode: 'KWD',
        }),
      ).rejects.toBeInstanceOf(PaymentTransitionNotAllowedException);
      expect(capture).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it.each([PaymentStatus.PENDING, PaymentStatus.AUTHORIZED])(
      'cancels from %s with the idempotency key',
      async (status) => {
        const { provider, client } = makeProvider();
        const cancel = jest
          .spyOn(client!.paymentIntents, 'cancel')
          .mockResolvedValue(intent('canceled') as never);
        await expect(provider.cancel({ ...base, status })).resolves.toEqual({
          reference: 'pi_123',
          status: PaymentStatus.CANCELLED,
        });
        expect(cancel).toHaveBeenCalledWith('pi_123', {}, { idempotencyKey: 'op-key' });
      },
    );

    it('refuses from CAPTURED', async () => {
      const { provider } = makeProvider();
      await expect(
        provider.cancel({ ...base, status: PaymentStatus.CAPTURED }),
      ).rejects.toBeInstanceOf(PaymentTransitionNotAllowedException);
    });
  });

  describe('refund', () => {
    const refundInput = (amount: string) => ({
      ...base,
      status: PaymentStatus.CAPTURED,
      amount: new Prisma.Decimal(amount),
      currencyCode: 'EUR',
      refundableAmount: new Prisma.Decimal('100.00'),
    });

    it('refunds part of the payment with the idempotency key', async () => {
      const { provider, client } = makeProvider();
      const create = jest
        .spyOn(client!.refunds, 'create')
        .mockResolvedValue({ id: 're_1', object: 'refund', status: 'succeeded' } as never);

      await expect(provider.refund(refundInput('40.00'))).resolves.toEqual({
        reference: 'pi_123',
        status: PaymentStatus.PARTIALLY_REFUNDED,
      });
      expect(create).toHaveBeenCalledWith(
        { payment_intent: 'pi_123', amount: 4000 },
        { idempotencyKey: 'op-key' },
      );
    });

    it('marks a refund of everything left as REFUNDED', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.refunds, 'create')
        .mockResolvedValue({ id: 're_1', object: 'refund', status: 'pending' } as never);
      await expect(provider.refund(refundInput('100.00'))).resolves.toEqual({
        reference: 'pi_123',
        status: PaymentStatus.REFUNDED,
      });
    });

    it.each(['0', '100.01'])('refuses %s without a call', async (amount) => {
      const { provider, client } = makeProvider();
      const create = jest.spyOn(client!.refunds, 'create');
      await expect(provider.refund(refundInput(amount))).rejects.toBeInstanceOf(
        PaymentTransitionNotAllowedException,
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('treats a failed refund as rejected', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.refunds, 'create')
        .mockResolvedValue({ id: 're_1', object: 'refund', status: 'failed' } as never);
      await expect(provider.refund(refundInput('40.00'))).rejects.toBeInstanceOf(
        PaymentProviderRejectedException,
      );
    });
  });

  describe('getStatus', () => {
    it.each([
      ['requires_action', PaymentStatus.PENDING, PaymentStatus.PENDING],
      ['requires_capture', PaymentStatus.PENDING, PaymentStatus.AUTHORIZED],
      ['succeeded', PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED],
      ['canceled', PaymentStatus.PENDING, PaymentStatus.CANCELLED],
      ['succeeded', PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.PARTIALLY_REFUNDED],
    ])('maps %s from %s to %s', async (stripeStatus, status, expected) => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.paymentIntents, 'retrieve')
        .mockResolvedValue(intent(stripeStatus) as never);
      await expect(provider.getStatus({ ...base, status })).resolves.toEqual({
        reference: 'pi_123',
        status: expected,
      });
    });
  });

  describe('SDK errors', () => {
    it('maps a connection error to unavailable and opens the breaker', async () => {
      const { provider, client } = makeProvider();
      const retrieve = jest
        .spyOn(client!.paymentIntents, 'retrieve')
        .mockRejectedValue(new Stripe.errors.StripeConnectionError({ message: 'down' }));
      const input = { ...base, status: PaymentStatus.PENDING };

      for (let i = 0; i < STRIPE_FAILURE_THRESHOLD; i += 1) {
        await expect(provider.getStatus(input)).rejects.toBeInstanceOf(
          PaymentProviderUnavailableException,
        );
      }
      await expect(provider.getStatus(input)).rejects.toBeInstanceOf(
        PaymentProviderUnavailableException,
      );
      expect(retrieve).toHaveBeenCalledTimes(STRIPE_FAILURE_THRESHOLD);
    });

    it('maps a card error to rejected without opening the breaker', async () => {
      const { provider, client } = makeProvider();
      const retrieve = jest
        .spyOn(client!.paymentIntents, 'retrieve')
        .mockRejectedValue(
          new Stripe.errors.StripeCardError({ message: 'declined', code: 'card_declined' }),
        );
      const input = { ...base, status: PaymentStatus.PENDING };

      for (let i = 0; i <= STRIPE_FAILURE_THRESHOLD; i += 1) {
        await expect(provider.getStatus(input)).rejects.toBeInstanceOf(
          PaymentProviderRejectedException,
        );
      }
      expect(retrieve).toHaveBeenCalledTimes(STRIPE_FAILURE_THRESHOLD + 1);
    });
  });

  describe('parseWebhook', () => {
    function signed(event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
      const payload = JSON.stringify(event);
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
      return {
        headers: { 'stripe-signature': header },
        rawBody: Buffer.from(payload),
        config: { checkoutMode: 'embedded' as const },
      };
    }

    function event(type: string, object: Record<string, unknown>) {
      return { id: 'evt_1', object: 'event', type, data: { object } };
    }

    it.each([
      ['payment_intent.amount_capturable_updated', PaymentStatus.AUTHORIZED],
      ['payment_intent.succeeded', PaymentStatus.CAPTURED],
      // A failed attempt is retryable: the intent goes back to requires_payment_method.
      ['payment_intent.payment_failed', PaymentStatus.PENDING],
      ['payment_intent.canceled', PaymentStatus.CANCELLED],
    ])('maps %s to %s', async (type, status) => {
      const { provider } = makeProvider();
      await expect(
        provider.parseWebhook(signed(event(type, { id: 'pi_123', object: 'payment_intent' }))),
      ).resolves.toEqual({ eventId: 'evt_1', reference: 'pi_123', status });
    });

    it.each([
      [4000, PaymentStatus.PARTIALLY_REFUNDED],
      [10000, PaymentStatus.REFUNDED],
    ])('maps charge.refunded of %i to %s on the PaymentIntent', async (refunded, status) => {
      const { provider, client } = makeProvider();
      jest.spyOn(client!.checkout.sessions, 'list').mockResolvedValue({ data: [] } as never);
      const charge = {
        id: 'ch_1',
        object: 'charge',
        payment_intent: 'pi_123',
        amount: 10000,
        amount_refunded: refunded,
      };
      await expect(
        provider.parseWebhook(signed(event('charge.refunded', charge))),
      ).resolves.toEqual({ eventId: 'evt_1', reference: 'pi_123', status });
    });

    it('maps a hosted-checkout intent event back to its session reference', async () => {
      const { provider, client } = makeProvider();
      const list = jest
        .spyOn(client!.checkout.sessions, 'list')
        .mockResolvedValue({ data: [{ id: 'cs_123' }] } as never);
      const object = {
        id: 'pi_123',
        object: 'payment_intent',
        metadata: { orderId: 'o1', checkoutMode: 'redirect' },
      };

      await expect(
        provider.parseWebhook(signed(event('payment_intent.amount_capturable_updated', object))),
      ).resolves.toEqual({
        eventId: 'evt_1',
        reference: 'cs_123',
        status: PaymentStatus.AUTHORIZED,
      });
      expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_123', limit: 1 });
    });

    it('maps a redirect-mode refund back to its session reference', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.checkout.sessions, 'list')
        .mockResolvedValue({ data: [{ id: 'cs_123' }] } as never);
      const charge = {
        id: 'ch_1',
        object: 'charge',
        payment_intent: 'pi_123',
        amount: 10000,
        amount_refunded: 10000,
      };

      await expect(
        provider.parseWebhook({
          ...signed(event('charge.refunded', charge)),
          config: { checkoutMode: 'redirect' },
        }),
      ).resolves.toEqual({ eventId: 'evt_1', reference: 'cs_123', status: PaymentStatus.REFUNDED });
    });

    it('maps a refund of a hosted payment to its session even after the method flipped to embedded', async () => {
      const { provider, client } = makeProvider();
      jest
        .spyOn(client!.checkout.sessions, 'list')
        .mockResolvedValue({ data: [{ id: 'cs_123' }] } as never);
      const charge = {
        id: 'ch_1',
        object: 'charge',
        payment_intent: 'pi_123',
        amount: 10000,
        amount_refunded: 4000,
      };

      await expect(
        provider.parseWebhook(signed(event('charge.refunded', charge))),
      ).resolves.toEqual({
        eventId: 'evt_1',
        reference: 'cs_123',
        status: PaymentStatus.PARTIALLY_REFUNDED,
      });
    });

    it('keeps the intent reference for a refund when no session wraps it', async () => {
      const { provider, client } = makeProvider();
      jest.spyOn(client!.checkout.sessions, 'list').mockResolvedValue({ data: [] } as never);
      const charge = {
        id: 'ch_1',
        object: 'charge',
        payment_intent: 'pi_123',
        amount: 10000,
        amount_refunded: 10000,
      };

      await expect(
        provider.parseWebhook(signed(event('charge.refunded', charge))),
      ).resolves.toMatchObject({ reference: 'pi_123' });
    });

    it('refuses a payload signed with another secret', async () => {
      const { provider } = makeProvider();
      await expect(
        provider.parseWebhook(
          signed(event('payment_intent.succeeded', { id: 'pi_123' }), 'whsec_other'),
        ),
      ).rejects.toBeInstanceOf(PaymentWebhookSignatureInvalidException);
    });

    it('refuses a missing or repeated signature header', async () => {
      const { provider } = makeProvider();
      const input = signed(event('payment_intent.succeeded', { id: 'pi_123' }));
      const header = input.headers['stripe-signature'];
      await expect(provider.parseWebhook({ ...input, headers: {} })).rejects.toBeInstanceOf(
        PaymentWebhookSignatureInvalidException,
      );
      await expect(
        provider.parseWebhook({ ...input, headers: { 'stripe-signature': [header, header] } }),
      ).rejects.toBeInstanceOf(PaymentWebhookSignatureInvalidException);
    });

    it('flags a verified event type it does not map as ignorable', async () => {
      const { provider } = makeProvider();
      await expect(
        provider.parseWebhook(signed(event('checkout.session.completed', { id: 'cs_1' }))),
      ).rejects.toBeInstanceOf(PaymentWebhookIgnoredException);
    });

    it('refuses a mapped event whose object does not match the schema', async () => {
      const { provider } = makeProvider();
      await expect(
        provider.parseWebhook(signed(event('payment_intent.succeeded', { id: 42 }))),
      ).rejects.toBeInstanceOf(PaymentProviderRejectedException);
    });

    it('is unavailable without STRIPE_WEBHOOK_SECRET', async () => {
      const { provider } = makeProvider({ STRIPE_API_KEY: API_KEY, STRIPE_WEBHOOK_SECRET: '' });
      await expect(
        provider.parseWebhook(signed(event('payment_intent.succeeded', { id: 'pi_123' }))),
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableException);
    });
  });
});

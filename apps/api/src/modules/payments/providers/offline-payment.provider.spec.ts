import { PaymentStatus, Prisma } from '@prisma/client';
import { PaymentTransitionNotAllowedException } from '../payment-transition-not-allowed.exception';
import { PaymentWebhookUnsupportedException } from '../payment-webhook-unsupported.exception';
import { CodPaymentProvider } from './cod-payment.provider';
import { ManualPaymentProvider } from './manual-payment.provider';
import type { PaymentProvider } from './payment-provider.interface';

// The money moves outside the engine, so each offline provider only checks
// that the status change is legal and never calls out.
describe.each([
  ['cod', CodPaymentProvider],
  ['manual', ManualPaymentProvider],
] as const)('%s offline payment provider', (id, Provider) => {
  let provider: PaymentProvider;
  const config = {};
  const amount = new Prisma.Decimal('125.500');
  const currencyCode = 'KWD';
  const idempotencyKey = 'op-key';

  beforeEach(() => {
    provider = new Provider();
  });

  it(`has the id "${id}" exposed statically for the module array`, () => {
    expect(Provider.providerId).toBe(id);
    expect(provider.id).toBe(id);
  });

  it('accepts an empty config and strips unknown keys', () => {
    expect(provider.configSchema.parse({})).toEqual({});
    expect(provider.configSchema.parse({ apiKey: 'leftover' })).toEqual({});
  });

  it('opens a pending session with a reference derived from the order', async () => {
    const session = await provider.createSession({
      orderId: 'order-1',
      amount,
      currencyCode: 'KWD',
      config,
    });

    expect(session).toEqual({
      reference: `${id}_order-1`,
      status: PaymentStatus.PENDING,
      action: { type: 'none' },
    });
  });

  it('captures a pending payment once the money is received', async () => {
    await expect(
      provider.capture({
        reference: 'r',
        status: PaymentStatus.PENDING,
        amount,
        currencyCode,
        idempotencyKey,
        config,
      }),
    ).resolves.toEqual({ reference: 'r', status: PaymentStatus.CAPTURED });
  });

  it('cancels a pending payment', async () => {
    await expect(
      provider.cancel({ reference: 'r', status: PaymentStatus.PENDING, idempotencyKey, config }),
    ).resolves.toEqual({ reference: 'r', status: PaymentStatus.CANCELLED });
  });

  it('fully refunds when the refund covers what is left', async () => {
    await expect(
      provider.refund({
        reference: 'r',
        status: PaymentStatus.CAPTURED,
        amount,
        refundableAmount: amount,
        currencyCode,
        idempotencyKey,
        config,
      }),
    ).resolves.toEqual({ reference: 'r', status: PaymentStatus.REFUNDED });
  });

  it('partially refunds when the refund is smaller than what is left', async () => {
    await expect(
      provider.refund({
        reference: 'r',
        status: PaymentStatus.CAPTURED,
        amount: new Prisma.Decimal('25.000'),
        refundableAmount: amount,
        currencyCode,
        idempotencyKey,
        config,
      }),
    ).resolves.toEqual({ reference: 'r', status: PaymentStatus.PARTIALLY_REFUNDED });
  });

  it('refunds the rest of a partially refunded payment', async () => {
    await expect(
      provider.refund({
        reference: 'r',
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amount: new Prisma.Decimal('100.500'),
        refundableAmount: new Prisma.Decimal('100.500'),
        currencyCode,
        idempotencyKey,
        config,
      }),
    ).resolves.toEqual({ reference: 'r', status: PaymentStatus.REFUNDED });
  });

  it('rejects a refund larger than what is left', async () => {
    await expect(
      provider.refund({
        reference: 'r',
        status: PaymentStatus.CAPTURED,
        amount: new Prisma.Decimal('125.501'),
        refundableAmount: amount,
        currencyCode,
        idempotencyKey,
        config,
      }),
    ).rejects.toBeInstanceOf(PaymentTransitionNotAllowedException);
  });

  it('rejects a zero or negative refund', async () => {
    for (const value of ['0', '-1']) {
      await expect(
        provider.refund({
          reference: 'r',
          status: PaymentStatus.CAPTURED,
          amount: new Prisma.Decimal(value),
          refundableAmount: amount,
          currencyCode,
          idempotencyKey,
          config,
        }),
      ).rejects.toBeInstanceOf(PaymentTransitionNotAllowedException);
    }
  });

  it('cannot authorize, since nothing is held before the money arrives', async () => {
    await expect(
      provider.authorize({ reference: 'r', status: PaymentStatus.PENDING, config }),
    ).rejects.toBeInstanceOf(PaymentTransitionNotAllowedException);
  });

  it.each([
    ['capture', PaymentStatus.CAPTURED],
    ['capture', PaymentStatus.CANCELLED],
    ['capture', PaymentStatus.REFUNDED],
    ['cancel', PaymentStatus.CAPTURED],
    ['cancel', PaymentStatus.REFUNDED],
    ['refund', PaymentStatus.PENDING],
    ['refund', PaymentStatus.CANCELLED],
    ['refund', PaymentStatus.REFUNDED],
  ] as const)('refuses to %s from %s', async (action, status) => {
    const call =
      action === 'capture'
        ? provider.capture({ reference: 'r', status, amount, currencyCode, idempotencyKey, config })
        : action === 'cancel'
          ? provider.cancel({ reference: 'r', status, idempotencyKey, config })
          : provider.refund({
              reference: 'r',
              status,
              amount,
              refundableAmount: amount,
              currencyCode,
              idempotencyKey,
              config,
            });

    await expect(call).rejects.toMatchObject({
      response: {
        error: {
          code: 'PAYMENT_TRANSITION_NOT_ALLOWED',
          details: { providerId: id, action, from: status },
        },
      },
    });
  });

  it('reports the stored status, since no remote state exists', async () => {
    await expect(
      provider.getStatus({ reference: 'r', status: PaymentStatus.CAPTURED, config }),
    ).resolves.toEqual({ reference: 'r', status: PaymentStatus.CAPTURED });
  });

  it('rejects every webhook', async () => {
    await expect(
      provider.parseWebhook({ headers: {}, rawBody: Buffer.from('{}'), config }),
    ).rejects.toBeInstanceOf(PaymentWebhookUnsupportedException);
  });
});

import { PaymentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { PaymentConfigCrypto } from './payment-config-crypto';
import { PaymentGatewayService } from './payment-gateway.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PaymentProviderUnknownException } from './payment-provider-unknown.exception';
import type { PaymentProvider } from './providers/payment-provider.interface';

type FakeProvider = Omit<jest.Mocked<PaymentProvider<{ secret: string }>>, 'secretFields'> & {
  secretFields: string[];
};

function fakeProvider(id: string): FakeProvider {
  const result = jest.fn(async () => ({ reference: `${id}-ref`, status: PaymentStatus.CAPTURED }));
  return {
    id,
    label: id,
    actionTypes: ['none'],
    secretFields: [],
    configSchema: z.object({ secret: z.string() }),
    createSession: jest.fn(async () => ({
      reference: `${id}-ref`,
      status: PaymentStatus.PENDING,
      action: { type: 'none' as const },
    })),
    authorize: result,
    capture: result,
    refund: result,
    cancel: result,
    getStatus: result,
    parseWebhook: jest.fn(async () => ({
      eventId: 'evt_1',
      reference: `${id}-ref`,
      status: PaymentStatus.CAPTURED,
    })),
  } as unknown as FakeProvider;
}

const KEY = Buffer.alloc(32, 9).toString('base64');
const crypto = new PaymentConfigCrypto(new ConfigService({ PAYMENT_CONFIG_ENCRYPTION_KEY: KEY }));

describe('PaymentGatewayService', () => {
  let provider: ReturnType<typeof fakeProvider>;
  let findFirst: jest.Mock;
  let findMany: jest.Mock;
  let gateway: PaymentGatewayService;

  beforeEach(() => {
    provider = fakeProvider('fake');
    findFirst = jest.fn().mockResolvedValue({ provider: 'fake', config: { secret: 's3' } });
    findMany = jest
      .fn()
      .mockResolvedValue([{ code: 'fake-card', provider: 'fake', config: { secret: 's3' } }]);
    const prisma = { paymentMethod: { findFirst, findMany } };
    gateway = new PaymentGatewayService(
      prisma as never,
      new PaymentProviderRegistry([provider as PaymentProvider]),
      crypto,
    );
  });

  it('opens a session on the provider behind the method code with its parsed config', async () => {
    const amount = new Prisma.Decimal('12.500');

    const result = await gateway.openSession('fake-card', {
      orderId: 'order-1',
      amount,
      currencyCode: 'KWD',
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: { code: 'fake-card', deletedAt: null },
      select: { provider: true, config: true },
    });
    expect(provider.createSession).toHaveBeenCalledWith({
      orderId: 'order-1',
      amount,
      currencyCode: 'KWD',
      config: { secret: 's3' },
    });
    expect(result).toEqual({
      reference: 'fake-ref',
      status: PaymentStatus.PENDING,
      action: { type: 'none' },
    });
  });

  it('refuses a config that fails the provider schema', async () => {
    findFirst.mockResolvedValue({ provider: 'fake', config: {} });

    await expect(
      gateway.openSession('fake-card', {
        orderId: 'order-1',
        amount: new Prisma.Decimal(1),
        currencyCode: 'KWD',
      }),
    ).rejects.toThrow();
    expect(provider.createSession).not.toHaveBeenCalled();
  });

  it('throws a stable code when the method code has no row', async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      gateway.capture('gone', {
        reference: 'r',
        status: PaymentStatus.PENDING,
        amount: new Prisma.Decimal(1),
        currencyCode: 'KWD',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(PaymentProviderUnknownException);
  });

  it('runs capture, refund, authorize and cancel with the config attached', async () => {
    const amount = new Prisma.Decimal(5);
    const op = { reference: 'fake-ref', status: PaymentStatus.PENDING };
    const mutation = { ...op, idempotencyKey: 'op-key' };
    const currencyCode = 'KWD';

    await gateway.capture('fake-card', { ...mutation, amount, currencyCode });
    await gateway.refund('fake-card', {
      ...mutation,
      amount,
      currencyCode,
      refundableAmount: amount,
    });
    await gateway.authorize('fake-card', op);
    await gateway.cancel('fake-card', mutation);

    expect(provider.capture).toHaveBeenCalledWith({
      ...mutation,
      amount,
      currencyCode,
      config: { secret: 's3' },
    });
    expect(provider.refund).toHaveBeenCalledWith({
      ...mutation,
      amount,
      currencyCode,
      refundableAmount: amount,
      config: { secret: 's3' },
    });
    expect(provider.authorize).toHaveBeenCalledWith({ ...op, config: { secret: 's3' } });
    expect(provider.cancel).toHaveBeenCalledWith({ ...mutation, config: { secret: 's3' } });
  });

  it('reads the live status from the provider with the config attached', async () => {
    const op = { reference: 'fake-ref', status: PaymentStatus.PENDING };

    const result = await gateway.getStatus('fake-card', op);

    expect(provider.getStatus).toHaveBeenCalledWith({ ...op, config: { secret: 's3' } });
    expect(result).toEqual(await provider.getStatus.mock.results[0].value);
  });

  it('resolves soft-deleted methods for operations on existing orders', async () => {
    const op = { reference: 'fake-ref', status: PaymentStatus.PENDING };
    const amount = new Prisma.Decimal(5);
    const anyRow = {
      where: { code: 'fake-card', deletedAt: undefined },
      select: { provider: true, config: true },
    };

    const mutation = { ...op, idempotencyKey: 'op-key' };
    const currencyCode = 'KWD';

    await gateway.capture('fake-card', { ...mutation, amount, currencyCode });
    await gateway.refund('fake-card', {
      ...mutation,
      amount,
      currencyCode,
      refundableAmount: amount,
    });
    await gateway.authorize('fake-card', op);
    await gateway.cancel('fake-card', mutation);
    await gateway.providerIdFor('fake-card');

    expect(findFirst).toHaveBeenCalledTimes(5);
    for (const call of findFirst.mock.calls) {
      expect(call[0]).toEqual(anyRow);
      expect(Object.prototype.hasOwnProperty.call(call[0].where, 'deletedAt')).toBe(true);
    }
  });

  it('reports the provider id behind a method code', async () => {
    await expect(gateway.providerIdFor('fake-card')).resolves.toBe('fake');
  });

  it('says a method collects payment online only when its provider has a shopper step', async () => {
    await expect(gateway.collectsPaymentOnline('fake-card')).resolves.toBe(false);

    provider.actionTypes = ['redirect'];
    await expect(gateway.collectsPaymentOnline('fake-card')).resolves.toBe(true);

    provider.actionTypes = ['none', 'embedded'];
    await expect(gateway.collectsPaymentOnline('fake-card')).resolves.toBe(true);
  });

  it('parses a webhook with the config of a method for that provider', async () => {
    const rawBody = Buffer.from('{}');
    const headers = { 'x-signature': 'sig' };

    const { event, methodCodes } = await gateway.parseWebhook('fake', headers, rawBody);

    // Inactive and soft-deleted methods still verify: their open orders keep receiving events.
    expect(findMany).toHaveBeenCalledWith({
      where: { provider: 'fake', deletedAt: undefined },
      select: { code: true, provider: true, config: true },
      orderBy: { sortOrder: 'asc' },
    });
    expect(Object.prototype.hasOwnProperty.call(findMany.mock.calls[0][0].where, 'deletedAt')).toBe(
      true,
    );
    expect(provider.parseWebhook).toHaveBeenCalledWith({
      headers,
      rawBody,
      config: { secret: 's3' },
    });
    expect(event.eventId).toBe('evt_1');
    expect(methodCodes).toEqual(['fake-card']);
  });

  it('tries the next method when the first config does not verify the webhook', async () => {
    findMany.mockResolvedValue([
      { code: 'old-card', provider: 'fake', config: { secret: 'old' } },
      { code: 'new-card', provider: 'fake', config: { secret: 'new' } },
    ]);
    provider.parseWebhook.mockImplementation(async ({ config }) => {
      if (config.secret !== 'new') throw new Error('bad signature');
      return { eventId: 'evt_2', reference: 'fake-ref', status: PaymentStatus.CAPTURED };
    });

    const { event, methodCodes } = await gateway.parseWebhook('fake', {}, Buffer.from('{}'));

    expect(event.eventId).toBe('evt_2');
    expect(methodCodes).toEqual(['new-card']);
    expect(provider.parseWebhook).toHaveBeenCalledTimes(2);
  });

  it('returns every method code whose config verifies the webhook', async () => {
    findMany.mockResolvedValue([
      { code: 'a-card', provider: 'fake', config: { secret: 'shared' } },
      { code: 'b-card', provider: 'fake', config: { secret: 'other' } },
      { code: 'c-card', provider: 'fake', config: { secret: 'shared' } },
    ]);
    provider.parseWebhook.mockImplementation(async ({ config }) => {
      if (config.secret !== 'shared') throw new Error('bad signature');
      return { eventId: 'evt_3', reference: 'fake-ref', status: PaymentStatus.CAPTURED };
    });

    const { event, methodCodes } = await gateway.parseWebhook('fake', {}, Buffer.from('{}'));

    expect(event.eventId).toBe('evt_3');
    expect(methodCodes).toEqual(['a-card', 'c-card']);
  });

  it('throws the last refusal when no method config verifies the webhook', async () => {
    findMany.mockResolvedValue([
      { code: 'a-card', provider: 'fake', config: { secret: 'a' } },
      { code: 'b-card', provider: 'fake', config: { secret: 'b' } },
    ]);
    provider.parseWebhook.mockRejectedValue(new Error('bad signature'));

    await expect(gateway.parseWebhook('fake', {}, Buffer.from('{}'))).rejects.toThrow(
      'bad signature',
    );
    expect(provider.parseWebhook).toHaveBeenCalledTimes(2);
  });

  it('refuses a webhook for a provider that is not registered', async () => {
    await expect(gateway.parseWebhook('nope', {}, Buffer.from(''))).rejects.toBeInstanceOf(
      PaymentProviderUnknownException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('refuses a webhook for a registered provider with no method', async () => {
    findMany.mockResolvedValue([]);

    await expect(gateway.parseWebhook('fake', {}, Buffer.from(''))).rejects.toBeInstanceOf(
      PaymentProviderUnknownException,
    );
    expect(provider.parseWebhook).not.toHaveBeenCalled();
  });

  it('decrypts the secret fields before the provider sees the config', async () => {
    provider.secretFields = ['secret'];
    const stored = crypto.encrypt({ secret: 's3' }, ['secret']);
    findFirst.mockResolvedValue({ provider: 'fake', config: stored });

    await gateway.openSession('fake-card', {
      orderId: 'order-1',
      amount: new Prisma.Decimal(1),
      currencyCode: 'KWD',
    });

    expect(provider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ config: { secret: 's3' } }),
    );
  });

  it('decrypts the secret fields for webhook verification', async () => {
    provider.secretFields = ['secret'];
    findMany.mockResolvedValue([
      { code: 'fake-card', provider: 'fake', config: crypto.encrypt({ secret: 's3' }, ['secret']) },
    ]);

    await gateway.parseWebhook('fake', {}, Buffer.from('{}'));

    expect(provider.parseWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ config: { secret: 's3' } }),
    );
  });
});

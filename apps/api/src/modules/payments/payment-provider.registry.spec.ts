import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PaymentStatus } from '@prisma/client';
import { z } from 'zod';
import { PAYMENT_PROVIDER_IDS } from './dto/create-payment-method.dto';
import { STOREFRONT_PAYMENT_PROVIDERS } from './payment-methods.service';
import { PAYMENT_PROVIDERS } from './payments.constants';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PaymentProviderUnknownException } from './payment-provider-unknown.exception';
import {
  PAYMENT_PROVIDER_IMPLEMENTATIONS,
  REGISTERED_PAYMENT_PROVIDER_IDS,
} from './payment-providers';
import { PaymentsModule } from './payments.module';
import type { PaymentProvider } from './providers/payment-provider.interface';

function fakeProvider(id: string): PaymentProvider {
  const result = async () => ({ reference: `${id}-ref`, status: PaymentStatus.PENDING });
  return {
    id,
    label: id,
    actionTypes: ['none'],
    secretFields: [],
    configSchema: z.object({}),
    createSession: async () => ({ ...(await result()), action: { type: 'none' } }),
    authorize: result,
    capture: result,
    refund: result,
    cancel: result,
    getStatus: result,
    parseWebhook: async () => {
      throw new Error('no webhooks');
    },
  };
}

describe('PaymentProviderRegistry', () => {
  it('resolves a provider by id', () => {
    const cod = fakeProvider('cod');
    const registry = new PaymentProviderRegistry([cod, fakeProvider('manual')]);

    expect(registry.get('cod')).toBe(cod);
    expect(registry.has('cod')).toBe(true);
    expect(registry.has('stripe')).toBe(false);
  });

  it('lists ids and providers in registration order', () => {
    const registry = new PaymentProviderRegistry([fakeProvider('manual'), fakeProvider('cod')]);

    expect(registry.ids()).toEqual(['manual', 'cod']);
    expect(registry.list().map((p) => p.id)).toEqual(['manual', 'cod']);
  });

  it('throws a stable code for an unknown id', () => {
    const registry = new PaymentProviderRegistry([fakeProvider('cod')]);

    expect(() => registry.get('stripe')).toThrow(PaymentProviderUnknownException);
    try {
      registry.get('stripe');
    } catch (err) {
      expect((err as PaymentProviderUnknownException).getResponse()).toEqual({
        error: {
          code: 'PAYMENT_PROVIDER_UNKNOWN',
          message: expect.any(String),
          details: { providerId: 'stripe' },
        },
      });
    }
  });

  it('refuses two providers with the same id', () => {
    expect(() => new PaymentProviderRegistry([fakeProvider('cod'), fakeProvider('cod')])).toThrow(
      /duplicate payment provider id "cod"/i,
    );
  });

  it('refuses an id that is not lower snake case', () => {
    expect(() => new PaymentProviderRegistry([fakeProvider('Cash On Delivery')])).toThrow(
      /invalid payment provider id/i,
    );
  });
});

describe('payment provider module array', () => {
  it('registers cod, manual and the stripe example', () => {
    expect(REGISTERED_PAYMENT_PROVIDER_IDS).toEqual(['cod', 'manual', 'stripe']);
    expect(PAYMENT_PROVIDER_IMPLEMENTATIONS.map((p) => p.providerId)).toEqual(
      REGISTERED_PAYMENT_PROVIDER_IDS,
    );
  });

  it('builds the registry from the module array through the injection token', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: ConfigService, useValue: new ConfigService({}) },
        ...PAYMENT_PROVIDER_IMPLEMENTATIONS,
        {
          provide: PAYMENT_PROVIDERS,
          useFactory: (...providers: PaymentProvider[]) => providers,
          inject: [...PAYMENT_PROVIDER_IMPLEMENTATIONS],
        },
        PaymentProviderRegistry,
      ],
    }).compile();

    const registry = moduleRef.get(PaymentProviderRegistry);
    expect(registry.ids()).toEqual(['cod', 'manual', 'stripe']);
    expect(registry.get('cod').id).toBe('cod');
  });

  it('exports the registry from PaymentsModule', () => {
    const exported = Reflect.getMetadata('exports', PaymentsModule) as unknown[];
    expect(exported).toContain(PaymentProviderRegistry);
  });

  it('lets the admin DTO accept every registered provider', () => {
    for (const id of REGISTERED_PAYMENT_PROVIDER_IDS) {
      expect(PAYMENT_PROVIDER_IDS).toContain(id);
    }
  });

  it('keeps the admin DTO accepting the gateways that have no provider yet', () => {
    expect(PAYMENT_PROVIDER_IDS).toEqual(expect.arrayContaining(['paypal', 'gift_card']));
    expect(new Set(PAYMENT_PROVIDER_IDS).size).toBe(PAYMENT_PROVIDER_IDS.length);
  });

  it('offers the storefront every registered provider that declares itself checkout-ready', () => {
    expect(STOREFRONT_PAYMENT_PROVIDERS).toEqual(['cod', 'manual', 'stripe']);
    for (const id of STOREFRONT_PAYMENT_PROVIDERS) {
      expect(REGISTERED_PAYMENT_PROVIDER_IDS).toContain(id);
    }
  });
});

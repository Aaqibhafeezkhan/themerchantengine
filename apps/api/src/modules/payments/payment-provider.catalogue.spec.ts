import { PaymentStatus } from '@prisma/client';
import { z } from 'zod';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PAYMENT_PROVIDER_IMPLEMENTATIONS } from './payment-providers';
import type { PaymentProvider } from './providers/payment-provider.interface';

const canaryConfigSchema = z.object({
  merchantId: z.string().min(1),
  merchantPassword: z.string().min(1),
  mode: z.enum(['live', 'sandbox']).default('sandbox'),
});

// A provider the engine has never heard of, with a secret field name no list knows.
function canaryProvider(): PaymentProvider {
  const result = async () => ({ reference: 'canary-ref', status: PaymentStatus.PENDING });
  return {
    id: 'canary_pay',
    label: 'Canary Pay',
    actionTypes: ['redirect'],
    secretFields: ['merchantPassword'],
    configSchema: canaryConfigSchema,
    createSession: async () => ({
      reference: 'canary-ref',
      status: PaymentStatus.PENDING,
      action: { type: 'redirect', url: 'https://canary.example/pay' },
    }),
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

describe('PaymentProviderRegistry catalogue', () => {
  it('lists a provider nobody wired by hand, with its schema and secret flags', () => {
    const registry = new PaymentProviderRegistry([canaryProvider()]);

    const [entry] = registry.catalogue();

    expect(entry).toMatchObject({
      id: 'canary_pay',
      label: 'Canary Pay',
      actionTypes: ['redirect'],
      secretFields: ['merchantPassword'],
    });
    expect(entry.configJsonSchema).toMatchObject({
      type: 'object',
      properties: {
        merchantId: { type: 'string' },
        merchantPassword: { type: 'string' },
        mode: { enum: ['live', 'sandbox'] },
      },
    });
  });

  it('rejects a secret field the config schema does not declare', () => {
    const provider = { ...canaryProvider(), secretFields: ['merchantPasswrod'] };

    expect(() => new PaymentProviderRegistry([provider])).toThrow(/merchantPasswrod/);
  });

  it('rejects a provider that supports no action type', () => {
    const provider = { ...canaryProvider(), actionTypes: [] };

    expect(() => new PaymentProviderRegistry([provider])).toThrow(/action type/);
  });

  describe('every shipped provider', () => {
    const registry = new PaymentProviderRegistry(
      PAYMENT_PROVIDER_IMPLEMENTATIONS.map(
        (Provider) =>
          new (Provider as unknown as new (config: { get: () => undefined }) => PaymentProvider)({
            get: () => undefined,
          }),
      ),
    );

    it.each(registry.catalogue().map((entry) => [entry.id, entry] as const))(
      '%s declares a label and an action type',
      (_id, entry) => {
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.actionTypes.length).toBeGreaterThan(0);
      },
    );
  });
});

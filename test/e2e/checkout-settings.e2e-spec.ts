/**
 * Public checkout bootstrap surface (plan F phase F1, findings K3, D1, D3).
 *
 * The whole `checkout` StoreSetting group and the whole payment-methods module
 * used to be admin-gated, so an operator toggling guest checkout or enabling a
 * tender changed nothing a customer could ever see. This spec pins the two
 * things a unit test cannot reach: that the route really is anonymous, and
 * that the secrets-bearing `PaymentMethod.config` blob does not cross the wire.
 *
 * Real dockerized DB per constitution §3.8. Every method row it needs is
 * created here and removed in teardown, so the spec does not depend on a seed
 * that plants no payment method today.
 */
import { PrismaClient } from '@prisma/client';
import { api, createTestPrisma, STORE_DEFAULT_LOCALE, STORE_SECONDARY_LOCALE } from './helpers';

interface StorefrontMethod {
  code: string;
  name: unknown;
  description: unknown;
  provider: string;
  sortOrder: number;
}

interface SettingsPayload {
  checkout: {
    guestCheckoutEnabled: boolean;
    requiredFields: string[];
    termsOfServiceUrl: string | null;
    postPurchaseRedirectUrl: string | null;
    checkoutMessage: string | null;
  };
  paymentMethods: StorefrontMethod[];
}

const CODES = {
  active: 'e2e_f1_cod',
  inactive: 'e2e_f1_cod_off',
  deleted: 'e2e_f1_cod_gone',
  gateway: 'e2e_f1_stripe',
} as const;

const LEAKED_KEY = 'sk_live_e2e_f1_must_never_appear'; // gitleaks:allow

describe('GET /v1/checkout/settings', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.paymentMethod.deleteMany({ where: { code: { in: Object.values(CODES) } } });
    await prisma.paymentMethod.createMany({
      data: [
        {
          code: CODES.active,
          name: {
            default: 'Cash on delivery',
            [STORE_DEFAULT_LOCALE]: 'Cash on delivery',
            [STORE_SECONDARY_LOCALE]: 'Paiement a la livraison',
          },
          description: {
            default: 'Pay the courier',
            [STORE_DEFAULT_LOCALE]: 'Pay the courier',
            [STORE_SECONDARY_LOCALE]: 'Payez le livreur',
          },
          provider: 'cod',
          isActive: true,
          sortOrder: 5,
          config: { apiKey: LEAKED_KEY },
        },
        {
          code: CODES.inactive,
          name: { default: 'Disabled tender' },
          provider: 'cod',
          isActive: false,
          sortOrder: 6,
        },
        {
          code: CODES.deleted,
          name: { default: 'Retired tender' },
          provider: 'cod',
          isActive: true,
          sortOrder: 7,
          deletedAt: new Date(),
        },
        {
          code: CODES.gateway,
          name: { default: 'Card' },
          provider: 'stripe',
          isActive: true,
          sortOrder: 8,
          config: { apiKey: LEAKED_KEY },
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.paymentMethod.deleteMany({ where: { code: { in: Object.values(CODES) } } });
    await prisma.$disconnect();
  });

  it('answers an anonymous request with the five checkout keys', async () => {
    const res = await api().get('/v1/checkout/settings').expect(200);
    const body = res.body.data as SettingsPayload;
    expect(Object.keys(body.checkout).sort()).toEqual([
      'checkoutMessage',
      'guestCheckoutEnabled',
      'postPurchaseRedirectUrl',
      'requiredFields',
      'termsOfServiceUrl',
    ]);
    expect(typeof body.checkout.guestCheckoutEnabled).toBe('boolean');
  });

  it('offers the active cod and stripe methods and hides the inactive and soft-deleted rows', async () => {
    const res = await api().get('/v1/checkout/settings').expect(200);
    const codes = (res.body.data as SettingsPayload).paymentMethods.map((m) => m.code);
    expect(codes).toContain(CODES.active);
    expect(codes).not.toContain(CODES.inactive);
    expect(codes).not.toContain(CODES.deleted);
    expect(codes).toContain(CODES.gateway);
  });

  it('never puts the provider config blob on the wire', async () => {
    const res = await api().get('/v1/checkout/settings').expect(200);
    const methods = (res.body.data as SettingsPayload).paymentMethods;
    for (const method of methods) {
      expect(Object.keys(method).sort()).toEqual([
        'code',
        'description',
        'name',
        'provider',
        'requiresPayment',
        'sortOrder',
      ]);
    }
    expect(JSON.stringify(res.body)).not.toContain(LEAKED_KEY);
  });

  it('resolves the tender name for the requested locale', async () => {
    const secondary = await api()
      .get('/v1/checkout/settings')
      .set('X-Locale', STORE_SECONDARY_LOCALE)
      .expect(200);
    const dflt = await api()
      .get('/v1/checkout/settings')
      .set('X-Locale', STORE_DEFAULT_LOCALE)
      .expect(200);
    const pick = (body: unknown) =>
      (body as { data: SettingsPayload }).data.paymentMethods.find((m) => m.code === CODES.active);
    expect(pick(secondary.body)?.name).toBe('Paiement a la livraison');
    expect(pick(dflt.body)?.name).toBe('Cash on delivery');
  });

  it('orders the methods by the operator sort order', async () => {
    const res = await api().get('/v1/checkout/settings').expect(200);
    const orders = (res.body.data as SettingsPayload).paymentMethods.map((m) => m.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});

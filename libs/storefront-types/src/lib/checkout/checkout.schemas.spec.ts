import { describe, expect, it } from 'vitest';

import {
  storefrontCheckoutSettingsResponseSchema,
  storefrontCheckoutSettingsSchema,
  storefrontPaymentMethodSchema,
} from './checkout.schemas';

const settings = {
  checkout: {
    guestCheckoutEnabled: true,
    requiredFields: ['email'],
    termsOfServiceUrl: null,
    postPurchaseRedirectUrl: null,
    checkoutMessage: null,
  },
  paymentMethods: [
    {
      code: 'cod',
      name: 'Paiement a la livraison',
      description: null,
      provider: 'cod',
      sortOrder: 0,
    },
  ],
};

describe('storefrontCheckoutSettingsSchema', () => {
  it('parses the live payload shape', () => {
    const parsed = storefrontCheckoutSettingsSchema.parse(settings);
    expect(parsed.checkout.guestCheckoutEnabled).toBe(true);
    expect(parsed.paymentMethods[0].code).toBe('cod');
  });

  it('parses the API envelope', () => {
    const parsed = storefrontCheckoutSettingsResponseSchema.parse({ data: settings });
    expect(parsed.data.checkout.requiredFields).toEqual(['email']);
  });

  it('defaults an absent payment-method list to empty rather than throwing', () => {
    const parsed = storefrontCheckoutSettingsSchema.parse({ checkout: settings.checkout });
    expect(parsed.paymentMethods).toEqual([]);
  });

  it('accepts an empty payment-method list, which is the seeded state today', () => {
    const parsed = storefrontCheckoutSettingsSchema.parse({ ...settings, paymentMethods: [] });
    expect(parsed.paymentMethods).toEqual([]);
  });

  it('reads requiresPayment from the wire and defaults it to false when absent', () => {
    const card = storefrontPaymentMethodSchema.parse({
      code: 'card',
      name: 'Card',
      provider: 'stripe',
      requiresPayment: true,
    });
    expect(card.requiresPayment).toBe(true);
    const cod = storefrontPaymentMethodSchema.parse(settings.paymentMethods[0]);
    expect(cod.requiresPayment).toBe(false);
  });

  it('rejects a checkout group missing the guest flag', () => {
    // Copy-and-delete rather than a destructured throwaway: the binding was
    // unused, and `_`-prefixed names are not exempt from no-unused-vars here.
    const rest: Partial<typeof settings.checkout> = { ...settings.checkout };
    delete rest.guestCheckoutEnabled;
    expect(() => storefrontCheckoutSettingsSchema.parse({ ...settings, checkout: rest })).toThrow();
  });

  it('rejects an unresolved Translatable name, which means the locale header did not travel', () => {
    expect(() =>
      storefrontPaymentMethodSchema.parse({
        code: 'cod',
        name: { default: 'Cash on delivery' },
        provider: 'cod',
        sortOrder: 0,
      }),
    ).toThrow();
  });
});

describe('storefrontPaymentMethodSchema secrets tripwire', () => {
  // `PaymentMethod.config` holds provider API keys. The API projection selects
  // it away twice over, and this is the third guard: if a future widening of
  // that projection ever puts the blob on the wire, checkout fails loudly here
  // instead of rendering a page that shipped a live key to every visitor.
  it('rejects a method carrying a config blob', () => {
    expect(() =>
      storefrontPaymentMethodSchema.parse({
        code: 'cod',
        name: 'Cash on delivery',
        description: null,
        provider: 'cod',
        sortOrder: 0,
        config: { apiKey: 'sk_live_leaked' },
      }),
    ).toThrow(/config/i);
  });

  it('rejects a method carrying isTestMode', () => {
    expect(() =>
      storefrontPaymentMethodSchema.parse({
        code: 'cod',
        name: 'Cash on delivery',
        description: null,
        provider: 'cod',
        sortOrder: 0,
        isTestMode: true,
      }),
    ).toThrow(/isTestMode/i);
  });

  it('rejects the blob when it arrives nested inside the settings payload', () => {
    expect(() =>
      storefrontCheckoutSettingsSchema.parse({
        checkout: settings.checkout,
        paymentMethods: [{ ...settings.paymentMethods[0], config: {} }],
      }),
    ).toThrow(/config/i);
  });
});

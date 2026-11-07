import { PaymentStatus, Prisma } from '@prisma/client';
import {
  assertFakePaymentProvidersAllowed,
  FakeEmbeddedPaymentProvider,
  FakeRedirectPaymentProvider,
  FAKE_DECLINE_CARD,
  fakePaymentProvidersEnabled,
  resolvePaymentProviderImplementations,
} from './fake-payment.provider';
import { CodPaymentProvider } from './cod-payment.provider';

const base = { orderId: 'order-1', amount: new Prisma.Decimal('10.00'), currencyCode: 'USD' };

describe('FakePaymentProviders (test doubles for e2e)', () => {
  describe('fake_embedded', () => {
    const provider = new FakeEmbeddedPaymentProvider();

    it('returns an embedded action that names the fake component', async () => {
      const result = await provider.createSession({ ...base, config: {} });
      expect(result.status).toBe(PaymentStatus.PENDING);
      expect(result.reference).toBe('fake_embedded_order-1');
      expect(result.action).toEqual({
        type: 'embedded',
        clientToken: 'fake_secret_order-1',
        publicConfig: { provider: 'fake', declineCard: FAKE_DECLINE_CARD },
      });
    });

    it('reports the payment as captured once the shopper has returned', async () => {
      const live = await provider.getStatus({
        reference: 'fake_embedded_order-1',
        status: PaymentStatus.PENDING,
        config: {},
      });
      expect(live.status).toBe(PaymentStatus.CAPTURED);
    });
  });

  describe('fake_redirect', () => {
    const provider = new FakeRedirectPaymentProvider();

    it('sends the shopper straight back to the return url', async () => {
      const result = await provider.createSession({
        ...base,
        returnUrl: 'https://shop.test/en/order-confirmation/ORD-1',
        config: {},
      });
      expect(result.action).toEqual({
        type: 'redirect',
        url: 'https://shop.test/en/order-confirmation/ORD-1',
      });
      expect(result.reference).toBe('fake_redirect_order-1');
    });

    it('rejects a session without a return url', async () => {
      await expect(provider.createSession({ ...base, config: {} })).rejects.toThrow();
    });
  });

  describe('production refusal', () => {
    it('is off unless the flag is exactly true', () => {
      expect(fakePaymentProvidersEnabled({})).toBe(false);
      expect(fakePaymentProvidersEnabled({ PAYMENT_FAKE_PROVIDERS: 'false' })).toBe(false);
      expect(fakePaymentProvidersEnabled({ PAYMENT_FAKE_PROVIDERS: 'true' })).toBe(true);
    });

    it('refuses to boot with the flag when NODE_ENV is production', () => {
      expect(() =>
        assertFakePaymentProvidersAllowed({
          PAYMENT_FAKE_PROVIDERS: 'true',
          NODE_ENV: 'production',
        }),
      ).toThrow(/PAYMENT_FAKE_PROVIDERS/);
    });

    it('treats an unset or unknown NODE_ENV as production', () => {
      expect(() => assertFakePaymentProvidersAllowed({ PAYMENT_FAKE_PROVIDERS: 'true' })).toThrow(
        /PAYMENT_FAKE_PROVIDERS/,
      );
      expect(() =>
        assertFakePaymentProvidersAllowed({ PAYMENT_FAKE_PROVIDERS: 'true', NODE_ENV: 'prod' }),
      ).toThrow(/PAYMENT_FAKE_PROVIDERS/);
    });

    it('allows the flag outside production and production without the flag', () => {
      expect(() =>
        assertFakePaymentProvidersAllowed({ PAYMENT_FAKE_PROVIDERS: 'true', NODE_ENV: 'test' }),
      ).not.toThrow();
      expect(() => assertFakePaymentProvidersAllowed({ NODE_ENV: 'production' })).not.toThrow();
    });

    it('registers the fakes only when enabled, and throws in production', () => {
      const real = [CodPaymentProvider];
      expect(resolvePaymentProviderImplementations(real, {})).toEqual(real);
      expect(
        resolvePaymentProviderImplementations(real, {
          PAYMENT_FAKE_PROVIDERS: 'true',
          NODE_ENV: 'test',
        }).map((p) => p.providerId),
      ).toEqual(['cod', 'fake_embedded', 'fake_redirect']);
      expect(() =>
        resolvePaymentProviderImplementations(real, {
          PAYMENT_FAKE_PROVIDERS: 'true',
          NODE_ENV: 'production',
        }),
      ).toThrow(/PAYMENT_FAKE_PROVIDERS/);
    });
  });
});

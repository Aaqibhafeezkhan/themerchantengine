import { CodPaymentProvider } from './providers/cod-payment.provider';
import { resolvePaymentProviderImplementations } from './providers/fake-payment.provider';
import type { FAKE_PAYMENT_PROVIDER_IMPLEMENTATIONS } from './providers/fake-payment.provider';
import { ManualPaymentProvider } from './providers/manual-payment.provider';
import { StripePaymentProvider } from './providers/stripe-payment.provider';

const REAL_PAYMENT_PROVIDER_IMPLEMENTATIONS = [
  CodPaymentProvider,
  ManualPaymentProvider,
  StripePaymentProvider,
] as const;

/**
 * The one list of payment providers the engine runs. Add a provider to the
 * real list to register it. The e2e fakes join only when PAYMENT_FAKE_PROVIDERS
 * is true, and boot fails if that flag is set in production.
 */
export const PAYMENT_PROVIDER_IMPLEMENTATIONS = resolvePaymentProviderImplementations(
  REAL_PAYMENT_PROVIDER_IMPLEMENTATIONS,
);

export type RegisteredPaymentProviderId = (
  | (typeof REAL_PAYMENT_PROVIDER_IMPLEMENTATIONS)[number]
  | (typeof FAKE_PAYMENT_PROVIDER_IMPLEMENTATIONS)[number]
)['providerId'];

export const REGISTERED_PAYMENT_PROVIDER_IDS: readonly RegisteredPaymentProviderId[] =
  PAYMENT_PROVIDER_IMPLEMENTATIONS.map((provider) => provider.providerId);

/** The registered providers the storefront checkout may offer. */
export const CHECKOUT_PAYMENT_PROVIDER_IDS: readonly RegisteredPaymentProviderId[] =
  PAYMENT_PROVIDER_IMPLEMENTATIONS.filter((provider) => provider.offeredAtCheckout).map(
    (provider) => provider.providerId,
  );

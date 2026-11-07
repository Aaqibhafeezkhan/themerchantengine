import { isProduction } from '@common/env';
import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PaymentProviderRejectedException } from '../payment-provider-rejected.exception';
import { OfflinePaymentProvider } from './offline-payment.provider';
import type {
  PaymentOperationInput,
  PaymentProviderResult,
  PaymentSessionInput,
  PaymentSessionResult,
} from './payment-provider.interface';

/** The card number the fake storefront component refuses, like a real declined card. */
export const FAKE_DECLINE_CARD = '4000000000000002';

const FAKE_PROVIDERS_FLAG = 'PAYMENT_FAKE_PROVIDERS';

type Env = Readonly<Record<string, string | undefined>>;

export function fakePaymentProvidersEnabled(env: Env = process.env): boolean {
  return env[FAKE_PROVIDERS_FLAG] === 'true';
}

/** The fakes move no money and need no card, so a live deployment must never run them. */
export function assertFakePaymentProvidersAllowed(env: Env = process.env): void {
  if (fakePaymentProvidersEnabled(env) && isProduction(env)) {
    throw new Error(
      `${FAKE_PROVIDERS_FLAG}=true is not allowed when NODE_ENV=production. ` +
        'The fake payment providers are test doubles for the e2e suites only.',
    );
  }
}

/**
 * Test doubles for the e2e suites. They run the real checkout, orders and
 * storefront paths without a payment network. The shopper "pays" by reaching
 * the return url, so the provider reports CAPTURED when asked for the status.
 */
abstract class FakeOnlinePaymentProvider extends OfflinePaymentProvider {
  static override readonly offeredAtCheckout = true;
  protected abstract action(
    input: PaymentSessionInput<Record<string, never>>,
  ): PaymentSessionResult['action'];

  override async createSession(
    input: PaymentSessionInput<Record<string, never>>,
  ): Promise<PaymentSessionResult> {
    return {
      reference: `${this.id}_${input.orderId}`,
      status: PaymentStatus.PENDING,
      action: this.action(input),
    };
  }

  override async getStatus(
    input: PaymentOperationInput<Record<string, never>>,
  ): Promise<PaymentProviderResult> {
    const settled =
      input.status === PaymentStatus.PENDING || input.status === PaymentStatus.AUTHORIZED;
    return { reference: input.reference, status: settled ? PaymentStatus.CAPTURED : input.status };
  }
}

@Injectable()
export class FakeEmbeddedPaymentProvider extends FakeOnlinePaymentProvider {
  static readonly providerId = 'fake_embedded' as const;
  readonly id = FakeEmbeddedPaymentProvider.providerId;
  readonly label = 'Fake embedded card (test only)';
  override readonly actionTypes = ['embedded'] as const;

  protected action(input: PaymentSessionInput<Record<string, never>>) {
    return {
      type: 'embedded' as const,
      clientToken: `fake_secret_${input.orderId}`,
      publicConfig: { provider: 'fake', declineCard: FAKE_DECLINE_CARD },
    };
  }
}

@Injectable()
export class FakeRedirectPaymentProvider extends FakeOnlinePaymentProvider {
  static readonly providerId = 'fake_redirect' as const;
  readonly id = FakeRedirectPaymentProvider.providerId;
  readonly label = 'Fake redirect (test only)';
  override readonly actionTypes = ['redirect'] as const;

  protected action(input: PaymentSessionInput<Record<string, never>>) {
    if (!input.returnUrl) throw new PaymentProviderRejectedException(this.id, 'missing_return_url');
    return { type: 'redirect' as const, url: input.returnUrl };
  }
}

export const FAKE_PAYMENT_PROVIDER_IMPLEMENTATIONS = [
  FakeEmbeddedPaymentProvider,
  FakeRedirectPaymentProvider,
] as const;

/** The real list, plus the fakes when the flag is on. Throws in production with the flag. */
export function resolvePaymentProviderImplementations<T extends { providerId: string }>(
  real: readonly T[],
  env: Env = process.env,
): readonly (T | (typeof FAKE_PAYMENT_PROVIDER_IMPLEMENTATIONS)[number])[] {
  assertFakePaymentProvidersAllowed(env);
  return fakePaymentProvidersEnabled(env)
    ? [...real, ...FAKE_PAYMENT_PROVIDER_IMPLEMENTATIONS]
    : real;
}

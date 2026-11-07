import { PaymentStatus } from '@prisma/client';
import { z } from 'zod';
import { PaymentTransitionNotAllowedException } from '../payment-transition-not-allowed.exception';
import { PaymentWebhookUnsupportedException } from '../payment-webhook-unsupported.exception';
import type {
  PaymentActionType,
  PaymentCaptureInput,
  PaymentMutationInput,
  PaymentOperationInput,
  PaymentProvider,
  PaymentProviderResult,
  PaymentRefundInput,
  PaymentSessionInput,
  PaymentSessionResult,
  PaymentWebhookEvent,
} from './payment-provider.interface';

const offlineConfigSchema = z.object({});
type OfflineConfig = z.infer<typeof offlineConfigSchema>;

/**
 * Base for providers where the money moves outside the engine (cash on
 * delivery, bank transfer). Nothing is held before the money arrives, so the
 * payment goes from PENDING straight to CAPTURED when the operator confirms
 * it, and there is no remote state to poll or webhook to accept.
 */
export abstract class OfflinePaymentProvider implements PaymentProvider<OfflineConfig> {
  /** The order needs no payment step at checkout, so the storefront may offer it. */
  static readonly offeredAtCheckout = true;
  abstract readonly id: string;
  abstract readonly label: string;
  readonly actionTypes: readonly PaymentActionType[] = ['none'];
  readonly secretFields = [] as const;
  readonly configSchema = offlineConfigSchema;

  async createSession(input: PaymentSessionInput<OfflineConfig>): Promise<PaymentSessionResult> {
    return {
      reference: `${this.id}_${input.orderId}`,
      status: PaymentStatus.PENDING,
      action: { type: 'none' },
    };
  }

  async authorize(input: PaymentOperationInput<OfflineConfig>): Promise<PaymentProviderResult> {
    throw new PaymentTransitionNotAllowedException(this.id, input.status, 'authorize');
  }

  async capture(input: PaymentCaptureInput<OfflineConfig>): Promise<PaymentProviderResult> {
    this.assertFrom(input, 'capture', [PaymentStatus.PENDING]);
    return { reference: input.reference, status: PaymentStatus.CAPTURED };
  }

  async cancel(input: PaymentMutationInput<OfflineConfig>): Promise<PaymentProviderResult> {
    this.assertFrom(input, 'cancel', [PaymentStatus.PENDING]);
    return { reference: input.reference, status: PaymentStatus.CANCELLED };
  }

  async refund(input: PaymentRefundInput<OfflineConfig>): Promise<PaymentProviderResult> {
    this.assertFrom(input, 'refund', [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED]);
    if (input.amount.lte(0) || input.amount.gt(input.refundableAmount)) {
      throw new PaymentTransitionNotAllowedException(this.id, input.status, 'refund');
    }
    const status = input.amount.gte(input.refundableAmount)
      ? PaymentStatus.REFUNDED
      : PaymentStatus.PARTIALLY_REFUNDED;
    return { reference: input.reference, status };
  }

  async getStatus(input: PaymentOperationInput<OfflineConfig>): Promise<PaymentProviderResult> {
    return { reference: input.reference, status: input.status };
  }

  async parseWebhook(): Promise<PaymentWebhookEvent> {
    throw new PaymentWebhookUnsupportedException(this.id);
  }

  private assertFrom(
    input: PaymentOperationInput<OfflineConfig>,
    action: string,
    allowed: PaymentStatus[],
  ): void {
    if (!allowed.includes(input.status)) {
      throw new PaymentTransitionNotAllowedException(this.id, input.status, action);
    }
  }
}

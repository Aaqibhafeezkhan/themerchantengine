import { Injectable } from '@nestjs/common';
import { OfflinePaymentProvider } from './offline-payment.provider';

/** Manual payment (bank transfer and similar): the operator marks it captured once the money arrives. */
@Injectable()
export class ManualPaymentProvider extends OfflinePaymentProvider {
  static readonly providerId = 'manual' as const;
  readonly id = ManualPaymentProvider.providerId;
  readonly label = 'Manual payment';
}

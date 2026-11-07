import { Injectable } from '@nestjs/common';
import { OfflinePaymentProvider } from './offline-payment.provider';

/** Cash on delivery: the order is confirmed and the payment stays PENDING until the cash is collected. */
@Injectable()
export class CodPaymentProvider extends OfflinePaymentProvider {
  static readonly providerId = 'cod' as const;
  readonly id = CodPaymentProvider.providerId;
  readonly label = 'Cash on delivery';
}

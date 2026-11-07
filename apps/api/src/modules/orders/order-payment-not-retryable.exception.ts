import { ConflictException } from '@nestjs/common';

/**
 * The order cannot take a new payment attempt: it is paid, cancelled, refunded,
 * or it never chose a payment method.
 */
export class OrderPaymentNotRetryableException extends ConflictException {
  static readonly CODE = 'ORDER_PAYMENT_NOT_RETRYABLE' as const;

  constructor(orderId: string) {
    super({
      error: {
        code: OrderPaymentNotRetryableException.CODE,
        message: `Order ${orderId} cannot take a new payment attempt`,
      },
    });
  }
}

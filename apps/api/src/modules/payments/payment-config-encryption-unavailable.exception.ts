import { ServiceUnavailableException } from '@nestjs/common';

/** A payment secret cannot be saved or read: no usable encryption key, or the stored value is damaged. */
export class PaymentConfigEncryptionUnavailableException extends ServiceUnavailableException {
  static readonly CODE = 'PAYMENT_CONFIG_ENCRYPTION_UNAVAILABLE' as const;

  constructor() {
    super({
      error: {
        code: PaymentConfigEncryptionUnavailableException.CODE,
        message: 'Payment secrets cannot be stored until an encryption key is configured',
      },
    });
  }
}

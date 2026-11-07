/**
 * A verified webhook whose event type the provider does not act on. Not an
 * HTTP error: the sender must get a 2xx or it retries the event for days.
 */
export class PaymentWebhookIgnoredException extends Error {
  constructor(
    readonly providerId: string,
    readonly eventType: string,
  ) {
    super(`Payment webhook event ${eventType} is not handled by ${providerId}`);
    this.name = 'PaymentWebhookIgnoredException';
  }
}

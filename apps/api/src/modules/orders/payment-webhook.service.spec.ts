import { Test } from '@nestjs/testing';
import { PaymentStatus } from '@prisma/client';
import { PaymentGatewayService } from '../payments/payment-gateway.service';
import { PaymentWebhookIgnoredException } from '../payments/payment-webhook-ignored.exception';
import { PaymentWebhookUnsupportedException } from '../payments/payment-webhook-unsupported.exception';
import { ProcessedWebhookService } from '../webhooks/processed-webhook.service';
import { OrdersService } from './orders.service';
import { PaymentWebhookService } from './payment-webhook.service';

describe('PaymentWebhookService', () => {
  const headers = { 'x-signature': 'sig' };
  const rawBody = Buffer.from('{"id":"evt-1"}');
  const event = { reference: 'cod_order-1', status: PaymentStatus.CAPTURED, eventId: 'evt-1' };

  let service: PaymentWebhookService;
  let gateway: { parseWebhook: jest.Mock };
  let processed: { isProcessed: jest.Mock; recordInboundEvent: jest.Mock };
  let orders: { applyPaymentWebhookEvent: jest.Mock };

  beforeEach(async () => {
    gateway = { parseWebhook: jest.fn().mockResolvedValue({ event, methodCodes: ['cod'] }) };
    processed = {
      isProcessed: jest.fn().mockResolvedValue(false),
      recordInboundEvent: jest
        .fn()
        .mockResolvedValue({ alreadyProcessed: false, processedAt: new Date() }),
    };
    orders = { applyPaymentWebhookEvent: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PaymentWebhookService,
        { provide: PaymentGatewayService, useValue: gateway },
        { provide: ProcessedWebhookService, useValue: processed },
        { provide: OrdersService, useValue: orders },
      ],
    }).compile();
    service = module.get(PaymentWebhookService);
  });

  it('verifies the event, applies it through OrdersService, then records it', async () => {
    const result = await service.process('cod', headers, rawBody);

    expect(result).toEqual({ ok: true, replay: false });
    expect(gateway.parseWebhook).toHaveBeenCalledWith('cod', headers, rawBody);
    expect(orders.applyPaymentWebhookEvent).toHaveBeenCalledWith('cod', event, ['cod']);
    expect(processed.recordInboundEvent).toHaveBeenCalledWith('payments:cod', 'evt-1', {
      reference: 'cod_order-1',
      status: PaymentStatus.CAPTURED,
    });
    expect(orders.applyPaymentWebhookEvent.mock.invocationCallOrder[0]).toBeLessThan(
      processed.recordInboundEvent.mock.invocationCallOrder[0],
    );
  });

  it('replays a recorded event without touching the order', async () => {
    processed.isProcessed.mockResolvedValueOnce(true);

    const result = await service.process('cod', headers, rawBody);

    expect(result).toEqual({ ok: true, replay: true });
    expect(processed.isProcessed).toHaveBeenCalledWith('payments:cod', 'evt-1');
    expect(orders.applyPaymentWebhookEvent).not.toHaveBeenCalled();
    expect(processed.recordInboundEvent).not.toHaveBeenCalled();
  });

  it('leaves a failed apply unrecorded so the provider retry runs it again', async () => {
    orders.applyPaymentWebhookEvent.mockRejectedValueOnce(new Error('db down'));

    await expect(service.process('cod', headers, rawBody)).rejects.toThrow('db down');
    expect(processed.recordInboundEvent).not.toHaveBeenCalled();
  });

  it('rejects an unverified event before any dedup or write', async () => {
    gateway.parseWebhook.mockRejectedValueOnce(new PaymentWebhookUnsupportedException('cod'));

    await expect(service.process('cod', headers, rawBody)).rejects.toBeInstanceOf(
      PaymentWebhookUnsupportedException,
    );
    expect(processed.isProcessed).not.toHaveBeenCalled();
    expect(orders.applyPaymentWebhookEvent).not.toHaveBeenCalled();
  });

  it('acknowledges a verified event the provider does not act on, without a write', async () => {
    gateway.parseWebhook.mockRejectedValueOnce(
      new PaymentWebhookIgnoredException('stripe', 'checkout.session.completed'),
    );

    await expect(service.process('stripe', headers, rawBody)).resolves.toEqual({
      ok: true,
      replay: false,
    });
    expect(processed.isProcessed).not.toHaveBeenCalled();
    expect(orders.applyPaymentWebhookEvent).not.toHaveBeenCalled();
  });
});

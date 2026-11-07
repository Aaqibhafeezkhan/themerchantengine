import { Inject, Injectable } from '@angular/core';
import {
  apiResponseSchema,
  createOrderRequestSchema,
  invoiceResponseSchema,
  listOrdersQuerySchema,
  orderSchema,
  paginationMetaSchema,
  paymentActionSchema,
  placedOrderSchema,
  trackOrderRequestSchema,
  trackingResponseSchema,
  type CreateOrderRequest,
  type ListOrdersQuery,
  type Order,
  type PaginationMeta,
  type PaymentAction,
  type PlacedOrder,
  type TrackOrderRequest,
} from '@storefront-types';
import * as z from 'zod';
import { STOREFRONT_API_CLIENT, type ApiClient } from '../shared/api-client.token';

const paginatedOrdersEnvelopeSchema = apiResponseSchema(z.array(orderSchema)).extend({
  meta: paginationMetaSchema,
});

@Injectable({ providedIn: 'root' })
export class OrdersService {
  constructor(@Inject(STOREFRONT_API_CLIENT) private readonly api: ApiClient) {}

  /** Place an order. The caller MUST supply `idempotencyKey` per
   * constitution §3.6 and `docs/storefront-api-reference.md` §"Orders". */
  async create(input: CreateOrderRequest, idempotencyKey: string): Promise<PlacedOrder> {
    const body = createOrderRequestSchema.parse(input);
    // Constitution §3.6 requires a format allowlist on the idempotency key.
    // Storefront generates the value via crypto.randomUUID(); reject anything
    // that is not a UUID v4 to keep the contract narrow.
    z.string().uuid().parse(idempotencyKey);
    const envelope = await this.api.post<unknown>('/v1/orders', body, { idempotencyKey });
    return apiResponseSchema(placedOrderSchema).parse(envelope).data;
  }

  /** Start a fresh payment attempt for an unpaid order. */
  async retryPayment(id: string, idempotencyKey: string): Promise<PaymentAction> {
    z.string().min(1).parse(id);
    z.string().uuid().parse(idempotencyKey);
    const envelope = await this.api.post<unknown>(
      `/v1/orders/${encodeURIComponent(id)}/payment`,
      undefined,
      { idempotencyKey },
    );
    return apiResponseSchema(z.object({ paymentAction: paymentActionSchema })).parse(envelope).data
      .paymentAction;
  }

  /** Ask the API to re-read the payment status from the provider. */
  async confirmPayment(id: string, idempotencyKey: string): Promise<string> {
    z.string().min(1).parse(id);
    z.string().uuid().parse(idempotencyKey);
    const envelope = await this.api.post<unknown>(
      `/v1/orders/${encodeURIComponent(id)}/payment/confirm`,
      undefined,
      { idempotencyKey },
    );
    return apiResponseSchema(z.object({ paymentStatus: z.string() })).parse(envelope).data
      .paymentStatus;
  }

  async list(query: ListOrdersQuery = {}): Promise<{ data: Order[]; meta: PaginationMeta }> {
    const parsed = listOrdersQuerySchema.parse(query);
    const envelope = await this.api.get<unknown>('/v1/orders', {
      query: parsed as Record<string, string | number | undefined>,
    });
    const result = paginatedOrdersEnvelopeSchema.parse(envelope);
    return { data: result.data, meta: result.meta };
  }

  /**
   * Look an order up by number plus the email on file.
   *
   * A POST with a body, not a GET with a query string (finding K10): the email
   * is the shared secret that authorises the read, and a URL carrying one is
   * written to the access log, to the `Referer` of the next request the page
   * makes, and to the browser's history. The schema parse runs first, so a
   * malformed pair never leaves the browser at all.
   */
  async track(body: TrackOrderRequest): Promise<z.infer<typeof trackingResponseSchema>> {
    const parsed = trackOrderRequestSchema.parse(body);
    const envelope = await this.api.post<unknown>('/v1/orders/track', parsed);
    return apiResponseSchema(trackingResponseSchema).parse(envelope).data;
  }

  /** Guest pay again: the order number plus the email on file prove ownership. */
  async retryTrackedPayment(
    body: TrackOrderRequest,
    idempotencyKey: string,
  ): Promise<PaymentAction> {
    const parsed = trackOrderRequestSchema.parse(body);
    z.string().uuid().parse(idempotencyKey);
    const envelope = await this.api.post<unknown>('/v1/orders/track/payment', parsed, {
      idempotencyKey,
    });
    return apiResponseSchema(z.object({ paymentAction: paymentActionSchema })).parse(envelope).data
      .paymentAction;
  }

  async getById(id: string): Promise<Order> {
    z.string().min(1).parse(id);
    const envelope = await this.api.get<unknown>(`/v1/orders/${encodeURIComponent(id)}`);
    return apiResponseSchema(orderSchema).parse(envelope).data;
  }

  async invoice(id: string): Promise<z.infer<typeof invoiceResponseSchema>> {
    z.string().min(1).parse(id);
    const envelope = await this.api.get<unknown>(`/v1/orders/${encodeURIComponent(id)}/invoice`);
    return apiResponseSchema(invoiceResponseSchema).parse(envelope).data;
  }

  async cancel(id: string): Promise<Order> {
    z.string().min(1).parse(id);
    const envelope = await this.api.post<unknown>(`/v1/orders/${encodeURIComponent(id)}/cancel`);
    return apiResponseSchema(orderSchema).parse(envelope).data;
  }
}

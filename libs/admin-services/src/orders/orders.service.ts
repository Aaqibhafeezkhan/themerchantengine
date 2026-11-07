import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ADMIN_API_ROUTES, adminRoute, fillRoute } from '@admin-routes';
import { ADMIN_API_BASE_URL, envelope, toParams } from '../shared';
import {
  addOrderNoteRequestSchema,
  type AddOrderNoteRequest,
  createAdminOrderRequestSchema,
  type CreateAdminOrderRequest,
  createShipmentRequestSchema,
  type CreateShipmentRequest,
  editOrderRequestSchema,
  type EditOrderRequest,
  listOrdersQuerySchema,
  type ListOrdersQuery,
  listOrdersResponseSchema,
  type ListOrdersResponse,
  orderSchema,
  type Order,
  updateOrderStatusRequestSchema,
  type UpdateOrderStatusRequest,
  updateShipmentRequestSchema,
  type UpdateShipmentRequest,
} from './orders.schemas';

const ORDERS = ADMIN_API_ROUTES.orders;

/** /v1/admin/orders/* — see `apps/api/src/modules/orders/orders.controller.ts`. */
@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(ADMIN_API_BASE_URL);

  /** GET /v1/admin/orders */
  list(query: ListOrdersQuery = {}): Observable<ListOrdersResponse> {
    const parsed = listOrdersQuerySchema.parse(query);
    const params = new HttpParams({ fromObject: toParams(parsed as never) });
    return this.http
      .get<unknown>(`${this.apiBase}/${adminRoute(ORDERS.base)}`, { params, withCredentials: true })
      .pipe(map((raw) => listOrdersResponseSchema.parse(raw)));
  }

  /** POST /v1/admin/orders — admin manual order (UUID v4 idempotency key per request). */
  create(input: CreateAdminOrderRequest): Observable<Order> {
    const body = createAdminOrderRequestSchema.parse(input);
    return this.http
      .post<unknown>(`${this.apiBase}/${adminRoute(ORDERS.base)}`, body, {
        withCredentials: true,
        headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      })
      .pipe(map((raw) => orderSchema.parse(envelope(raw))));
  }

  /** POST /v1/admin/orders/:id/payment/capture (needs `payments:manage`). */
  capturePayment(id: string, idempotencyKey: string = crypto.randomUUID()): Observable<Order> {
    return this.paymentAction(fillRoute(ORDERS.paymentCapture, { id }), idempotencyKey);
  }

  /** POST /v1/admin/orders/:id/payment/refund (full refund only). */
  refundPayment(id: string, idempotencyKey: string = crypto.randomUUID()): Observable<Order> {
    return this.paymentAction(fillRoute(ORDERS.paymentRefund, { id }), idempotencyKey);
  }

  /** POST /v1/admin/orders/:id/payment/cancel (void an unpaid or authorized payment). */
  cancelPayment(id: string, idempotencyKey: string = crypto.randomUUID()): Observable<Order> {
    return this.paymentAction(fillRoute(ORDERS.paymentCancel, { id }), idempotencyKey);
  }

  private paymentAction(path: string, idempotencyKey: string): Observable<Order> {
    return this.http
      .post<unknown>(
        `${this.apiBase}/${adminRoute(ORDERS.base, path)}`,
        {},
        {
          withCredentials: true,
          headers: { 'X-Idempotency-Key': idempotencyKey },
        },
      )
      .pipe(map((raw) => orderSchema.parse(envelope(raw))));
  }

  /** GET /v1/admin/orders/stats */
  stats(): Observable<unknown> {
    return this.http
      .get<unknown>(`${this.apiBase}/${adminRoute(ORDERS.base, ORDERS.stats)}`, {
        withCredentials: true,
      })
      .pipe(map((raw) => envelope(raw)));
  }

  /** GET /v1/admin/orders/export — CSV blob, not JSON. */
  exportCsv(query: ListOrdersQuery = {}): Observable<Blob> {
    const parsed = listOrdersQuerySchema.parse(query);
    const params = new HttpParams({ fromObject: toParams(parsed as never) });
    return this.http.get(`${this.apiBase}/${adminRoute(ORDERS.base, ORDERS.export)}`, {
      params,
      withCredentials: true,
      responseType: 'blob',
    });
  }

  /** GET /v1/admin/orders/:id */
  get(id: string): Observable<Order> {
    return this.http
      .get<unknown>(`${this.apiBase}/${adminRoute(ORDERS.base, fillRoute(ORDERS.byId, { id }))}`, {
        withCredentials: true,
      })
      .pipe(map((raw) => orderSchema.parse(envelope(raw))));
  }

  /** GET /v1/admin/orders/:id/invoice */
  getInvoice(id: string): Observable<unknown> {
    return this.http
      .get<unknown>(
        `${this.apiBase}/${adminRoute(ORDERS.base, fillRoute(ORDERS.invoice, { id }))}`,
        { withCredentials: true },
      )
      .pipe(map((raw) => envelope(raw)));
  }

  /** PATCH /v1/admin/orders/:id/status */
  updateStatus(id: string, input: UpdateOrderStatusRequest): Observable<Order> {
    const body = updateOrderStatusRequestSchema.parse(input);
    return this.http
      .patch<unknown>(
        `${this.apiBase}/${adminRoute(ORDERS.base, fillRoute(ORDERS.status, { id }))}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => orderSchema.parse(envelope(raw))));
  }

  /** PATCH /v1/admin/orders/:id — edit items / shipping / discount / notes. */
  edit(id: string, input: EditOrderRequest): Observable<Order> {
    const body = editOrderRequestSchema.parse(input);
    return this.http
      .patch<unknown>(
        `${this.apiBase}/${adminRoute(ORDERS.base, fillRoute(ORDERS.byId, { id }))}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => orderSchema.parse(envelope(raw))));
  }

  /** POST /v1/admin/orders/:id/shipments */
  createShipment(orderId: string, input: CreateShipmentRequest): Observable<unknown> {
    const body = createShipmentRequestSchema.parse(input);
    return this.http
      .post<unknown>(
        `${this.apiBase}/${adminRoute(ORDERS.base, fillRoute(ORDERS.shipments, { id: orderId }))}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => envelope(raw)));
  }

  /** PATCH /v1/admin/orders/:id/shipments/:sid */
  updateShipment(
    orderId: string,
    shipmentId: string,
    input: UpdateShipmentRequest,
  ): Observable<unknown> {
    const body = updateShipmentRequestSchema.parse(input);
    return this.http
      .patch<unknown>(
        `${this.apiBase}/${adminRoute(ORDERS.base, fillRoute(ORDERS.shipmentById, { id: orderId, sid: shipmentId }))}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => envelope(raw)));
  }

  /** POST /v1/admin/orders/:id/notes */
  addNote(orderId: string, input: AddOrderNoteRequest): Observable<unknown> {
    const body = addOrderNoteRequestSchema.parse(input);
    return this.http
      .post<unknown>(
        `${this.apiBase}/${adminRoute(ORDERS.base, fillRoute(ORDERS.notes, { id: orderId }))}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => envelope(raw)));
  }
}

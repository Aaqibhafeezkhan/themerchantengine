import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ADMIN_API_ROUTES, adminRoute, fillRoute } from '@admin-routes';
import { ADMIN_API_BASE_URL, envelope, toParams } from '../shared';
import {
  type CreatePaymentMethodRequest,
  createPaymentMethodRequestSchema,
  type ListPaymentMethodsQuery,
  listPaymentMethodsQuerySchema,
  type ListPaymentMethodsResponse,
  listPaymentMethodsResponseSchema,
  type PaymentMethod,
  paymentMethodSchema,
  type PaymentProviderCatalogueEntry,
  paymentProviderCatalogueResponseSchema,
  type ReorderPaymentMethodsRequest,
  reorderPaymentMethodsRequestSchema,
  type UpdatePaymentMethodRequest,
  updatePaymentMethodRequestSchema,
} from './payments.schemas';

const PAYMENT_METHODS = ADMIN_API_ROUTES.paymentMethods;

/**
 * `/v1/admin/payment-methods/*`. Secrets arrive masked as `***` on
 * every response; an empty `config` object on a PATCH does not clear
 * secrets — callers must explicitly pass `null` per key to delete.
 */
@Injectable({ providedIn: 'root' })
export class PaymentMethodsService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(ADMIN_API_BASE_URL);

  list(query: ListPaymentMethodsQuery = {}): Observable<ListPaymentMethodsResponse> {
    const parsed = listPaymentMethodsQuerySchema.parse(query);
    const params = new HttpParams({ fromObject: toParams(parsed as never) });
    return this.http
      .get<unknown>(`${this.apiBase}/${adminRoute(PAYMENT_METHODS.base, PAYMENT_METHODS.list)}`, {
        params,
        withCredentials: true,
      })
      .pipe(map((raw) => listPaymentMethodsResponseSchema.parse(raw)));
  }

  providers(): Observable<PaymentProviderCatalogueEntry[]> {
    return this.http
      .get<unknown>(
        `${this.apiBase}/${adminRoute(PAYMENT_METHODS.base, PAYMENT_METHODS.providers)}`,
        { withCredentials: true },
      )
      .pipe(map((raw) => paymentProviderCatalogueResponseSchema.parse(envelope(raw))));
  }

  get(id: string): Observable<PaymentMethod> {
    return this.http
      .get<unknown>(
        `${this.apiBase}/${adminRoute(PAYMENT_METHODS.base, fillRoute(PAYMENT_METHODS.byId, { id }))}`,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => paymentMethodSchema.parse(envelope(raw))));
  }

  create(input: CreatePaymentMethodRequest): Observable<PaymentMethod> {
    const body = createPaymentMethodRequestSchema.parse(input);
    return this.http
      .post<unknown>(
        `${this.apiBase}/${adminRoute(PAYMENT_METHODS.base, PAYMENT_METHODS.list)}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => paymentMethodSchema.parse(envelope(raw))));
  }

  update(id: string, input: UpdatePaymentMethodRequest): Observable<PaymentMethod> {
    const body = updatePaymentMethodRequestSchema.parse(input);
    return this.http
      .patch<unknown>(
        `${this.apiBase}/${adminRoute(PAYMENT_METHODS.base, fillRoute(PAYMENT_METHODS.byId, { id }))}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => paymentMethodSchema.parse(envelope(raw))));
  }

  delete(id: string): Observable<void> {
    return this.http
      .delete<void>(
        `${this.apiBase}/${adminRoute(PAYMENT_METHODS.base, fillRoute(PAYMENT_METHODS.byId, { id }))}`,
        {
          withCredentials: true,
        },
      )
      .pipe(map(() => undefined));
  }

  reorder(input: ReorderPaymentMethodsRequest): Observable<void> {
    const body = reorderPaymentMethodsRequestSchema.parse(input);
    return this.http
      .post<void>(
        `${this.apiBase}/${adminRoute(PAYMENT_METHODS.base, PAYMENT_METHODS.reorder)}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map(() => undefined));
  }
}

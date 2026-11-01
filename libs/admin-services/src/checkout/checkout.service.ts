import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, throwError } from 'rxjs';
import { ADMIN_API_ROUTES, adminRoute } from '@admin-routes';
import { ADMIN_API_BASE_URL, envelope } from '../shared';
import {
  type CheckoutSettings,
  checkoutSettingsSchema,
  type UpdateCheckoutSettingsRequest,
  updateCheckoutSettingsRequestSchema,
} from './checkout.schemas';

const CHECKOUT = ADMIN_API_ROUTES.checkout;

@Injectable({ providedIn: 'root' })
export class CheckoutSettingsService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(ADMIN_API_BASE_URL);

  get(): Observable<CheckoutSettings> {
    return this.http
      .get<unknown>(`${this.apiBase}/${adminRoute(CHECKOUT.base, CHECKOUT.settings)}`, {
        withCredentials: true,
      })
      .pipe(map((raw) => checkoutSettingsSchema.parse(envelope(raw))));
  }

  update(input: UpdateCheckoutSettingsRequest): Observable<CheckoutSettings> {
    let body: UpdateCheckoutSettingsRequest;
    try {
      body = updateCheckoutSettingsRequestSchema.parse(input);
    } catch (err) {
      return throwError(() => err);
    }
    return this.http
      .patch<unknown>(`${this.apiBase}/${adminRoute(CHECKOUT.base, CHECKOUT.settings)}`, body, {
        withCredentials: true,
      })
      .pipe(map((raw) => checkoutSettingsSchema.parse(envelope(raw))));
  }
}

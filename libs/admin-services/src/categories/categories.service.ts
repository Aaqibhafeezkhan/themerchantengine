import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, throwError } from 'rxjs';
import { ADMIN_API_ROUTES, adminRoute, fillRoute } from '@admin-routes';
import { ADMIN_API_BASE_URL, envelope, rawLocaleContext } from '../shared';
import {
  type Category,
  categorySchema,
  type CreateCategoryRequest,
  createCategoryRequestSchema,
  type ReorderCategoriesRequest,
  reorderCategoriesRequestSchema,
  type UpdateCategoryRequest,
  updateCategoryRequestSchema,
} from './categories.schemas';

const CATEGORIES = ADMIN_API_ROUTES.categories;

/** /v1/admin/categories + reorder + CRUD. Soft-delete semantics. */
@Injectable({ providedIn: 'root' })
export class CategoriesService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(ADMIN_API_BASE_URL);

  /** GET /v1/admin/categories — full tree with product counts. */
  tree(): Observable<Category[]> {
    return this.http
      .get<unknown>(`${this.apiBase}/${adminRoute(CATEGORIES.base, CATEGORIES.adminList)}`, {
        context: rawLocaleContext(),
        withCredentials: true,
      })
      .pipe(
        map((raw) => {
          const data = envelope<unknown>(raw);
          return Array.isArray(data) ? data.map((d) => categorySchema.parse(d)) : [];
        }),
      );
  }

  create(input: CreateCategoryRequest): Observable<Category> {
    let body: CreateCategoryRequest;
    try {
      body = createCategoryRequestSchema.parse(input);
    } catch (err) {
      return throwError(() => err);
    }
    return this.http
      .post<unknown>(`${this.apiBase}/${adminRoute(CATEGORIES.base, CATEGORIES.adminList)}`, body, {
        withCredentials: true,
      })
      .pipe(map((raw) => categorySchema.parse(envelope(raw))));
  }

  /** PATCH /v1/admin/categories/reorder — declared before /:id to avoid shadowing. */
  reorder(input: ReorderCategoriesRequest): Observable<void> {
    let body: ReorderCategoriesRequest;
    try {
      body = reorderCategoriesRequestSchema.parse(input);
    } catch (err) {
      return throwError(() => err);
    }
    return this.http
      .patch<void>(`${this.apiBase}/${adminRoute(CATEGORIES.base, CATEGORIES.reorder)}`, body, {
        withCredentials: true,
      })
      .pipe(map(() => undefined));
  }

  update(id: string, input: UpdateCategoryRequest): Observable<Category> {
    let body: UpdateCategoryRequest;
    try {
      body = updateCategoryRequestSchema.parse(input);
    } catch (err) {
      return throwError(() => err);
    }
    return this.http
      .patch<unknown>(
        `${this.apiBase}/${adminRoute(CATEGORIES.base, fillRoute(CATEGORIES.adminById, { id }))}`,
        body,
        {
          withCredentials: true,
        },
      )
      .pipe(map((raw) => categorySchema.parse(envelope(raw))));
  }

  /** Soft-delete. 409 if products are still assigned. */
  delete(id: string): Observable<void> {
    return this.http
      .delete<void>(
        `${this.apiBase}/${adminRoute(CATEGORIES.base, fillRoute(CATEGORIES.adminById, { id }))}`,
        { withCredentials: true },
      )
      .pipe(map(() => undefined));
  }
}

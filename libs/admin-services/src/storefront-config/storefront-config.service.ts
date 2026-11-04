import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ADMIN_API_ROUTES, adminRoute, fillRoute } from '@admin-routes';
import { ADMIN_API_BASE_URL, envelope, rawLocaleContext, toParams } from '../shared';
import {
  createSectionRequestSchema,
  type CreateSectionRequest,
  listPagesResponseSchema,
  type ListPagesResponse,
  listSectionsQuerySchema,
  type ListSectionsQuery,
  listSectionsResponseSchema,
  type ListSectionsResponse,
  pageSlugSchema,
  reorderSectionsRequestSchema,
  type ReorderSectionsRequest,
  storefrontSectionSchema,
  type StorefrontSection,
  toggleVisibilityRequestSchema,
  type ToggleVisibilityRequest,
  updateSectionRequestSchema,
  type UpdateSectionRequest,
  storefrontPublicConfigSchema,
  type StorefrontPublicConfig,
} from './storefront-config.schemas';

const STOREFRONT = ADMIN_API_ROUTES.storefrontConfig;

/**
 * `/v1/admin/storefront/*` — dynamic page sections (hero, banners, grids…).
 *
 * The backend uses wildcard route params (`:pageSlug`) so slug values may
 * include `/` (e.g. `collections/summer`). We encode the slug segment-by-segment
 * to preserve this structure rather than `encodeURIComponent`-ing the slashes.
 */
@Injectable({ providedIn: 'root' })
export class StorefrontConfigService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(ADMIN_API_BASE_URL);

  listPages(): Observable<ListPagesResponse> {
    return this.http
      .get<unknown>(`${this.apiBase}/${adminRoute(STOREFRONT.base, STOREFRONT.pages)}`, {
        withCredentials: true,
        context: rawLocaleContext(),
      })
      .pipe(map((raw) => listPagesResponseSchema.parse(raw)));
  }

  listSections(pageSlug: string, query: ListSectionsQuery = {}): Observable<ListSectionsResponse> {
    const slug = pageSlugSchema.parse(pageSlug);
    const parsed = listSectionsQuerySchema.parse(query);
    const params = new HttpParams({ fromObject: toParams(parsed as never) });
    return this.http
      .get<unknown>(
        `${this.apiBase}/${adminRoute(STOREFRONT.base, STOREFRONT.pageSections.replace(':pageSlug', this.encodeSlug(slug)))}`,
        {
          params,
          withCredentials: true,
          context: rawLocaleContext(),
        },
      )
      .pipe(map((raw) => listSectionsResponseSchema.parse(raw)));
  }

  reorderSections(pageSlug: string, input: ReorderSectionsRequest): Observable<void> {
    const slug = pageSlugSchema.parse(pageSlug);
    const body = reorderSectionsRequestSchema.parse(input);
    return this.http
      .patch<void>(
        `${this.apiBase}/${adminRoute(STOREFRONT.base, STOREFRONT.sectionsReorder.replace(':pageSlug', this.encodeSlug(slug)))}`,
        body,
        { withCredentials: true, context: rawLocaleContext() },
      )
      .pipe(map(() => undefined));
  }

  createSection(pageSlug: string, input: CreateSectionRequest): Observable<StorefrontSection> {
    const slug = pageSlugSchema.parse(pageSlug);
    const body = createSectionRequestSchema.parse(input);
    // Backend DTO declares pageSlug as required (class-validator runs before
    // the controller's server-side override), so echo it into the body.
    return this.http
      .post<unknown>(
        `${this.apiBase}/${adminRoute(STOREFRONT.base, STOREFRONT.pageSections.replace(':pageSlug', this.encodeSlug(slug)))}`,
        { ...body, pageSlug: slug },
        { withCredentials: true, context: rawLocaleContext() },
      )
      .pipe(map((raw) => storefrontSectionSchema.parse(envelope(raw))));
  }

  updateSection(id: string, input: UpdateSectionRequest): Observable<StorefrontSection> {
    const body = updateSectionRequestSchema.parse(input);
    return this.http
      .patch<unknown>(
        `${this.apiBase}/${adminRoute(STOREFRONT.base, fillRoute(STOREFRONT.sectionById, { id }))}`,
        body,
        { withCredentials: true, context: rawLocaleContext() },
      )
      .pipe(map((raw) => storefrontSectionSchema.parse(envelope(raw))));
  }

  deleteSection(id: string): Observable<void> {
    return this.http
      .delete<void>(
        `${this.apiBase}/${adminRoute(STOREFRONT.base, fillRoute(STOREFRONT.sectionById, { id }))}`,
        {
          withCredentials: true,
          context: rawLocaleContext(),
        },
      )
      .pipe(map(() => undefined));
  }

  toggleVisibility(id: string, input: ToggleVisibilityRequest): Observable<StorefrontSection> {
    const body = toggleVisibilityRequestSchema.parse(input);
    return this.http
      .patch<unknown>(
        `${this.apiBase}/${adminRoute(STOREFRONT.base, fillRoute(STOREFRONT.sectionVisibility, { id }))}`,
        body,
        { withCredentials: true, context: rawLocaleContext() },
      )
      .pipe(map((raw) => storefrontSectionSchema.parse(envelope(raw))));
  }

  private encodeSlug(slug: string): string {
    return slug
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  /**
   * GET /admin/storefront/public-config — origin plus product URL shape.
   *
   * Gated on `products:view` server-side, so every operator who can open a
   * product can also resolve the link to it.
   */
  getPublicConfig(): Observable<StorefrontPublicConfig> {
    return this.http
      .get<unknown>(`${this.apiBase}/${adminRoute(STOREFRONT.base, STOREFRONT.publicConfig)}`, {
        withCredentials: true,
      })
      .pipe(map((raw) => storefrontPublicConfigSchema.parse(envelope(raw))));
  }
}

/**
 * Single source of truth for every `/v1/admin/*` route path (DR-25).
 *
 * Consumed identically by:
 *  - the NestJS admin controllers in `apps/api` — `@Controller(node.base)` plus
 *    method decorators `@Get(node.sub)` / `@Post(...)` / `@Patch(...)` / `@Delete(...)`;
 *  - the Angular admin services in `libs/admin-services` — request URLs built with
 *    `` `${apiBase}/${adminRoute(node.base, node.sub)}` `` (and `fillRoute` for `:param` routes).
 *
 * This library is framework-neutral: pure constants + two string helpers, no NestJS
 * or Angular imports, so both the webpack (api) and the Angular build graphs resolve it.
 *
 * ## Contract
 *
 * - `base` is the exact `@Controller(...)` argument of the controller that serves the
 *   route — no leading slash. Many admin controllers share `'v1'` or `'v1/admin'` as
 *   their base and carry the `admin/<module>/…` segment in the method path; the tree
 *   mirrors that structure exactly so the migration stays behaviour-preserving (the
 *   produced path string equals the literal it replaced, byte for byte).
 * - Each sub-path is the method-relative path in NestJS form, with `:param`
 *   placeholders kept verbatim (including any `(*)` matcher suffix). A route whose
 *   method decorator is empty (`@Get()`, `@Post()`) has no sub key — callers use
 *   `base` directly via `adminRoute(base)`.
 * - Spec files are intentionally NOT migrated onto these constants: a test that pins
 *   the literal URL is the independent guard that proves a constant resolves to the
 *   right path.
 */

/** Join a controller base and a method-relative sub-path. Empty sub → the base alone. */
export function adminRoute(base: string, sub = ''): string {
  return sub ? `${base}/${sub}` : base;
}

/**
 * Substitute `:param` (and `:param(matcher)`) placeholders in a route template with
 * URL-encoded values, for the Angular call sites that need a concrete path. Throws on a
 * missing param so a wrong call fails loudly at the call site rather than emitting a
 * malformed URL. The optional `(…)` matcher suffix (e.g. a custom matcher) is part
 * of the placeholder token and is stripped along with the name.
 */
export function fillRoute(template: string, params: Record<string, string | number>): string {
  return template.replace(/:([A-Za-z0-9_]+)(\([^)]*\))?/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(`fillRoute: missing route param ":${name}" for template "${template}"`);
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * The admin route tree. Grouped by admin module; each node's `base` is the serving
 * controller's `@Controller(...)` argument and the remaining keys are method-relative
 * sub-paths. Empty-path routes (list/create/update on a `base`-only controller) carry
 * no sub key and use `base` directly.
 */
export const ADMIN_API_ROUTES = {
  analytics: {
    base: 'v1/admin/analytics',
    dashboard: 'dashboard',
    funnel: 'funnel',
    products: 'products',
    revenue: 'revenue',
    customers: 'customers',
    search: 'search',
    timeseries: 'timeseries',
    pixels: 'pixels',
  },
  assets: {
    base: 'v1',
    upload: 'admin/assets/upload',
    list: 'admin/assets',
    byId: 'admin/assets/:id',
    references: 'admin/assets/:id/references',
    originalUrl: 'admin/assets/:id/original-url',
  },
  auditLog: {
    base: 'v1/admin/audit-log',
    byEntity: ':entityType/:entityId',
  },
  carriers: {
    base: 'v1/admin/carriers',
    byId: ':id',
  },
  campaigns: {
    base: 'v1/admin/campaigns',
    byId: ':id',
    stats: ':id/stats',
    preview: ':id/preview',
    send: ':id/send',
    test: ':id/test',
  },
  subscribers: {
    base: 'v1/admin/subscribers',
    byId: ':id',
  },
  categories: {
    base: 'v1',
    adminList: 'admin/categories',
    reorder: 'admin/categories/reorder',
    adminById: 'admin/categories/:id',
  },
  checkout: {
    base: 'v1/admin/checkout',
    settings: 'settings',
  },
  cms: {
    base: 'v1/admin/pages',
    byId: ':id',
  },
  countries: {
    base: 'v1/admin/countries',
  },
  currencies: {
    base: 'v1/admin/currencies',
    store: 'store',
  },
  geo: {
    base: 'v1/admin/geo',
    aiReadiness: 'ai-readiness',
    faqSuggestions: 'products/:productId/faqs/suggestions',
    faqAccept: 'products/:productId/faqs/accept',
  },
  giftCards: {
    base: 'v1',
    adminList: 'admin/gift-cards',
    adminById: 'admin/gift-cards/:id',
    adjust: 'admin/gift-cards/:id/adjust',
    resend: 'admin/gift-cards/:id/resend',
  },
  globalSearch: {
    base: 'v1/admin/search',
  },
  search: {
    base: 'v1/admin/search',
    analytics: 'analytics',
    zeroResults: 'zero-results',
    reindex: 'reindex',
    synonyms: 'synonyms',
    synonymById: 'synonyms/:id',
    merchandising: 'merchandising',
    merchandisingById: 'merchandising/:id',
  },
  inventory: {
    base: 'v1',
    list: 'admin/inventory',
    variant: 'admin/inventory/variant/:variantId',
    adjust: 'admin/inventory/adjust',
    transfer: 'admin/inventory/transfer',
    alerts: 'admin/inventory/alerts',
    movements: 'admin/inventory/movements',
    locations: 'admin/inventory/locations',
    locationById: 'admin/inventory/locations/:id',
  },
  notifications: {
    base: 'v1/admin/notifications',
    read: ':id/read',
    readAll: 'read-all',
    unreadCount: 'unread-count',
  },
  notificationTemplates: {
    base: 'v1/admin/notifications',
    log: 'log',
    logResend: 'log/:id/resend',
    templates: 'templates',
    templateById: 'templates/:id',
    templatePreview: 'templates/:id/preview',
    templateSendTest: 'templates/:id/send-test',
  },
  orders: {
    base: 'v1/admin/orders',
    stats: 'stats',
    export: 'export',
    byId: ':id',
    invoice: ':id/invoice',
    invoicePdf: ':id/invoice/pdf',
    status: ':id/status',
    paymentCapture: ':id/payment/capture',
    paymentRefund: ':id/payment/refund',
    paymentCancel: ':id/payment/cancel',
    shipments: ':id/shipments',
    shipmentById: ':id/shipments/:sid',
    notes: ':id/notes',
  },
  paymentMethods: {
    base: 'v1/admin',
    list: 'payment-methods',
    reorder: 'payment-methods/reorder',
    byId: 'payment-methods/:id',
  },
  products: {
    base: 'v1',
    productTypes: 'admin/product-types',
    productTypeById: 'admin/product-types/:id',
    attributes: 'admin/attributes',
    attributeById: 'admin/attributes/:id',
    attributeValues: 'admin/attributes/:id/values',
    attributeValueById: 'admin/attributes/:id/values/:valueId',
    bulkPrices: 'admin/products/bulk/prices',
    bulkStatus: 'admin/products/bulk/status',
    list: 'admin/products',
    byId: 'admin/products/:id',
    restore: 'admin/products/:id/restore',
    variants: 'admin/products/:id/variants',
    variantById: 'admin/products/:id/variants/:variantId',
    assets: 'admin/products/:id/assets',
    faqs: 'admin/products/:id/faqs',
    faqById: 'admin/products/:id/faqs/:faqId',
    specs: 'admin/products/:id/specs',
    stock: 'admin/products/:id/stock',
    /**
     * Distinct spec labels across the catalogue, for the editor's label
     * autocomplete. A first segment of its own rather than a child of
     * `admin/products/:id`, so `product-specs` can never be captured as a
     * product id.
     */
    specLabels: 'admin/product-specs/labels',
  },
  promotions: {
    base: 'v1',
    adminList: 'admin/promotions',
    adminById: 'admin/promotions/:id',
  },
  returns: {
    base: 'v1/admin/returns',
    analytics: 'analytics',
    byId: ':id',
    approve: ':id/approve',
    reject: ':id/reject',
    receive: ':id/receive',
    refund: ':id/refund',
    close: ':id/close',
  },
  reviews: {
    base: 'v1/admin',
    reviews: 'reviews',
    reviewApprove: 'reviews/:id/approve',
    reviewReject: 'reviews/:id/reject',
    reviewById: 'reviews/:id',
    questions: 'questions',
    questionApprove: 'questions/:id/approve',
    questionReject: 'questions/:id/reject',
    questionAnswer: 'questions/:id/answer',
  },
  seo: {
    base: 'v1/admin/seo',
    redirects: 'redirects',
    redirectById: 'redirects/:id',
    health: 'health',
    healthRecheck: 'health/recheck',
    submissions: 'submissions',
    submit: 'submit',
    coverage: 'coverage',
    quota: 'quota',
    analytics: 'analytics',
    urlInspection: 'url-inspection',
  },
  settings: {
    base: 'v1/admin/settings',
    locales: 'locales',
  },
  shipping: {
    base: 'v1',
    zones: 'admin/shipping/zones',
    zoneById: 'admin/shipping/zones/:id',
    methods: 'admin/shipping/methods',
    methodById: 'admin/shipping/methods/:id',
  },
  storefrontConfig: {
    base: 'v1/admin/storefront',
    /** Public origin + product URL shape, for admin deep links to the shop. */
    publicConfig: 'public-config',
    pages: 'pages',
    pageSections: 'pages/:pageSlug/sections',
    sectionsReorder: 'pages/:pageSlug/sections/reorder',
    sectionById: 'sections/:id',
    sectionVisibility: 'sections/:id/visibility',
  },
  tax: {
    base: 'v1',
    zones: 'admin/tax/zones',
    zoneById: 'admin/tax/zones/:id',
    classes: 'admin/tax/classes',
  },
  users: {
    base: 'v1',
    customers: 'admin/customers',
    customerSegments: 'admin/customers/segments',
    customerById: 'admin/customers/:id',
    staff: 'admin/staff',
    staffById: 'admin/staff/:id',
    roles: 'admin/roles',
    roleById: 'admin/roles/:id',
  },
  webhooks: {
    base: 'v1/admin/webhooks',
    byId: ':id',
    test: ':id/test',
    deliveries: ':id/deliveries',
  },
} as const;

export type AdminApiRoutes = typeof ADMIN_API_ROUTES;

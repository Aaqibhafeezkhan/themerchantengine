import * as z from 'zod';
import { entityIdSchema } from './ids';
import { resolvedStringSchema } from './translatable';
import { assetVariantsArraySchema } from './asset-variants';

/**
 * Permissive entity sub-schemas shared across modules. Each schema covers the
 * fields the storefront UI is documented to consume per
 * `docs/storefront-api-reference.md`. Unknown extra fields pass through via
 * `.passthrough()` so the storefront tolerates additive backend changes.
 *
 * Prisma `Decimal` columns serialize as JSON strings ("3499.00") on the wire.
 * `decimalSchema` accepts either a `number` or a numeric `string` so the
 * storefront client tolerates the wire format without forcing the API to
 * coerce. Format helpers (`<bdi>149 EUR</bdi>`) call `Number.parseFloat` on
 * read.
 */
export const decimalSchema = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?$/, 'Invalid decimal'),
]);
export type Decimal = z.infer<typeof decimalSchema>;

/**
 * Asset records on storefront responses come in two shapes:
 *  - a full asset record (id, type, url) on detail / asset endpoints, and
 *  - a reference (assetId + sortOrder + isPrimary) on list summaries.
 * `productAssetSchema` makes id/url/type optional + adds the reference fields,
 * so either shape parses without breaking the audit.
 *
 * `assetVariants` carries the responsive variant set the API emits via
 * `tryPickVariantUrl(...)?.srcset` per AV1 — a flat list of
 * `{ url, width, format }` entries spanning the four canonical widths × the
 * two image formats. The storefront feeds it to `pictureSourcesFromAssetVariants`
 * to build a `<picture>` source ladder. See `agent_docs/assets-pipeline.md` §1
 * + §2. AV5 tightens this from the `z.unknown()` cutover-window shape to the
 * canonical `assetVariantsArraySchema` so wire shape drift is caught at parse
 * time. Optional because PROCESSING/PENDING assets carry no variants yet.
 */
export const productAssetSchema = z
  .object({
    id: entityIdSchema.optional(),
    assetId: entityIdSchema.optional(),
    type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO']).optional(),
    url: z.string().optional(),
    assetVariants: assetVariantsArraySchema.optional(),
    altText: resolvedStringSchema.nullable().optional(),
    isPrimary: z.boolean().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type ProductAsset = z.infer<typeof productAssetSchema>;

/**
 * Three-state availability the API derives per variant from net available
 * stock against the store's low-stock threshold. Mirrors `STOCK_STATUSES` in
 * `apps/api/src/modules/inventory/inventory.constants.ts`. Declared rather than
 * left to `.passthrough()` so the storefront reads a checked literal, not an
 * untyped string, when it picks the state colour.
 */
export const availabilitySchema = z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK']);
export type Availability = z.infer<typeof availabilitySchema>;

export const productVariantSchema = z
  .object({
    id: entityIdSchema,
    sku: z.string().nullable().optional(),
    price: decimalSchema,
    compareAtPrice: decimalSchema.nullable().optional(),
    stock: z.number().int().nonnegative().optional(),
    // Optional so a payload predating the availability rollout still parses.
    availability: availabilitySchema.optional(),
    isDefault: z.boolean().optional(),
    attributes: z.record(z.string(), resolvedStringSchema).optional(),
  })
  .passthrough();
export type ProductVariant = z.infer<typeof productVariantSchema>;

export const ratingSummarySchema = z
  .object({
    averageRating: z.number().min(0).max(5),
    total: z.number().int().nonnegative(),
    histogram: z
      .object({
        '1': z.number().int().nonnegative(),
        '2': z.number().int().nonnegative(),
        '3': z.number().int().nonnegative(),
        '4': z.number().int().nonnegative(),
        '5': z.number().int().nonnegative(),
      })
      .partial()
      .optional(),
  })
  .passthrough();
export type RatingSummary = z.infer<typeof ratingSummarySchema>;

export const productSummarySchema = z
  .object({
    id: entityIdSchema,
    slug: z.string(),
    name: resolvedStringSchema,
    description: resolvedStringSchema.nullable().optional(),
    shortDescription: resolvedStringSchema.nullable().optional(),
    brand: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
    isFeatured: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    publishedAt: z.string().nullable().optional(),
    primaryAsset: productAssetSchema.nullable().optional(),
    assets: z.array(productAssetSchema).optional(),
    variants: z.array(productVariantSchema).optional(),
    // Search hits carry availability on the product, rolled up across its
    // variants, next to the `inStock` boolean the facet filter still reads.
    inStock: z.boolean().optional(),
    availability: availabilitySchema.optional(),
    // The name the wire actually uses. `GET /v1/search` sends it
    // (`search.service.ts` `ProductSearchResult.minPrice`), and the wishlist
    // transform below synthesises it from the row's flat `price`.
    //
    // It was declared as `priceMin` here for as long as this schema existed, next
    // to a `priceMax` and a `ratingSummary` that no serializer in the tree has
    // ever emitted either. Three declared names, zero producers: every reader of
    // them read `undefined` forever, and the search page's price chain ended in a
    // literal `0`, which is how production rendered `0,000 DT` on every search
    // card. A declared field with no producer reads like a contract and is not
    // one, so do not add one back without a serializer that sends it.
    minPrice: decimalSchema.nullable().optional(),
    currency: z.string().length(3).optional(),
  })
  .passthrough();
export type ProductSummary = z.infer<typeof productSummarySchema>;

export const productFaqSchema = z
  .object({
    id: entityIdSchema,
    question: resolvedStringSchema,
    answer: resolvedStringSchema,
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type ProductFaq = z.infer<typeof productFaqSchema>;

/**
 * One free-form specification row, label to value.
 *
 * Both sides are Translatable and arrive already resolved to the request locale
 * by the API's global interceptor, so `resolvedStringSchema` is the right shape
 * here rather than a raw `{default, fr, en}` object.
 *
 * `key` is the normalised label, derived server-side. It is carried to the
 * client so a spec row can be matched to its facet without comparing display
 * text, which would break the moment the locale changes.
 */
export const productSpecSchema = z
  .object({
    id: entityIdSchema,
    label: resolvedStringSchema,
    value: resolvedStringSchema,
    key: z.string(),
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type ProductSpec = z.infer<typeof productSpecSchema>;

/**
 * Per `docs/storefront-api-reference.md` §"GET /v1/products/:slug", the API
 * returns categories as Prisma junction records:
 *   `[{ productId, categoryId, category: { id, name, slug } }]`
 * The schema accepts this nested shape (and allows extra fields via passthrough).
 */
export const productDetailCategorySchema = z
  .object({
    productId: z.string().optional(),
    categoryId: z.string().optional(),
    category: z
      .object({
        id: entityIdSchema,
        slug: z.string(),
        name: resolvedStringSchema,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ProductDetailCategory = z.infer<typeof productDetailCategorySchema>;

export const productDetailSchema = productSummarySchema
  .extend({
    variants: z.array(productVariantSchema).default([]),
    assets: z.array(productAssetSchema).default([]),
    faqs: z.array(productFaqSchema).default([]),
    specs: z.array(productSpecSchema).default([]),
    categories: z.array(productDetailCategorySchema).default([]),
  })
  .passthrough();
export type ProductDetail = z.infer<typeof productDetailSchema>;

export const categorySchema: z.ZodType<{
  id: string;
  slug: string;
  name: unknown;
  description?: unknown;
  parentId?: string | null;
  productCount?: number;
  children?: unknown[];
  imageUrl?: string | null;
  imageVariants?: unknown[];
}> = z.lazy(() =>
  z
    .object({
      id: entityIdSchema,
      slug: z.string(),
      name: resolvedStringSchema,
      description: resolvedStringSchema.nullable().optional(),
      parentId: entityIdSchema.nullable().optional(),
      productCount: z.number().int().nonnegative().optional(),
      children: z.array(categorySchema).optional(),
      // `card`-intent URL the API resolves from `Category.imageId`, plus its
      // responsive ladder. Null / empty when the asset is missing or not READY,
      // which is when the storefront falls back to its drawn glyph.
      imageUrl: z.string().nullable().optional(),
      imageVariants: assetVariantsArraySchema.optional(),
    })
    .passthrough(),
);
export type Category = z.infer<typeof categorySchema>;

export const addressSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().nullable().optional(),
    fullName: z.string(),
    phone: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string().nullable().optional(),
    city: z.string(),
    state: z.string().nullable().optional(),
    postalCode: z.string().nullable().optional(),
    country: z.string().length(2),
    isDefaultShipping: z.boolean().optional(),
    isDefaultBilling: z.boolean().optional(),
  })
  .passthrough();
export type Address = z.infer<typeof addressSchema>;

export const cartLineSchema = z
  .object({
    id: entityIdSchema,
    variantId: entityIdSchema,
    // productId is not returned by the backend CartItemResponse — it is used
    // internally for promotions engine but omitted from the API envelope.
    // Marked optional so Zod parse does not fail on valid cart responses.
    productId: entityIdSchema.optional(),
    productSlug: z.string(),
    productName: resolvedStringSchema,
    // The cart envelope has never carried `primaryAsset`; `thumbnailUrl` is
    // what `CartItemResponse` emits per line. Kept declared and optional so a
    // payload that starts carrying one parses without a schema change.
    primaryAsset: productAssetSchema.nullable().optional(),
    thumbnailUrl: z.string().nullable().optional(),
    variantLabel: z.string().nullable().optional(),
    unitPrice: decimalSchema,
    compareAtPrice: decimalSchema.nullable().optional(),
    quantity: z.number().int().positive(),
    lineTotal: decimalSchema,
    // Live availability per line. Declared so the quantity stepper can cap
    // itself at what the warehouse actually holds instead of a hardcoded 99.
    inStock: z.boolean().optional(),
    stockAvailable: z.number().int().nonnegative().optional(),
    weight: z.number().nullable().optional(),
  })
  .passthrough();
export type CartLine = z.infer<typeof cartLineSchema>;

export const cartSchema = z
  .object({
    // id is a valid cuid for a persisted cart; the backend emits "" for the
    // virtual "no cart yet" response (GET /v1/cart with no session). Accept
    // both forms — empty string represents the virtual empty cart sentinel.
    id: z.union([entityIdSchema, z.literal('')]).optional(),
    items: z.array(cartLineSchema).default([]),
    subtotal: decimalSchema,
    // discounts is the backend's per-line discount array. discountAmount is
    // computed client-side by summing discounts[].amount when not provided.
    discounts: z
      .array(
        z
          .object({
            promotionId: z.string(),
            label: z.unknown(),
            amount: decimalSchema,
            type: z.enum(['automatic', 'coupon']),
          })
          .passthrough(),
      )
      .default([]),
    discountAmount: decimalSchema.optional(),
    /**
     * The names the API actually emits.
     *
     * `shippingAmount` and `taxAmount` used to sit here too, and the summary
     * components read those. The API has never sent either, and because both
     * spellings were optional behind a `.passthrough()` the parse succeeded
     * with the values undefined — so the VAT row could not render at any rate
     * and nothing anywhere failed. Removing the aliases is what makes a
     * mis-spelled read a compile error rather than a silent blank.
     */
    shippingEstimate: decimalSchema.nullable().optional(),
    taxEstimate: decimalSchema.nullable().optional(),
    // Resolved standard shipping method name — a Translatable the locale
    // interceptor narrows to a string, or the raw object on an unresolved path.
    shippingMethodName: z.unknown().nullable().optional(),
    total: decimalSchema,
    // Goods less discount plus shipping, tax-EXCLUSIVE. The cart page labels
    // this `HT` per plan.md §2.2; equals `total` when no shipping resolves.
    grandTotal: decimalSchema.optional(),
    // The tax-inclusive companion the checkout summary labels `TTC`. Equals
    // `grandTotal` until a delivery country has resolved a tax zone.
    grandTotalTtc: decimalSchema.optional(),
    // couponCode is the scalar string the backend persists on the Cart row.
    // The frontend derives the AppliedCoupon display model from couponCode +
    // the discounts[].type==='coupon' line. storefront-api-reference.md §Cart.
    couponCode: z.string().nullable().optional(),
    // Progress toward the store's automatic free-shipping threshold. The API
    // has always emitted it and nothing in the storefront read it, so a cart
    // that already qualified said nothing and a cart 25 DT short said nothing
    // either.
    freeShippingProgress: z
      .object({
        threshold: decimalSchema.nullable(),
        remaining: decimalSchema.nullable(),
        qualified: z.boolean(),
      })
      .passthrough()
      .nullable()
      .optional(),
    itemCount: z.number().int().nonnegative().optional(),
    // currency is not in the CartResponse shape the backend emits for cart
    // mutations — it is returned only on gift-card validation. Marked optional
    // so Zod parse succeeds on the standard cart envelope.
    currency: z.string().length(3).optional(),
    giftCard: z
      .object({
        code: z.string(),
        balanceApplied: decimalSchema,
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type Cart = z.infer<typeof cartSchema>;

// The backend `OrderItem` Prisma model stores the per-line total in a column
// named `total` (decimal) and has no `productSlug` column — Prisma OrderItem
// keeps a snapshot via `productName` + `sku` + `productId` (the latter is
// nullable when the source product is later archived). The storefront's
// historical contract used cart-style `productSlug` + `lineTotal` field
// names, which the live API never emits, so a strict schema rejected every
// `POST /v1/orders` response and the checkout fell into the generic
// "Network error" branch even though the order was successfully created.
//
// We accept both the documented (`lineTotal`) and the live (`total`) field
// names, and the transform normalises so existing UI bindings that read
// `line.lineTotal` keep working without a per-page fallback. `productSlug`
// is optional — order-confirmation and order-detail screens render the
// snapshot `productName` for line copy, not the slug.
export const orderLineSchema = z
  .object({
    id: entityIdSchema,
    productId: entityIdSchema.nullable().optional(),
    variantId: entityIdSchema.nullable().optional(),
    productSlug: z.string().optional(),
    productName: resolvedStringSchema,
    quantity: z.number().int().positive(),
    unitPrice: decimalSchema,
    total: decimalSchema.optional(),
    lineTotal: decimalSchema.optional(),
  })
  .passthrough()
  .transform((line) => ({
    ...line,
    lineTotal: line.lineTotal ?? line.total,
  }));
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'ON_HOLD',
  'RETURN_REQUESTED',
  'RETURNED',
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const paymentStatusSchema = z.enum([
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'CANCELLED',
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/**
 * Mirror of Prisma `enum ShipmentStatus` as it arrives on the wire.
 * `toCustomerOrder` ships the shipment rows to the storefront, so the day a
 * consumer types that field against this schema, an enum missing CANCELLED
 * would make every order the cancel cascade has touched fail to parse and
 * render as "Could not load" (the schema-drift bug class). Kept in step with
 * the value rather than with the current consumers.
 */
export const shipmentStatusSchema = z.enum(['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;

export const orderSchema = z
  .object({
    id: entityIdSchema,
    orderNumber: z.string(),
    status: orderStatusSchema,
    paymentStatus: paymentStatusSchema,
    // The storefront list endpoint (`GET /v1/orders`) selects a lightweight
    // projection without `items[]` (see `ORDER_LIST_SELECT` in
    // `apps/api/src/modules/orders/orders.service.ts`). The detail endpoint
    // (`GET /v1/orders/:id`) and the create endpoint (`POST /v1/orders`)
    // include the full items relation. Default to `[]` so the list shape
    // parses without forcing every list-row consumer through a null guard.
    items: z.array(orderLineSchema).default([]),
    subtotal: decimalSchema,
    shippingAmount: decimalSchema.optional(),
    // Snapshot of the charged shipping method name (plain string on the order,
    // unlike the cart's Translatable). Typed explicitly so it survives the
    // `.passthrough()` and isn't dropped from the Order type (schema-drift guard).
    shippingMethodName: z.string().nullable().optional(),
    taxAmount: decimalSchema.optional(),
    discountAmount: decimalSchema.optional(),
    total: decimalSchema,
    currency: z.string().length(3),
    shippingAddress: addressSchema.partial().passthrough().nullable().optional(),
    billingAddress: addressSchema.partial().passthrough().nullable().optional(),
    notes: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string().optional(),
    /**
     * Server-computed: inside the customer-cancellable window AND no shipment
     * that has not itself been cancelled. Typed rather than left to
     * `.passthrough()` so the order-detail page's cancel button cannot silently
     * read `undefined` (finding AD4). Optional because the list projection does
     * not carry it.
     */
    cancellable: z.boolean().optional(),
    /**
     * Server-computed: the payment is unpaid or failed and the order is not
     * cancelled, which is exactly when `POST /orders/:id/payment` accepts a
     * retry. Optional because the list projection does not carry it.
     */
    paymentRetryable: z.boolean().optional(),
    /**
     * Every recorded status transition, oldest first, projected by the API to
     * the two fields the timeline renders (finding AD6). Typed rather than left
     * to `.passthrough()` so the order-detail page cannot silently read
     * `undefined` and render nothing. Optional because the list projection does
     * not carry it.
     */
    statusHistory: z
      .array(
        z.object({
          status: orderStatusSchema,
          at: z.string(),
          note: z.string().nullable().optional(),
        }),
      )
      .optional(),
    /**
     * The immutable invoice snapshot, present exactly when one has been issued.
     *
     * Typed rather than left to `.passthrough()` because the order-detail page
     * decides whether to offer the download from this and nothing else (finding
     * K12). It used to guess from the status, which offered a download for a
     * DELIVERED order that has no invoice and refused one for a CANCELLED order
     * that does. A field read through passthrough luck is a field that can go
     * `undefined` on a schema change without anything going red.
     */
    invoice: z
      .object({
        id: entityIdSchema,
        invoiceNumber: z.string(),
        issuedAt: z.string(),
      })
      .passthrough()
      .nullable()
      .optional(),
    /** Set when the order reached DELIVERED. The one transition time the row keeps. */
    deliveredAt: z.string().nullable().optional(),
    /**
     * The tender snapshot, as `paymentMethodName` on the API's customer shape.
     * Written since plan F phase F5. Null on every order placed before it; a
     * consumer must read null as "not recorded", not as a tender.
     */
    paymentMethodName: z.string().nullable().optional(),
    paymentMethodCode: z.string().nullable().optional(),
  })
  .passthrough();
export type Order = z.infer<typeof orderSchema>;

export const reviewStatusSchema = z.enum(['PENDING', 'PUBLISHED', 'HIDDEN']);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewSchema = z
  .object({
    id: entityIdSchema,
    productId: entityIdSchema,
    userId: entityIdSchema.optional(),
    rating: z.number().int().min(1).max(5),
    title: z.string().nullable().optional(),
    body: z.string(),
    locale: z.string().nullable().optional(),
    helpfulCount: z.number().int().nonnegative().default(0),
    status: reviewStatusSchema,
    createdAt: z.string(),
    authorName: z.string().optional(),
    // What the API actually sends for the author. `authorName` is declared and
    // has never been populated by any endpoint, so the storefront rendered a
    // blank author everywhere and the product JSON-LD threw on every page with
    // a review. `.passthrough()` meant this arrived and was simply untyped.
    user: z
      .object({
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
export type Review = z.infer<typeof reviewSchema>;

export const questionStatusSchema = z.enum(['PENDING', 'PUBLISHED', 'HIDDEN']);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

// `ProductQuestion` holds ONE answer, in three flat columns (`answer`,
// `answeredBy`, `isAdminAnswer`); there is no answers relation and no endpoint
// has ever emitted one. The schema modelled `answers: z.array(...).default([])`
// anyway, so Zod filled in an empty array on every parse, the page mapped
// `q.answers ?? []`, and the flat fields rode `.passthrough()` unread: no
// stored answer ever reached the screen. The shape below is what the wire
// actually carries.
export const questionSchema = z
  .object({
    id: entityIdSchema,
    productId: entityIdSchema,
    question: z.string(),
    questionLocale: z.string().nullable().optional(),
    answer: z.string().nullable().optional(),
    isAdminAnswer: z.boolean().optional(),
    helpfulCount: z.number().int().nonnegative().default(0),
    status: questionStatusSchema,
    createdAt: z.string(),
    authorName: z.string().optional(),
    // The asker's name parts, as `QUESTION_PUBLIC_SELECT` sends them. Composed
    // client-side by `reviewAuthorName`, the same helper the review list uses.
    asker: z
      .object({
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
export type Question = z.infer<typeof questionSchema>;

// The live `GET /v1/wishlist` endpoint returns a flat row per item —
// `{ productId, productSlug, productName, price, availability, addedAt }`
// — see `apps/api/src/modules/wishlist/wishlist.service.ts` (the
// `enriched` map at the bottom of `list()`). The historical storefront
// contract assumed a nested `product: ProductSummary` shape with a separate
// row `id` and `createdAt` field. Neither field is emitted: WishlistItem in
// Prisma uses a composite `(userId, productId)` PK and the response field
// is `addedAt`, not `createdAt`.
//
// We accept both shapes and the transform synthesises the nested `product`
// object from the flat fields so existing UI bindings
// (`wishlist-row.component.ts` reads `item.product.slug` / `.name` /
// `.minPrice` / `.currency` / `.primaryAsset`) keep working without a per-row
// adapter at the call site.
//
// `primaryAsset` and `variantId` are the two fields the row actually needs and
// the API now emits them (plan E, phase E1). Both stay optional so a client
// running against an older API still parses instead of failing the page; the
// transform then synthesises `primaryAsset: null`, which is the branded
// fallback, not a crash. `variants` is still synthesised empty: the wishlist
// wire shape carries the buyable variant as a flat `variantId`, not a list.
export const wishlistItemSchema = z
  .object({
    productId: entityIdSchema,
    productSlug: z.string().optional(),
    productName: resolvedStringSchema.optional(),
    price: decimalSchema.nullable().optional(),
    // The three-state grade the API now emits, the same literal the catalogue
    // and product endpoints use.
    availability: availabilitySchema.optional(),
    // Retired by plan J: the endpoint shipped the exact count the catalogue
    // endpoints withhold. Kept optional for one release so a client running
    // against an older API still parses; remove once that window closes.
    availableStock: z.number().int().nonnegative().optional(),
    // The product's primary asset at the card intent, flat on the row.
    primaryAsset: productAssetSchema.nullable().optional(),
    // The variant Add-to-cart posts. Null when nothing on the product is
    // purchasable, which is what disables the button honestly.
    variantId: entityIdSchema.nullable().optional(),
    addedAt: z.string().optional(),
    createdAt: z.string().optional(),
    product: productSummarySchema.optional(),
  })
  .passthrough()
  .transform((item) => {
    const synthesised = item.product ?? {
      id: item.productId,
      slug: item.productSlug ?? '',
      name: item.productName ?? '',
      minPrice: item.price ?? undefined,
      currency: undefined,
      primaryAsset: item.primaryAsset ?? null,
      variants: [],
    };
    return {
      ...item,
      product: synthesised,
      createdAt: item.createdAt ?? item.addedAt ?? '',
    };
  });
export type WishlistItem = z.infer<typeof wishlistItemSchema>;

export const customerUserSchema = z
  .object({
    id: entityIdSchema,
    email: z.string().email(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    avatarUrl: z.string().url().nullable().optional(),
    locale: z.string().nullable().optional(),
    addresses: z.array(addressSchema).optional(),
  })
  .passthrough();
export type CustomerUser = z.infer<typeof customerUserSchema>;

export const returnStatusSchema = z.enum([
  'REQUESTED',
  'APPROVED',
  'ITEM_RECEIVED',
  'REFUND_PROCESSED',
  'CLOSED',
  'REJECTED',
]);
export type ReturnStatusValue = z.infer<typeof returnStatusSchema>;

export const returnReasonSchema = z.enum([
  'WRONG_SIZE',
  'DEFECTIVE',
  'NOT_AS_DESCRIBED',
  'CHANGED_MIND',
  'OTHER',
]);
export type ReturnReasonValue = z.infer<typeof returnReasonSchema>;

export const returnRefundMethodSchema = z.enum(['ORIGINAL_PAYMENT', 'STORE_CREDIT', 'EXCHANGE']);
export type ReturnRefundMethodValue = z.infer<typeof returnRefundMethodSchema>;

export const returnSchema = z
  .object({
    id: entityIdSchema,
    orderId: entityIdSchema,
    status: returnStatusSchema,
    reason: returnReasonSchema,
    reasonDetail: z.string().nullable().optional(),
    refundMethod: returnRefundMethodSchema.nullable().optional(),
    items: z
      .array(
        z
          .object({
            orderItemId: entityIdSchema,
            quantity: z.number().int().positive(),
            exchangeVariantId: entityIdSchema.nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    createdAt: z.string(),
  })
  .passthrough();
export type Return = z.infer<typeof returnSchema>;

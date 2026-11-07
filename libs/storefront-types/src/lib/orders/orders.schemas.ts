import * as z from 'zod';
import { decimalSchema, orderSchema, orderStatusSchema } from '../shared/entities';

/**
 * Storefront orders schemas. Mirrors:
 * - `apps/api/src/modules/orders/dto/create-order.dto.ts:CreateOrderDto`
 * - `apps/api/src/modules/orders/dto/query-orders.dto.ts:ListOrdersStorefrontDto + TrackOrderDto`
 *
 * `POST /v1/orders` requires `X-Idempotency-Key` (`@OwnerGuard()`); the
 * orders service threads the key through the api-client `idempotencyKey`
 * option per constitution §3.6.
 */

export const orderAddressInputSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(1),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 uppercase'),
});
export type OrderAddressInput = z.infer<typeof orderAddressInputSchema>;

export const createOrderRequestSchema = z
  .object({
    /**
     * Guest checkout: the contact address for an order with no account. The
     * confirmation mail and the track-by-email challenge both key off it, so a
     * guest order without one is unreachable by the person who placed it, and
     * the API refuses it with `ORDER_GUEST_EMAIL_REQUIRED`.
     *
     * The schema strips unknown keys, so a field missing here never reaches
     * the wire however carefully the page assembles it.
     */
    guestEmail: z.string().email().optional(),
    shippingAddressId: z.string().optional(),
    shippingAddress: orderAddressInputSchema.optional(),
    billingAddressId: z.string().optional(),
    billingAddress: orderAddressInputSchema.optional(),
    shippingMethodId: z.string().optional(),
    /**
     * The tender the customer picked, validated server-side against the
     * operator's enabled set. Optional: a store with exactly one enabled
     * method has no ambiguity to resolve, and an old client still places an
     * order there.
     */
    paymentMethodCode: z.string().optional(),
    notes: z.string().optional(),
    /**
     * Eight to twenty, matching the API and the cart's apply schema.
     *
     * This demanded exactly sixteen, the length the generator happens to
     * produce but not the range an operator can issue, so a short
     * operator-issued card applied fine on the cart and was then refused
     * client-side at checkout against a rule the server does not have.
     */
    giftCardCode: z
      .string()
      .regex(/^[A-Z0-9]{8,20}$/, 'gift card code must be 8 to 20 uppercase alphanumerics')
      .optional(),
    couponCode: z.string().optional(),
  })
  .refine((v) => Boolean(v.shippingAddressId) || Boolean(v.shippingAddress), {
    message: 'shippingAddressId or shippingAddress is required',
    path: ['shippingAddress'],
  });
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const listOrdersQuerySchema = z.object({
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
  status: orderStatusSchema.optional(),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

/**
 * The body of `POST /v1/orders/track` (finding K10).
 *
 * The order-number rule mirrors `TrackOrderDto` on the API so a typo is caught
 * before the request leaves the browser rather than coming back as a 400 the
 * page has to translate.
 */
export const trackOrderRequestSchema = z.object({
  orderNumber: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Z0-9-]+$/, 'order number must be uppercase letters, digits and dashes'),
  email: z.string().email(),
});
export type TrackOrderRequest = z.infer<typeof trackOrderRequestSchema>;

/**
 * One shipment row as `GET /v1/orders/:orderNumber/track` sends it
 * (`apps/api/src/modules/orders/orders.service.ts:trackOrder`). Only `id` is
 * guaranteed: a shipment created before a carrier was assigned carries neither
 * carrier nor tracking number, and `deliveredAt` stays null until it lands.
 */
export const trackingShipmentSchema = z
  .object({
    id: z.string(),
    carrier: z.string().nullable().optional(),
    trackingNumber: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    shippedAt: z.string().nullable().optional(),
    deliveredAt: z.string().nullable().optional(),
  })
  .passthrough();
export type TrackingShipment = z.infer<typeof trackingShipmentSchema>;

/**
 * What `POST /v1/orders/track` sends back.
 *
 * `timeline` is real as of plan M phase M2: the API projects
 * `OrderStatusHistory` into `{ status, at }` rows, oldest first. It is the same
 * projection the authed order shape publishes as `statusHistory`.
 *
 * There is no top-level `carrier`, `trackingNumber` or `estimatedDelivery`. The
 * schema used to declare all three and the API has never sent any of them, so a
 * page reading them rendered nothing while looking like it rendered something
 * (finding K11). The real values are on the `shipments` rows.
 */
export const trackingResponseSchema = z
  .object({
    orderNumber: z.string(),
    status: z.string(),
    createdAt: z.string().nullable().optional(),
    paymentStatus: z.string().optional(),
    paymentRetryable: z.boolean().default(false),
    shipments: z.array(trackingShipmentSchema).default([]),
    timeline: z
      .array(
        z
          .object({
            status: z.string(),
            at: z.string(),
            note: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type TrackingResponse = z.infer<typeof trackingResponseSchema>;

export const invoiceResponseSchema = z
  .object({
    orderNumber: z.string(),
    issuedAt: z.string(),
    total: decimalSchema,
    currency: z.string().length(3),
  })
  .passthrough();

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'url must be http or https');

/**
 * What the customer must do next to pay, as `POST /v1/orders` and
 * `POST /v1/orders/:id/payment` send it. Mirrors the API `PaymentAction`.
 * The storefront switches on `type` only and never on the provider, so a new
 * provider needs no change here.
 */
export const paymentActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('redirect'), url: httpUrlSchema }),
  z.object({
    type: z.literal('form_post'),
    url: httpUrlSchema,
    fields: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal('embedded'),
    clientToken: z.string().min(1),
    publicConfig: z.record(z.string(), z.string()).optional(),
  }),
]);
export type PaymentAction = z.infer<typeof paymentActionSchema>;

/** The order a successful `POST /v1/orders` returns, plus the payment step. */
export const placedOrderSchema = orderSchema.extend({
  paymentAction: paymentActionSchema.default({ type: 'none' }),
});
export type PlacedOrder = z.infer<typeof placedOrderSchema>;

export { orderSchema };
export type { Order, OrderLine, OrderStatus, PaymentStatus } from '../shared/entities';

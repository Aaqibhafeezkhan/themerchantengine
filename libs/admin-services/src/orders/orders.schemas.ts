import * as z from 'zod';
import { entityIdSchema, paginationMetaSchema, resolvedStringSchema } from '@admin-types';

/** Prisma enums (superset — backend is the source of truth for transitions). */
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
  /** Terminal state: return fully processed and closed (spec §4.8 H-1). Set by closeReturn(). */
  'RETURNED',
  'REFUNDED',
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/**
 * Mirror of Prisma `enum PaymentStatus` — backend source of truth. `CAPTURED`
 * is the "paid" terminal state in practice; `AUTHORIZED` is the pre-capture
 * hold.
 */
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
 * Mirror of Prisma `enum ShipmentStatus` (prisma/schema.prisma:73-81) as it
 * arrives on the wire. Backend default is PROCESSING; SHIPPED and DELIVERED are
 * terminal, and CANCELLED is written by the order cancel cascade.
 *
 * Read-side only. Leaving CANCELLED out of this enum would make every order the
 * cascade has touched fail `orderSchema.parse` and render as "Could not load".
 */
export const shipmentStatusSchema = z.enum(['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;

/**
 * What an admin may WRITE. CANCELLED is deliberately absent: only the cancel
 * cascade sets it, and `updateShipment` answers 409
 * ORDER_SHIPMENT_ORDER_CLOSED on any attempt to move a row out of it, so
 * accepting it here would only produce a guaranteed failure.
 */
export const writableShipmentStatusSchema = z.enum(['PROCESSING', 'SHIPPED', 'DELIVERED']);
export type WritableShipmentStatus = z.infer<typeof writableShipmentStatusSchema>;

/* List / queries */

export const listOrdersQuerySchema = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  status: orderStatusSchema.optional(),
  paymentStatus: paymentStatusSchema.optional(),
  userId: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

/* Admin manual order creation — mirror of apps/api .../dto/create-admin-order.dto.ts */

export const createAdminOrderItemSchema = z.object({
  variantId: entityIdSchema,
  quantity: z.number().int().positive(),
});
export type CreateAdminOrderItem = z.infer<typeof createAdminOrderItemSchema>;

export const adminOrderAddressSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(1),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().regex(/^[A-Z]{2}$/),
});
export type AdminOrderAddress = z.infer<typeof adminOrderAddressSchema>;

export const createAdminOrderRequestSchema = z.object({
  /** Optional existing customer; omit for a guest / walk-in order. */
  userId: entityIdSchema.optional(),
  items: z.array(createAdminOrderItemSchema).min(1),
  shippingAddress: adminOrderAddressSchema,
  billingAddress: adminOrderAddressSchema.optional(),
  /** Omit to apply the destination zone's default method. */
  shippingMethodId: entityIdSchema.optional(),
  couponCode: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateAdminOrderRequest = z.infer<typeof createAdminOrderRequestSchema>;

/**
 * Money fields are Prisma.Decimal → serialised as strings; we coerce to
 * numbers so downstream consumers do math without surprise. `orderNumber`
 * is the backend's canonical identifier column (human-readable); `number`
 * kept as an alias for legacy callers.
 */
const coercedMoney = z.union([z.number(), z.string().transform((s) => Number(s))]);

/**
 * OrderItem row shape per Prisma `OrderItem` (prisma/schema.prisma:771).
 * Fields map 1:1 to the included relation in `ORDER_INCLUDE.items` at
 * `apps/api/src/modules/orders/orders.service.ts:46`.
 */
export const orderItemSchema = z.object({
  id: entityIdSchema,
  orderId: entityIdSchema.optional(),
  variantId: z.string().nullable().optional(),
  productId: z.string().nullable().optional(),
  /**
   * Admin reads send `X-Resolve-Locale: false` by default
   * (`accept-language.interceptor.ts`), so this Translatable arrives as a raw
   * `{ default, fr, en }` object and binding it directly renders
   * "[object Object]". Reduce it with `pickTranslation` or the `| translatable`
   * pipe before display. `resolvedStringSchema` accepts both forms because the
   * backend still resolves it server-side when a caller opts in.
   */
  productName: resolvedStringSchema.nullable().optional(),
  variantLabel: z.string().nullable().optional(),
  sku: z.string().optional(),
  unitPrice: coercedMoney.optional(),
  quantity: z.number().int(),
  discountAmount: coercedMoney.optional(),
  taxAmount: coercedMoney.optional(),
  total: coercedMoney.optional(),
  weight: coercedMoney.nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  createdAt: z.string().datetime().optional(),
});
export type OrderItem = z.infer<typeof orderItemSchema>;

/**
 * Shipping + billing address snapshot at checkout time.
 * Backend stores as JSONB (prisma/schema.prisma:735) written through
 * `EditOrderDto.shippingAddress` which mirrors this shape.
 */
export const orderAddressSchema = z.object({
  fullName: z.string(),
  phone: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable().optional(),
  city: z.string(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string(),
});
export type OrderAddress = z.infer<typeof orderAddressSchema>;

/**
 * Shipment row per Prisma `Shipment` (prisma/schema.prisma:807). The
 * `items` sub-JSON is a snapshot of `{ orderItemId, quantity }` pairs.
 */
export const orderShipmentSchema = z.object({
  id: entityIdSchema,
  orderId: entityIdSchema.optional(),
  carrier: z.string().nullable().optional(),
  trackingNumber: z.string().nullable().optional(),
  status: shipmentStatusSchema,
  shippedAt: z.string().datetime().nullable().optional(),
  deliveredAt: z.string().datetime().nullable().optional(),
  items: z
    .array(
      z.object({
        orderItemId: z.string(),
        quantity: z.number().int(),
      }),
    )
    .optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type OrderShipment = z.infer<typeof orderShipmentSchema>;

/**
 * Invoice header per Prisma `Invoice` (prisma/schema.prisma:962), included by
 * `ORDER_INCLUDE.invoice` (`apps/api/src/modules/orders/orders.service.ts:98`).
 * Only the identity fields the order detail surfaces are modelled; the full
 * invoice payload has its own endpoint (`GET /orders/:id/invoice`).
 */
export const orderInvoiceSchema = z.object({
  id: entityIdSchema,
  invoiceNumber: z.string().optional(),
  issuedAt: z.string().datetime().optional(),
});
export type OrderInvoice = z.infer<typeof orderInvoiceSchema>;

/**
 * Admin-facing sub-selection of the `User` record attached via
 * `ORDER_INCLUDE.user.select` — the order controller does NOT return the
 * full user, only `{ id, email, firstName, lastName }`.
 */
export const orderUserSchema = z.object({
  id: entityIdSchema,
  email: z.string().email(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
});
export type OrderUser = z.infer<typeof orderUserSchema>;

export const orderSchema = z.object({
  id: entityIdSchema,
  orderNumber: z.string().optional(),
  number: z.string().optional(),
  status: orderStatusSchema,
  paymentStatus: paymentStatusSchema.optional(),
  paymentMethodName: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  subtotal: coercedMoney.optional(),
  discountAmount: coercedMoney.optional(),
  shippingAmount: coercedMoney.optional(),
  shippingMethodName: z.string().nullable().optional(),
  taxAmount: coercedMoney.optional(),
  total: coercedMoney.optional(),
  currency: z.string().length(3).optional(),
  couponCode: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  items: z.array(orderItemSchema).nullable().optional(),
  shippingAddress: orderAddressSchema.nullable().optional(),
  /**
   * Second JSONB snapshot on `Order` (prisma/schema.prisma:871). Already sent
   * by `findOneAdmin`; Zod strip mode was the only thing hiding it.
   */
  billingAddress: orderAddressSchema.nullable().optional(),
  invoice: orderInvoiceSchema.nullable().optional(),
  shipments: z.array(orderShipmentSchema).nullable().optional(),
  /**
   * Single `notes` string on `Order` (prisma/schema.prisma:746) — customer-
   * facing. Admin internal notes live on `internalNotes` separately.
   */
  notes: z.string().nullable().optional(),
  user: orderUserSchema.nullable().optional(),
  _count: z.record(z.string(), z.number()).optional(),
});
export type Order = z.infer<typeof orderSchema>;

export const listOrdersResponseSchema = z.object({
  data: z.array(orderSchema),
  meta: paginationMetaSchema,
});
export type ListOrdersResponse = z.infer<typeof listOrdersResponseSchema>;

/* Mutation bodies */

export const updateOrderStatusRequestSchema = z.object({
  status: orderStatusSchema,
});
export type UpdateOrderStatusRequest = z.infer<typeof updateOrderStatusRequestSchema>;

export const editOrderRequestSchema = z.object({
  addItems: z
    .array(
      z.object({
        variantId: entityIdSchema,
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
  removeItems: z.array(z.object({ orderItemId: entityIdSchema })).optional(),
  shippingAddress: z
    .object({
      fullName: z.string().min(1),
      phone: z.string().min(1),
      addressLine1: z.string().min(1),
      addressLine2: z.string().optional(),
      city: z.string().min(1),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code'),
    })
    .optional(),
  manualDiscount: z.number().nonnegative().optional(),
  internalNotes: z.string().optional(),
});
export type EditOrderRequest = z.infer<typeof editOrderRequestSchema>;

export const createShipmentRequestSchema = z.object({
  items: z
    .array(
      z.object({
        orderItemId: entityIdSchema,
        quantity: z.number().int().positive(),
      }),
    )
    .nonempty(),
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
});
export type CreateShipmentRequest = z.infer<typeof createShipmentRequestSchema>;

export const updateShipmentRequestSchema = z.object({
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
  status: writableShipmentStatusSchema.optional(),
});
export type UpdateShipmentRequest = z.infer<typeof updateShipmentRequestSchema>;

export const addOrderNoteRequestSchema = z.object({
  note: z.string().min(1),
});
export type AddOrderNoteRequest = z.infer<typeof addOrderNoteRequestSchema>;

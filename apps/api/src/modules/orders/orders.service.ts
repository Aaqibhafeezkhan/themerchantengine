// raw-sql-approved: atomic year-partitioned PostgreSQL SEQUENCE generation for
// order + invoice numbers per merchants-engine technical spec §9.4 C4 — see
// specs/decision-records/17-raw-sql-orders-sequence-generation.md. Reviewed by
// db-safety-auditor on 2026-05-15.
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AdjustmentReason,
  OrderStatus,
  PaymentStatus,
  Prisma,
  ReturnStatus,
  ShipmentStatus,
} from '@prisma/client';
import { tryPickVariantUrl } from '@common/asset-variants';
import { lineTotal, roundMoney, sumMoney } from '@common/money';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { CouponInvalidException } from '../promotions/coupon-invalid.exception';
import { PromotionsService } from '../promotions/promotions.service';
import { CartItemDto } from '../promotions/dto/validate-coupon.dto';
import { GiftCardsService } from '../gift-cards/gift-cards.service';
import { ShippingService } from '../shipping/shipping.service';
import type { RateResult } from '../shipping/shipping.service';
import { ShippingUnavailableException } from '../shipping/shipping-unavailable.exception';
import { ShippingMethodInvalidException } from '../shipping/shipping-method-invalid.exception';
import { TaxService } from '../tax/tax.service';
import { CartService } from '../cart/cart.service';
import { IdempotencyService } from '../../common/idempotency.service';
import { STORAGE_DRIVER } from '../assets/assets.constants';
import type { StorageDriver } from '../assets/storage/storage-driver.interface';
import { MoneyFormatterService } from '../currencies/money-formatter.service';
import {
  InvoicePdfService,
  invoiceLocaleOf,
  type InvoicePdfBillingAddress,
  type InvoicePdfSnapshot,
} from './invoice-pdf.service';
import {
  IdempotencyKeyConflictException,
  IdempotencyKeyForbiddenException,
} from '../../common/exceptions/idempotency.exception';
import type { PaginatedResult } from '@common/interceptors/api-response.interceptor';
import { OrderIdempotencyInFlightException } from './order-idempotency-in-flight.exception';
import { OrderGuestCheckoutDisabledException } from './order-guest-checkout-disabled.exception';
import { OrderPaymentMethodInvalidException } from './order-payment-method-invalid.exception';
import { OrderPaymentMethodUnavailableException } from './order-payment-method-unavailable.exception';
import { OrderGuestEmailRequiredException } from './order-guest-email-required.exception';
import { OrderGuestAddressRequiredException } from './order-guest-address-required.exception';
import { OrderGuestSessionRequiredException } from './order-guest-session-required.exception';
import { CheckoutService } from '../checkout/checkout.service';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { PaymentGatewayService } from '../payments/payment-gateway.service';
import type { PaymentAction as ProviderPaymentAction } from '../payments/providers/payment-provider.interface';
import { OrderPaymentNotRetryableException } from './order-payment-not-retryable.exception';
import type { PaymentWebhookEvent } from '../payments/providers/payment-provider.interface';
import { PaymentTransitionNotAllowedException } from '../payments/payment-transition-not-allowed.exception';
import { OrderPaymentNotOpenedException } from './order-payment-not-opened.exception';
import { OrderCartEmptyException } from './order-cart-empty.exception';
import { OrderInsufficientStockException } from './order-insufficient-stock.exception';
import { OrderCancelIneligibleException } from './order-cancel-ineligible.exception';
import { OrderCancelShipmentInTransitException } from './order-cancel-shipment-in-transit.exception';
import { OrderShipmentOrderClosedException } from './order-shipment-order-closed.exception';
import { OrderInvoiceNotReadyException } from './order-invoice-not-ready.exception';
import { OrderNotFoundException } from './order-not-found.exception';
import { OrderNothingToRefundException } from './order-nothing-to-refund.exception';
import { OrderNotYoursException } from './order-not-yours.exception';
import { OrderEditInsufficientStockException } from './order-edit-insufficient-stock.exception';
import { toCustomerOrder, toCustomerStatusHistory, toNum } from './orders.serializer';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { CreateAdminOrderDto } from './dto/create-admin-order.dto';
import type { EditOrderDto } from './dto/edit-order.dto';
import type { CreateShipmentDto } from './dto/create-shipment.dto';
import type { UpdateShipmentDto } from './dto/update-shipment.dto';
import type { ListOrdersStorefrontDto, ListOrdersAdminDto } from './dto/query-orders.dto';
import { buildVariantLabel } from '@common/utils';
import { parseLocale, resolveTranslatable } from '@common/interceptors';
import { storefrontBaseUrl } from '../mail/config/public-hosts';
import { resolveLocale } from '../mail/listeners/locale.util';
import {
  ORDER_NUMBER_PREFIX,
  INVOICE_NUMBER_PREFIX,
  STATUS_TRANSITIONS,
  EDITABLE_STATUSES,
  CUSTOMER_CANCELLABLE,
  CLOSED_STATUSES,
  IN_FULFILMENT,
  VALID_ADMIN_ORDER_SORT_FIELDS,
  ORDER_EVENTS,
} from './orders.constants';

/**
 * Recognises the "object does not exist" signal across storage drivers so a
 * first-download can fall through to render+save. Per the StorageDriver
 * contract: local throws `ENOENT`, S3 throws `NoSuchKey` (or a 404 in
 * `$metadata`). Any other error (creds, network) propagates.
 */
function isStorageNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.code === 'ENOENT' ||
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.$metadata?.httpStatusCode === 404
  );
}

const IDEMPOTENCY_SCOPE = 'orders';
const PAYMENT_IDEMPOTENCY_SCOPE = 'orders:payment';

/**
 * True only for ORDER_STATUS_TRANSITION_INVALID, the error a lost status race
 * produces. Deliberately narrow: anything else must keep propagating.
 */
function isTransitionInvalid(err: unknown): boolean {
  const response = (err as { response?: { error?: { code?: unknown } } })?.response;
  return response?.error?.code === 'ORDER_STATUS_TRANSITION_INVALID';
}

// ── Prisma include shapes ────────────────────────────────────────────────────

const ORDER_INCLUDE = {
  items: true,
  shipments: true,
  invoice: true,
  // Oldest first: this is a timeline, and every consumer reads it in that
  // direction (finding AD6). `createdAt` is timestamp(3), so two transitions
  // inside one millisecond would otherwise order arbitrarily; `id` is only a
  // weakly monotonic tiebreaker, but it makes the order deterministic.
  statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
} as const satisfies Prisma.OrderInclude;

type PaymentAction = 'capture' | 'refund' | 'cancel';

const PAYMENT_AUDIT_ACTIONS: Record<PaymentAction, string> = {
  capture: 'order.payment_captured',
  refund: 'order.payment_refunded',
  cancel: 'order.payment_cancelled',
};

const WEBHOOK_FORWARD_MOVES: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED'],
  AUTHORIZED: ['CAPTURED', 'FAILED', 'CANCELLED'],
  CAPTURED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  FAILED: [],
  REFUNDED: [],
  CANCELLED: [],
};

const ORDER_LIST_SELECT = {
  id: true,
  orderNumber: true,
  userId: true,
  status: true,
  paymentStatus: true,
  subtotal: true,
  discountAmount: true,
  shippingAmount: true,
  taxAmount: true,
  total: true,
  currency: true,
  couponCode: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
  _count: { select: { items: true, shipments: true } },
} as const;

/**
 * `ORDER_LIST_SELECT` minus `userId` and the `user` relation. The customer
 * order list is scoped to one owner by `where: { userId }`, so echoing the
 * owner back on every row is admin-shape payload the storefront never reads
 * (plan J, finding AD2).
 */
const CUSTOMER_ORDER_LIST_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  subtotal: true,
  discountAmount: true,
  shippingAmount: true,
  taxAmount: true,
  total: true,
  currency: true,
  couponCode: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true, shipments: true } },
} as const;

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly promotions: PromotionsService,
    private readonly giftCards: GiftCardsService,
    private readonly shipping: ShippingService,
    private readonly tax: TaxService,
    private readonly cart: CartService,
    private readonly events: EventEmitter2,
    private readonly idempotency: IdempotencyService,
    private readonly checkout: CheckoutService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly invoicePdf: InvoicePdfService,
    private readonly money: MoneyFormatterService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // ORDER CREATION (§4.8 + §9.4 C1/C4 + §9.5 I1)
  // ═══════════════════════════════════════════════════════════════════════════

  async createOrder(
    dto: CreateOrderDto,
    userId: string | undefined,
    idempotencyKey: string,
    acceptLanguage?: string,
    sessionId?: string,
  ): Promise<unknown> {
    // ── 0. Guest gate (plan F, finding K3) ──────────────────────────────
    //
    // A missing userId is the whole signal: the controller is `@OptionalAuth()`
    // and hands us whatever the session resolved to. Everything below this
    // block is the path an authenticated customer has always taken, byte for
    // byte, because `isGuest` is false for them and each guest-only branch is
    // guarded on it.
    //
    // The flag is read FIRST, before the cart, so the refusal a visitor gets
    // does not depend on what is in their basket.
    // The locale the line labels are snapshotted in. `variantLabel` is a plain
    // text column, so it is resolved once here rather than by the response
    // interceptor (finding AD2).
    const labelLocale = parseLocale(acceptLanguage);

    const isGuest = !userId;
    let guestEmail: string | null = null;
    let guestLocale: string | null = null;
    if (isGuest) {
      const settings = await this.checkout.getSettings();
      if (!settings.guestCheckoutEnabled) throw new OrderGuestCheckoutDisabledException();

      const rawEmail = (dto as { guestEmail?: string }).guestEmail;
      const normalized = rawEmail?.trim().toLowerCase();
      if (!normalized) throw new OrderGuestEmailRequiredException();
      // Normalised at the door so the track page's email challenge, which
      // compares what the customer retypes, can match what we stored.
      guestEmail = normalized;

      // A guest owns no saved addresses, so `shippingAddressId` cannot resolve
      // to one. Without this, `resolveAddress` falls through to its empty
      // default and the order is created against an address nobody gave us.
      if (!dto.shippingAddress) throw new OrderGuestAddressRequiredException();

      // A guest with no cart session has no cart to buy from, and no identity
      // to bind their idempotency key to. Refused explicitly rather than
      // falling back to a shared sentinel, which would give every cookieless
      // guest the same caller hash.
      if (!sessionId) throw new OrderGuestSessionRequiredException();

      // There is no user row to read a locale from, so capture the request's.
      guestLocale = resolveLocale(acceptLanguage);
    }

    // ── 1. Idempotency check (§9.5 I1) — atomic SET NX with caller + body binding ─
    // Guests bind to their cart session. Hashing a bare `undefined` would give
    // every guest in the world the same caller hash, so one shopper's key would
    // collide with another's.
    const callerHash = IdempotencyService.sha256Hex(userId ?? `guest:${sessionId}`);
    const bodyHash = IdempotencyService.sha256Hex(IdempotencyService.stableStringify(dto));
    const idempotencyArgs = {
      scope: IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      callerHash,
      bodyHash,
    };
    const beginResult = await this.idempotency.beginRequest(idempotencyArgs);
    switch (beginResult.state) {
      case 'cached':
        this.logger.log(
          `Idempotent hit: keyHash=${IdempotencyService.shortKeyHash(idempotencyKey)}`,
        );
        return beginResult.cachedResponse;
      case 'forbidden':
        throw new IdempotencyKeyForbiddenException();
      case 'conflict':
        throw new IdempotencyKeyConflictException();
      case 'in-flight':
        // First request still processing — keep the storefront error
        // shape stable so existing 409 catches stay correct.
        throw new OrderIdempotencyInFlightException();
      case 'fresh':
        break;
    }

    // All steps below must clean up the idempotency sentinel on failure.
    const decrementedItems: { variantId: string; quantity: number }[] = [];
    let createdOrderId: string | null = null;
    let openedSession: { methodCode: string; reference: string; status: PaymentStatus } | undefined;

    try {
      // ── 2. Load and validate cart ─────────────────────────────────────
      // Branched rather than passing `undefined` through on the authed path,
      // so a signed-in customer's call is the same call it has always been.
      const cartData = isGuest
        ? await this.cart.getCart(undefined, sessionId)
        : await this.cart.getCart(userId);
      if (!cartData.items.length) {
        throw new OrderCartEmptyException();
      }

      // Verify all items in stock
      const outOfStock = cartData.items.filter((i) => !i.inStock);
      if (outOfStock.length) {
        throw new OrderInsufficientStockException();
      }

      // ── 3. Resolve addresses ────────────────────────────────────────────
      const shippingAddress = await this.resolveAddress(
        dto.shippingAddress as unknown as Record<string, unknown> | undefined,
        dto.shippingAddressId,
        userId,
      );
      const billingAddress =
        dto.billingAddress || dto.billingAddressId
          ? await this.resolveAddress(
              dto.billingAddress as unknown as Record<string, unknown> | undefined,
              dto.billingAddressId,
              userId,
            )
          : shippingAddress;

      // ── 4. Calculate shipping + tax ─────────────────────────────────────
      const shippingItems = cartData.items.map((i) => ({
        weight: i.weight ?? 0,
        quantity: i.quantity,
      }));

      const country = (shippingAddress as Record<string, string>).country;
      const postalCode = (shippingAddress as Record<string, string>).postalCode;

      const shippingRates = await this.shipping.calculateRates({
        country,
        postalCode,
        items: shippingItems,
        subtotal: cartData.subtotal,
      });

      // Select the explicitly-requested method, else the zone's default. An
      // unmatched explicit id, or a destination with no rates while the store
      // DOES have active zones, is an error — never a silent free-shipping order
      // (the historical `shippingRates[0]` / undefined-→-0 behaviour).
      let selected: RateResult | null = null;
      if (dto.shippingMethodId) {
        selected = shippingRates.find((r) => r.methodId === dto.shippingMethodId) ?? null;
        if (!selected) throw new ShippingMethodInvalidException();
      } else {
        selected = this.shipping.resolveDefaultRate(shippingRates); // null iff no rates
        if (!selected && (await this.shipping.hasActiveZones())) {
          throw new ShippingUnavailableException();
        }
      }

      // The order column is plain text, not Translatable JSONB, so the name is
      // captured in the locale the customer was checking out in: an order
      // placed on the French storefront keeps the French name.
      //
      // Through the canonical resolver (3.14), not a local copy. The copy that
      // used to live here fell back locale, default, en, so a row whose
      // `default` differs from both localised strings snapshotted a different
      // string than the response interceptor resolves for that same row.
      let shippingAmount = 0;
      let shippingMethodName: string | null = null;
      if (selected) {
        shippingAmount = selected.price;
        shippingMethodName = resolveTranslatable(selected.name, resolveLocale(acceptLanguage));
      }

      // ── 4b. Resolve the payment method (plan F, findings K2, D2) ────────
      //
      // The enabled set is read here, not trusted from the client: a method
      // disabled between page load and submit must not still take an order.
      // Same snapshot pattern as `shippingMethodName` above, and for the same
      // reason: the column is plain text, outside the locale interceptor's
      // reach, so the name is resolved at write time.
      const enabledMethods = await this.paymentMethods.listStorefront();
      if (enabledMethods.length === 0) throw new OrderPaymentMethodUnavailableException();
      let paymentMethod = enabledMethods[0];
      if (dto.paymentMethodCode) {
        const match = enabledMethods.find((m) => m.code === dto.paymentMethodCode);
        if (!match) throw new OrderPaymentMethodInvalidException();
        paymentMethod = match;
      } else if (enabledMethods.length > 1) {
        // One offered tender has no ambiguity to resolve, so an old client
        // still places an order. Several do, and picking for the customer is
        // exactly the silent-COD defect this replaces.
        throw new OrderPaymentMethodInvalidException('A payment method must be selected');
      }
      const paymentMethodName = resolveTranslatable(
        paymentMethod.name,
        resolveLocale(acceptLanguage),
      );

      // ── 5. Re-validate coupon if present ────────────────────────────────
      let couponCode = dto.couponCode ?? cartData.couponCode ?? null;
      let couponPromotion: { promotionId: string; discountAmount: number } | null = null;

      // Build promo items from cart.
      //
      // These carried empty ids, described as "not needed for amount-based
      // promos", while the cart built real ones. Any promotion restricted to
      // certain products or categories therefore applied in the cart and
      // silently evaporated at order create, which is how a cart total and an
      // order total drift apart. The cart response now carries both ids, so
      // the two evaluations read the same line by construction.
      const promoItems: CartItemDto[] = cartData.items.map((i) => ({
        productId: i.productId,
        categoryId: i.categoryId ?? '',
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      }));

      if (couponCode) {
        try {
          const validated = await this.promotions.validateCoupon(
            couponCode,
            cartData.subtotal,
            promoItems,
            userId,
          );
          couponPromotion = {
            promotionId: validated.promotionId,
            discountAmount: validated.discountAmount,
          };
        } catch (err) {
          // A code the caller typed must not vanish: charging full price with
          // no hint is worse than an error they can act on. A code that only
          // sits on the cart, and died since, is dropped like a dead gift card.
          if (dto.couponCode && err instanceof CouponInvalidException) throw err;
          couponCode = null;
        }
      }

      // Compute discount from automatic promotions + coupon
      const autoDiscounts = await this.promotions.getApplicableAutomatic(
        cartData.subtotal,
        promoItems,
        userId,
      );
      const autoDiscountTotal = sumMoney(autoDiscounts.map((d) => d.discountAmount));
      const couponDiscountAmount = couponPromotion?.discountAmount ?? 0;
      const totalDiscount = sumMoney([autoDiscountTotal, couponDiscountAmount]);

      // Honour a FREE_SHIPPING promotion. The engine returns it with a zero
      // discount amount and calls it a signal to be applied at checkout; this
      // is that checkout, and nothing here read the signal, so a cart showing
      // "free shipping, qualified" was charged the full rate on placement.
      //
      // The method name is kept: the shopper still gets that delivery, free.
      // Usage recording is untouched, since the entry already flows through
      // with amount 0.
      if (autoDiscounts.some((d) => d.type === 'FREE_SHIPPING')) {
        shippingAmount = 0;
      }

      // VAT applies to the goods total AFTER discount, per `plan.md` §2.7.
      // This call used to sit in the Promise.all sixty lines above, next to the
      // shipping rates, where `totalDiscount` did not exist yet — so the tax
      // base was the PRE-discount subtotal and every discounted order was
      // over-charged VAT. Invisible while the seeded rate was 0.0; a money
      // defect at 19 per cent. Shipping stays outside the base, which is the
      // engine's existing treatment and is recorded as a decision rather than
      // an oversight.
      const taxableBase = Math.max(0, roundMoney(cartData.subtotal - totalDiscount));
      const taxResult = await this.tax.calculateTax(country, null, taxableBase);
      const taxAmount = taxResult.amount;

      const preGiftCardTotal = Math.max(0, sumMoney([taxableBase, shippingAmount, taxAmount]));

      // ── 5b. Validate gift card and compute partial discount (spec §4.9, §4.12) ─
      // Store credit is applied up to the available balance; the remainder is
      // treated as cash-on-delivery. This prevents checkout failure when the
      // gift card balance is less than the full order total.
      //
      // The cart is the fallback source, mirroring `couponCode` above. Before
      // the card was persisted on the cart there was no fallback, so a shopper
      // who applied a card on the cart page paid full price: the checkout
      // payload spread a field the backend never emitted, and `dto.giftCardCode`
      // arrived undefined every time. `??` rather than a sum, so a code sent
      // explicitly and a code on the cart cannot both be counted.
      //
      // `preGiftCardTotal` is the same base the cart caps its displayed
      // `balanceApplied` against, so what the shopper saw is what is deducted,
      // recomputed here from the real shipping and tax rather than estimates.
      let giftCardCode = dto.giftCardCode ?? cartData.giftCard?.code ?? null;
      let giftCardDiscount = 0;
      if (giftCardCode) {
        try {
          const cardBalance = await this.giftCards.checkBalance(giftCardCode);
          giftCardDiscount = Math.min(cardBalance.currentBalance, preGiftCardTotal);
        } catch (err) {
          // A card that died between the cart page and checkout, expired,
          // emptied by another order or deactivated, must not block the order:
          // drop it, exactly as an invalid coupon is dropped above. A code the
          // caller named explicitly is different — they asked for that card,
          // so they get the error rather than a silently larger bill.
          if (dto.giftCardCode) throw err;
          giftCardCode = null;
        }
      }

      const orderTotal = Math.max(0, roundMoney(preGiftCardTotal - giftCardDiscount));

      // ── 6. Generate order number (§9.4 C4) ──────────────────────────────
      const orderNumber = await this.generateOrderNumber();

      // ── 7. Fetch full variant/product data for snapshots ────────────────
      const variantIds = cartData.items.map((i) => i.variantId);
      const variants = await this.prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: {
          id: true,
          sku: true,
          price: true,
          weight: true,
          productId: true,
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              assets: {
                where: { isPrimary: true },
                take: 1,
                select: {
                  asset: { select: { id: true, status: true, variants: true } },
                },
              },
            },
          },
          attributeValues: {
            orderBy: [{ attributeValue: { sortOrder: 'asc' } }, { attributeValueId: 'asc' }],
            select: { attributeValue: { select: { value: true } } },
          },
        },
      });
      const variantMap = new Map(variants.map((v) => [v.id, v]));

      // ── 8. Atomic stock decrement (§9.4 C1) ────────────────────────────
      // Each item's stock is decremented atomically.
      // If any fails, the catch block rolls back previously decremented items.
      for (const item of cartData.items) {
        const success = await this.inventory.decrementStock(item.variantId, item.quantity, {
          referenceType: 'Order',
          performedBy: userId,
        });
        if (!success) {
          throw new OrderInsufficientStockException(item.variantId);
        }
        decrementedItems.push({ variantId: item.variantId, quantity: item.quantity });
      }

      // ── 9. Create order record ────────────────────────────────────────
      const order = await this.prisma.order.create({
        data: {
          orderNumber,
          // Explicitly null rather than undefined: an order belongs to a user
          // OR to a guest, and the guest columns below say which.
          userId: userId ?? null,
          guestEmail,
          guestSessionId: isGuest ? (sessionId ?? null) : null,
          guestLocale,
          status: OrderStatus.PENDING,
          // The store currency from the runtime config, written at order time so
          // the row keeps it if the store changes currency later (DR-31).
          currency: this.money.currencyCode(),
          shippingAddress: shippingAddress as Prisma.InputJsonValue,
          billingAddress: billingAddress as Prisma.InputJsonValue,
          subtotal: cartData.subtotal,
          discountAmount: sumMoney([totalDiscount, giftCardDiscount]),
          shippingAmount,
          taxAmount,
          total: orderTotal,
          shippingMethodName,
          paymentMethodCode: paymentMethod.code,
          paymentMethodName,
          notes: dto.notes ?? null,
          couponCode,
          idempotencyKey,
          // The birth row, nested so it shares the order's own write. Every
          // order starts PENDING and there is no prior state (finding AD6).
          statusHistory: { create: { toStatus: OrderStatus.PENDING } },
          items: {
            create: cartData.items.map((item) => {
              const variant = variantMap.get(item.variantId);
              return {
                variantId: item.variantId,
                productId: variant?.productId ?? null,
                productName: variant?.product.name ?? { default: item.productName },
                variantLabel:
                  buildVariantLabel(variant?.attributeValues, labelLocale) ??
                  item.variantLabel ??
                  null,
                sku: variant?.sku ?? '',
                unitPrice: item.unitPrice,
                quantity: item.quantity,
                total: lineTotal(item.unitPrice, item.quantity),
                weight: item.weight ?? null,
                thumbnailUrl:
                  tryPickVariantUrl(variant?.product.assets[0]?.asset, 'thumbnail')?.url ??
                  item.thumbnailUrl ??
                  null,
              };
            }),
          },
        },
        include: ORDER_INCLUDE,
      });
      createdOrderId = order.id;

      // ── 9b. Open the payment session (DR-34) ──────────────────────────
      // Before any promotion or gift card is spent: the catch below undoes the
      // order and the stock, not those.
      const session = await this.paymentGateway.openSession(paymentMethod.code, {
        orderId: order.id,
        amount: new Prisma.Decimal(orderTotal),
        currencyCode: order.currency,
        returnUrl: this.paymentReturnUrl(order.orderNumber, acceptLanguage),
        customerEmail: guestEmail ?? (await this.accountEmail(userId)),
      });
      openedSession = {
        methodCode: paymentMethod.code,
        reference: session.reference,
        status: session.status,
      };
      await this.prisma.order.update({
        where: { id: order.id },
        data: { paymentReference: session.reference, paymentStatus: session.status },
      });
      const placedOrder = {
        ...order,
        paymentReference: session.reference,
        paymentStatus: session.status,
      };

      // ── 10. Record promotion usage ──────────────────────────────────────
      for (const auto of autoDiscounts) {
        await this.promotions.recordUsage(auto.promotionId, order.id, auto.discountAmount, userId);
      }
      if (couponPromotion) {
        await this.promotions.recordUsage(
          couponPromotion.promotionId,
          order.id,
          couponPromotion.discountAmount,
          userId,
        );
      }

      // ── 11. Deduct gift card balance if applied ─────────────────────────
      if (giftCardCode && giftCardDiscount > 0) {
        await this.giftCards.redeem(giftCardCode, giftCardDiscount, order.id, order.currency);
      }

      // ── 12. Clear the cart ──────────────────────────────────────────────
      // `clearCart` also drops the applied gift card, which would otherwise be
      // re-applied to this shopper's next order. A guest's cart lives under the
      // session id, so it has to be cleared by that key or the basket survives
      // the purchase and the next visit re-buys it.
      if (isGuest) {
        await this.cart.clearCart(undefined, sessionId);
      } else {
        await this.cart.clearCart(userId);
      }

      // ── 13. Upgrade idempotency sentinel → cached response (24h TTL) ─
      // Serialized BEFORE it is cached: a replay within the 24h TTL returns
      // this payload verbatim, so caching the raw row would keep leaking
      // admin fields for a day after the fix.
      // The action is not stored on the order: it carries a short-lived client
      // token. A shopper who needs a new one retries the payment.
      const customerOrder = { ...toCustomerOrder(placedOrder), paymentAction: session.action };
      await this.idempotency.completeRequest({
        ...idempotencyArgs,
        entityId: order.id,
        responseJson: customerOrder,
      });

      // ── 14. Emit event ──────────────────────────────────────────────────
      this.events.emit(ORDER_EVENTS.CREATED, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        userId,
        total: orderTotal,
      });

      this.logger.log(
        `Order created: orderNumber=${orderNumber} userId=${userId} total=${orderTotal}`,
      );

      return customerOrder;
    } catch (error) {
      // Release the idempotency sentinel so the client can retry
      await this.idempotency.abortRequest({
        scope: IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        callerHash,
      });

      // Cancel the provider session so no payment can land on a deleted order
      if (openedSession) {
        try {
          await this.paymentGateway.cancel(openedSession.methodCode, {
            reference: openedSession.reference,
            status: openedSession.status,
            idempotencyKey: `checkout-cancel:${createdOrderId}`,
          });
        } catch (cancelErr) {
          this.logger.error(
            `Failed to cancel payment session ${openedSession.reference}: ${(cancelErr as Error).message}`,
          );
        }
      }

      // Delete orphaned order if it was persisted before the failure
      if (createdOrderId) {
        try {
          await this.deleteUnplacedOrder(createdOrderId);
        } catch (deleteErr) {
          this.logger.error(
            `Failed to delete orphaned order ${createdOrderId}: ${(deleteErr as Error).message}`,
          );
        }
      }

      // Rollback stock decrements
      for (const dec of decrementedItems) {
        try {
          await this.inventory.incrementStock(
            dec.variantId,
            dec.quantity,
            AdjustmentReason.CORRECTION,
            {
              referenceType: 'OrderRollback',
              performedBy: userId,
            },
          );
        } catch (rollbackErr) {
          this.logger.error(
            `Failed to rollback stock for variant=${dec.variantId}: ${(rollbackErr as Error).message}`,
          );
        }
      }
      throw error;
    }
  }

  /**
   * Rollback delete for an order that never finished placement. `OrderItem.order`
   * is `onDelete: Restrict`, so the lines go first, in one transaction with the
   * order. Status history cascades on its own.
   */
  private async deleteUnplacedOrder(orderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId } });
      await tx.order.delete({ where: { id: orderId } });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN MANUAL ORDER CREATION (§4.8) — operator-placed (phone / walk-in) orders
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates an order from operator-supplied line items rather than a cart. Shares
   * the storefront pipeline's invariants — idempotency (§9.5 I1), atomic stock
   * decrement (§9.4 C1), default-aware shipping, snapshot persistence, and
   * compensating rollback on failure. The customer link is optional (guest /
   * walk-in). Automatic promotions and gift cards are intentionally out of scope:
   * a manual order is explicit, so only an optional coupon discount is honoured.
   */
  async createManualOrder(
    dto: CreateAdminOrderDto,
    adminUserId: string,
    idempotencyKey: string,
    acceptLanguage?: string,
  ): Promise<unknown> {
    // The locale the line labels are snapshotted in. `variantLabel` is a plain
    // text column, so it is resolved once here rather than by the response
    // interceptor (finding AD2).
    const labelLocale = parseLocale(acceptLanguage);

    // ── 1. Idempotency check (§9.5 I1), bound to the acting admin ─────────────
    const callerHash = IdempotencyService.sha256Hex(adminUserId);
    const bodyHash = IdempotencyService.sha256Hex(IdempotencyService.stableStringify(dto));
    const idempotencyArgs = { scope: IDEMPOTENCY_SCOPE, key: idempotencyKey, callerHash, bodyHash };
    const beginResult = await this.idempotency.beginRequest(idempotencyArgs);
    switch (beginResult.state) {
      case 'cached':
        return beginResult.cachedResponse;
      case 'forbidden':
        throw new IdempotencyKeyForbiddenException();
      case 'conflict':
        throw new IdempotencyKeyConflictException();
      case 'in-flight':
        throw new OrderIdempotencyInFlightException();
      case 'fresh':
        break;
    }

    const decrementedItems: { variantId: string; quantity: number }[] = [];
    let createdOrderId: string | null = null;

    try {
      // ── 2. Validate the optional customer link ──────────────────────────────
      if (dto.userId) {
        const customer = await this.prisma.user.findFirst({
          where: { id: dto.userId, deletedAt: null },
          select: { id: true },
        });
        if (!customer) {
          throw new BadRequestException({
            error: { code: 'ORDER_CUSTOMER_NOT_FOUND', message: 'Customer not found' },
          });
        }
      }

      // ── 3. Load + snapshot variants from the supplied line items ────────────
      const variantIds = [...new Set(dto.items.map((i) => i.variantId))];
      const variants = await this.prisma.productVariant.findMany({
        where: { id: { in: variantIds }, deletedAt: null },
        select: {
          id: true,
          sku: true,
          price: true,
          weight: true,
          isActive: true,
          productId: true,
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              deletedAt: true,
              categories: { take: 1, select: { categoryId: true } },
              assets: {
                where: { isPrimary: true },
                take: 1,
                select: { asset: { select: { id: true, status: true, variants: true } } },
              },
            },
          },
          attributeValues: {
            orderBy: [{ attributeValue: { sortOrder: 'asc' } }, { attributeValueId: 'asc' }],
            select: { attributeValue: { select: { value: true } } },
          },
        },
      });
      const variantMap = new Map(variants.map((v) => [v.id, v]));

      const lineItems = dto.items.map((item) => {
        const variant = variantMap.get(item.variantId);
        if (!variant || !variant.isActive || variant.product.deletedAt) {
          throw new BadRequestException({
            error: {
              code: 'ORDER_VARIANT_NOT_FOUND',
              message: `Variant "${item.variantId}" not found or unavailable`,
            },
          });
        }
        const unitPrice = toNum(variant.price);
        return {
          variant,
          variantId: item.variantId,
          quantity: item.quantity,
          unitPrice,
          lineTotal: lineTotal(unitPrice, item.quantity),
          weight: variant.weight ? toNum(variant.weight) : 0,
        };
      });

      const subtotal = sumMoney(lineItems.map((li) => li.lineTotal));

      // ── 4. Resolve address snapshots (inline, operator-supplied) ────────────
      const shippingAddress = await this.resolveAddress(
        dto.shippingAddress as unknown as Record<string, unknown>,
      );
      const billingAddress = dto.billingAddress
        ? await this.resolveAddress(dto.billingAddress as unknown as Record<string, unknown>)
        : shippingAddress;

      const country = (shippingAddress as Record<string, string>).country;
      const postalCode = (shippingAddress as Record<string, string>).postalCode;

      // ── 5. Shipping (default-aware). Tax comes later, once the coupon is
      // known, because the VAT base is the discounted goods total (§2.7).
      const shippingRates = await this.shipping.calculateRates({
        country,
        postalCode,
        items: lineItems.map((li) => ({ weight: li.weight, quantity: li.quantity })),
        subtotal,
      });

      let selected: RateResult | null = null;
      if (dto.shippingMethodId) {
        selected = shippingRates.find((r) => r.methodId === dto.shippingMethodId) ?? null;
        if (!selected) throw new ShippingMethodInvalidException();
      } else {
        selected = this.shipping.resolveDefaultRate(shippingRates);
        if (!selected && (await this.shipping.hasActiveZones())) {
          throw new ShippingUnavailableException();
        }
      }
      let shippingAmount = 0;
      let shippingMethodName: string | null = null;
      if (selected) {
        shippingAmount = selected.price;
        shippingMethodName = resolveTranslatable(selected.name, resolveLocale(acceptLanguage));
      }
      // ── 6. Optional coupon (no automatic promos / gift cards on manual orders) ─
      let couponCode = dto.couponCode ?? null;
      let couponPromotion: { promotionId: string; discountAmount: number } | null = null;
      if (couponCode) {
        // Same eligibility parity as the customer path. Automatic promotions
        // are deliberately out of scope for a manual order, so there is no
        // FREE_SHIPPING signal to honour here, but a product- or
        // category-restricted coupon must still resolve against the real line.
        const promoItems: CartItemDto[] = lineItems.map((li) => ({
          productId: li.variant.productId,
          categoryId: li.variant.product.categories[0]?.categoryId ?? '',
          quantity: li.quantity,
          unitPrice: li.unitPrice,
        }));
        try {
          const validated = await this.promotions.validateCoupon(
            couponCode,
            subtotal,
            promoItems,
            dto.userId,
          );
          couponPromotion = {
            promotionId: validated.promotionId,
            discountAmount: validated.discountAmount,
          };
        } catch (err) {
          // The admin named this code on purpose, so a dead one is an error.
          if (err instanceof CouponInvalidException) throw err;
          couponCode = null;
        }
      }
      const totalDiscount = couponPromotion?.discountAmount ?? 0;
      const taxableBase = Math.max(0, roundMoney(subtotal - totalDiscount));
      const taxResult = await this.tax.calculateTax(country, null, taxableBase);
      const taxAmount = taxResult.amount;
      const orderTotal = Math.max(0, sumMoney([taxableBase, shippingAmount, taxAmount]));

      // ── 7. Order number + atomic stock decrement (§9.4 C1/C4) ───────────────
      const orderNumber = await this.generateOrderNumber();

      for (const li of lineItems) {
        const success = await this.inventory.decrementStock(li.variantId, li.quantity, {
          referenceType: 'Order',
          performedBy: adminUserId,
        });
        if (!success) throw new OrderInsufficientStockException(li.variantId);
        decrementedItems.push({ variantId: li.variantId, quantity: li.quantity });
      }

      // ── 8. Persist the order ────────────────────────────────────────────────
      const order = await this.prisma.order.create({
        data: {
          orderNumber,
          ...(dto.userId ? { user: { connect: { id: dto.userId } } } : {}),
          status: OrderStatus.PENDING,
          // The store currency from the runtime config, written at order time so
          // the row keeps it if the store changes currency later (DR-31).
          currency: this.money.currencyCode(),
          shippingAddress: shippingAddress as Prisma.InputJsonValue,
          billingAddress: billingAddress as Prisma.InputJsonValue,
          subtotal,
          discountAmount: totalDiscount,
          shippingAmount,
          shippingMethodName,
          taxAmount,
          total: orderTotal,
          notes: dto.notes ?? null,
          couponCode,
          idempotencyKey,
          // Same birth row on the admin manual-order path.
          statusHistory: { create: { toStatus: OrderStatus.PENDING } },
          items: {
            create: lineItems.map((li) => ({
              variantId: li.variantId,
              productId: li.variant.productId,
              productName: li.variant.product.name as Prisma.InputJsonValue,
              variantLabel: buildVariantLabel(li.variant.attributeValues, labelLocale),
              sku: li.variant.sku,
              unitPrice: li.unitPrice,
              quantity: li.quantity,
              total: li.lineTotal,
              weight: li.weight,
              thumbnailUrl:
                tryPickVariantUrl(li.variant.product.assets[0]?.asset, 'thumbnail')?.url ?? null,
            })),
          },
        },
        include: ORDER_INCLUDE,
      });
      createdOrderId = order.id;

      // ── 9. Record coupon usage ──────────────────────────────────────────────
      if (couponPromotion) {
        await this.promotions.recordUsage(
          couponPromotion.promotionId,
          order.id,
          couponPromotion.discountAmount,
          dto.userId,
        );
      }

      // ── 10. Idempotency complete (24h TTL) + event ──────────────────────────
      await this.idempotency.completeRequest({
        ...idempotencyArgs,
        entityId: order.id,
        responseJson: order,
      });
      this.events.emit(ORDER_EVENTS.CREATED, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        userId: dto.userId ?? null,
        total: orderTotal,
      });
      this.logger.log(
        `Manual order created: orderNumber=${orderNumber} admin=${adminUserId} total=${orderTotal}`,
      );
      return order;
    } catch (error) {
      await this.idempotency.abortRequest({
        scope: IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        callerHash,
      });
      if (createdOrderId) {
        try {
          await this.deleteUnplacedOrder(createdOrderId);
        } catch (deleteErr) {
          this.logger.error(
            `Failed to delete orphaned manual order ${createdOrderId}: ${(deleteErr as Error).message}`,
          );
        }
      }
      for (const dec of decrementedItems) {
        try {
          await this.inventory.incrementStock(
            dec.variantId,
            dec.quantity,
            AdjustmentReason.CORRECTION,
            { referenceType: 'OrderRollback', performedBy: adminUserId },
          );
        } catch (rollbackErr) {
          this.logger.error(
            `Failed to rollback stock for variant=${dec.variantId}: ${(rollbackErr as Error).message}`,
          );
        }
      }
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS LIFECYCLE (§4.8)
  // ═══════════════════════════════════════════════════════════════════════════

  async updateStatus(
    orderId: string,
    newStatus: OrderStatus,
    performedBy: string,
  ): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        orderNumber: true,
        userId: true,
        paymentMethodCode: true,
        paymentReference: true,
        paymentStatus: true,
      },
    });
    if (!order) throw new OrderNotFoundException(orderId);

    const allowed = STATUS_TRANSITIONS[order.status];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException({
        error: {
          code: 'ORDER_STATUS_TRANSITION_INVALID',
          message: `Cannot transition from ${order.status} to ${newStatus}`,
        },
      });
    }

    // The cascade, the in-transit guard and the order write share one
    // transaction. An order must never be CANCELLED while a shipment of it is
    // still live, which is the state that let a warehouse ship a cancelled
    // order (finding AD4).
    const updated = await this.prisma.$transaction(async (tx) => {
      if (newStatus === OrderStatus.CANCELLED) {
        // The cascade runs BEFORE the in-transit count, so its `updateMany`
        // takes a row lock on every PROCESSING shipment first and the count
        // then reads a set nothing else can move. Counting first, outside the
        // lock, left a window where a parcel shipped between the check and the
        // write and the order was cancelled anyway.
        await tx.shipment.updateMany({
          where: { orderId, status: ShipmentStatus.PROCESSING },
          data: { status: ShipmentStatus.CANCELLED },
        });

        const inTransit = await tx.shipment.count({
          where: {
            orderId,
            status: { in: [ShipmentStatus.SHIPPED, ShipmentStatus.DELIVERED] },
          },
        });
        if (inTransit > 0) throw new OrderCancelShipmentInTransitException();
      }

      // WHERE-guarded on the status the transition was validated against, so
      // two concurrent callers who both read the old status cannot both win.
      // The loser writes zero rows and is told the transition is invalid, which
      // is true by the time it lands (§3.4).
      const written = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          status: newStatus,
          // H-2: record delivery timestamp for return window calculation (§4.9)
          ...(newStatus === OrderStatus.DELIVERED && { deliveredAt: new Date() }),
        },
      });
      if (written.count === 0) {
        throw new BadRequestException({
          error: {
            code: 'ORDER_STATUS_TRANSITION_INVALID',
            message: `Cannot transition from ${order.status} to ${newStatus}`,
          },
        });
      }

      // Inside the transaction, and only after the guarded write won. A
      // transition lands with its history row or does not land at all, and the
      // caller that lost the race writes neither (finding AD6).
      await tx.orderStatusHistory.create({
        data: { orderId, fromStatus: order.status, toStatus: newStatus },
      });

      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
    });

    // Restore stock on cancellation (pre-shipment statuses only — §4.8
    // CUSTOMER_CANCELLABLE). AFTER the commit, never before: the in-transit
    // guard now lives inside the transaction, and only one caller can commit
    // the cancel, so the restore runs exactly once and only for a cancel that
    // actually happened.
    if (newStatus === OrderStatus.CANCELLED) {
      await this.restoreOrderStock(orderId, performedBy);
      await this.unwindCancelledOrder(order);
    }

    // Audit log
    await this.auditLog(performedBy, 'order.status_changed', 'Order', orderId, {
      from: order.status,
      to: newStatus,
    });

    // Auto-generate invoice on CONFIRMED
    if (newStatus === OrderStatus.CONFIRMED) {
      await this.generateInvoice(orderId);
      this.events.emit(ORDER_EVENTS.CONFIRMED, {
        orderId,
        orderNumber: order.orderNumber,
        userId: order.userId,
      });
    }

    // Emit status-specific events
    if (newStatus === OrderStatus.CANCELLED) {
      this.events.emit(ORDER_EVENTS.CANCELLED, {
        orderId,
        orderNumber: order.orderNumber,
        userId: order.userId,
      });
    } else if (newStatus === OrderStatus.SHIPPED) {
      this.events.emit(ORDER_EVENTS.SHIPPED, {
        orderId,
        orderNumber: order.orderNumber,
        userId: order.userId,
      });
    } else if (newStatus === OrderStatus.DELIVERED) {
      this.events.emit(ORDER_EVENTS.DELIVERED, {
        orderId,
        orderNumber: order.orderNumber,
        userId: order.userId,
      });
    }

    this.events.emit(ORDER_EVENTS.STATUS_CHANGED, {
      orderId,
      orderNumber: order.orderNumber,
      from: order.status,
      to: newStatus,
    });

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYMENT ACTIONS (DR-34)
  // ═══════════════════════════════════════════════════════════════════════════

  async capturePayment(
    orderId: string,
    performedBy: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.runPaymentAction(orderId, performedBy, 'capture', idempotencyKey);
  }

  /** Full refund of the order total. */
  async refundPayment(
    orderId: string,
    performedBy: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.runPaymentAction(orderId, performedBy, 'refund', idempotencyKey);
  }

  async cancelPayment(
    orderId: string,
    performedBy: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.runPaymentAction(orderId, performedBy, 'cancel', idempotencyKey);
  }

  // A retried capture or refund replays the first response instead of calling
  // the provider twice. The key is bound to the admin, the order and the action.
  private async runPaymentAction(
    orderId: string,
    performedBy: string,
    action: PaymentAction,
    idempotencyKey: string,
  ): Promise<unknown> {
    const callerHash = IdempotencyService.sha256Hex(performedBy);
    const bodyHash = IdempotencyService.sha256Hex(
      IdempotencyService.stableStringify({ orderId, action }),
    );
    const idempotencyArgs = {
      scope: PAYMENT_IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      callerHash,
      bodyHash,
    };
    const beginResult = await this.idempotency.beginRequest(idempotencyArgs);
    switch (beginResult.state) {
      case 'cached':
        return beginResult.cachedResponse;
      case 'forbidden':
        throw new IdempotencyKeyForbiddenException();
      case 'conflict':
        throw new IdempotencyKeyConflictException();
      case 'in-flight':
        throw new OrderIdempotencyInFlightException();
      case 'fresh':
        break;
    }

    // Derived, not forwarded: the raw request key never leaves the engine.
    const providerKey = IdempotencyService.sha256Hex(
      IdempotencyService.stableStringify({ callerHash, bodyHash, key: idempotencyKey }),
    );

    try {
      const order = await this.applyPaymentAction(orderId, performedBy, action, providerKey);
      await this.idempotency.completeRequest({
        ...idempotencyArgs,
        entityId: orderId,
        responseJson: order,
      });
      return order;
    } catch (error) {
      await this.idempotency.abortRequest({
        scope: PAYMENT_IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        callerHash,
      });
      throw error;
    }
  }

  // `paymentStatus` comes from the provider result only, never a request body (§3.5).
  private async applyPaymentAction(
    orderId: string,
    performedBy: string,
    action: PaymentAction,
    idempotencyKey: string,
  ): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        paymentMethodCode: true,
        paymentReference: true,
        total: true,
        currency: true,
        returns: {
          where: { status: { in: [ReturnStatus.REFUND_PROCESSED, ReturnStatus.CLOSED] } },
          select: { refundAmount: true },
        },
      },
    });
    if (!order) throw new OrderNotFoundException(orderId);
    const { paymentMethodCode: methodCode, paymentReference: reference } = order;
    if (!methodCode || !reference) throw new OrderPaymentNotOpenedException(orderId);

    const from = order.paymentStatus;
    // Refund is full only: after a partial refund the order total overstates
    // what is left to give back.
    if (action === 'refund' && from === PaymentStatus.PARTIALLY_REFUNDED) {
      const providerId = await this.paymentGateway.providerIdFor(methodCode);
      throw new PaymentTransitionNotAllowedException(providerId, from, action);
    }
    // Processed returns already gave part of the total back.
    const refundable = order.returns.reduce(
      (left, { refundAmount }) => left.minus(refundAmount ?? 0),
      order.total,
    );
    if (action === 'refund' && refundable.lte(0)) {
      throw new OrderNothingToRefundException(orderId);
    }
    const result =
      action === 'capture'
        ? await this.paymentGateway.capture(methodCode, {
            reference,
            status: from,
            amount: order.total,
            currencyCode: order.currency,
            idempotencyKey,
          })
        : action === 'refund'
          ? await this.paymentGateway.refund(methodCode, {
              reference,
              status: from,
              amount: refundable,
              currencyCode: order.currency,
              refundableAmount: refundable,
              // Keyed by the order, not the request, so a second request key cannot refund twice.
              idempotencyKey: `refund:${orderId}:${from}:${refundable.toFixed()}`,
            })
          : await this.paymentGateway.cancel(methodCode, {
              reference,
              status: from,
              idempotencyKey,
            });

    // Guarded on the status the provider saw, so a concurrent action or webhook
    // that moved it first makes this write land on zero rows (§3.4).
    const written = await this.prisma.order.updateMany({
      where: { id: orderId, paymentStatus: from },
      data: { paymentStatus: result.status },
    });
    if (written.count === 0) {
      // A webhook for this same action may have landed first; that is success.
      const current = await this.prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { paymentStatus: true },
      });
      if (current.paymentStatus !== result.status) {
        const providerId = await this.paymentGateway.providerIdFor(methodCode);
        throw new PaymentTransitionNotAllowedException(providerId, from, action);
      }
    }

    await this.auditLog(performedBy, PAYMENT_AUDIT_ACTIONS[action], 'Order', orderId, {
      from,
      to: result.status,
    });

    // A full refund of an order nobody confirmed ends it: cancelling through the
    // shared path releases stock, the gift card and the promotion usage.
    if (
      action === 'refund' &&
      result.status === PaymentStatus.REFUNDED &&
      order.status === OrderStatus.PENDING
    ) {
      await this.updateStatus(orderId, OrderStatus.CANCELLED, performedBy);
    }

    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
  }

  // The event is already verified; the order must sit on one of the methods
  // whose secret verified it, so a deleted method's secret cannot move other orders.
  async applyPaymentWebhookEvent(
    providerId: string,
    event: PaymentWebhookEvent,
    methodCodes: readonly string[],
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { paymentReference: event.reference },
      select: { id: true, paymentStatus: true, paymentMethodCode: true },
    });
    if (!order?.paymentMethodCode || !methodCodes.includes(order.paymentMethodCode)) {
      throw new OrderNotFoundException(event.reference);
    }

    const from = order.paymentStatus;
    if (from === event.status) return;
    // Providers may deliver out of order; a late event never moves a status back.
    if (!WEBHOOK_FORWARD_MOVES[from].includes(event.status)) {
      this.logger.warn(
        `Stale payment event ${event.eventId} for order ${order.id}: ${from} to ${event.status} dropped`,
      );
      return;
    }

    const written = await this.prisma.order.updateMany({
      where: { id: order.id, paymentStatus: from },
      data: { paymentStatus: event.status },
    });
    if (written.count === 0) {
      // Another write raced this one; it is a no-op when it already landed the event status.
      const current = await this.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { paymentStatus: true },
      });
      if (current.paymentStatus === event.status) return;
      throw new PaymentTransitionNotAllowedException(providerId, from, 'webhook');
    }

    await this.auditLog(null, 'order.payment_webhook', 'Order', order.id, {
      from,
      to: event.status,
      eventId: event.eventId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOMER CANCELLATION
  // ═══════════════════════════════════════════════════════════════════════════

  async cancelOrder(orderId: string, userId: string): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        userId: true,
        orderNumber: true,
        // Filtered in the query rather than in memory: a shipment the cancel
        // cascade already cancelled must not keep blocking the customer.
        shipments: {
          where: { status: { not: ShipmentStatus.CANCELLED } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!order) throw new OrderNotFoundException(orderId);
    if (order.userId !== userId) throw new OrderNotYoursException();

    // A shipment row is the warehouse saying fulfilment started. From there the
    // customer contacts the store instead of self-serving (finding AD4).
    // Checked before the status rule because it is the more specific refusal:
    // creating a shipment also moves the order out of the cancellable window,
    // so the status check alone would always answer the vaguer STATUS.
    if (order.shipments.length > 0) {
      throw new OrderCancelIneligibleException(
        order.status,
        IN_FULFILMENT.includes(order.status) ? 'HAS_SHIPMENT' : 'STATUS',
      );
    }

    if (!CUSTOMER_CANCELLABLE.includes(order.status)) {
      throw new OrderCancelIneligibleException(order.status, 'STATUS');
    }

    // Serialized here, never inside `updateStatus`: the admin status route
    // shares that method and must keep the full row.
    const cancelled = await this.updateStatus(orderId, OrderStatus.CANCELLED, userId);
    return toCustomerOrder(cancelled as Record<string, unknown>);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INVOICE GENERATION (§4.8)
  // ═══════════════════════════════════════════════════════════════════════════

  private async generateInvoice(orderId: string): Promise<void> {
    const existing = await this.prisma.invoice.findUnique({
      where: { orderId },
      select: { id: true },
    });
    if (existing) return; // Invoice already generated

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return;

    const invoiceNumber = await this.generateInvoiceNumber();

    await this.prisma.invoice.create({
      data: {
        orderId,
        invoiceNumber,
        items: order.items.map((item) => ({
          orderItemId: item.id,
          productName: item.productName,
          sku: item.sku,
          unitPrice: toNum(item.unitPrice),
          quantity: item.quantity,
          total: toNum(item.total),
        })) as unknown as Prisma.InputJsonValue,
        subtotal: order.subtotal,
        discountAmount: order.discountAmount,
        shippingAmount: order.shippingAmount,
        shippingMethodName: order.shippingMethodName,
        taxAmount: order.taxAmount,
        total: order.total,
        billingAddress: order.billingAddress as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`Invoice generated: ${invoiceNumber} for order ${order.orderNumber}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHIPMENTS (§4.8 Split Shipments)
  // ═══════════════════════════════════════════════════════════════════════════

  async createShipment(
    orderId: string,
    dto: CreateShipmentDto,
    performedBy: string,
  ): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new OrderNotFoundException(orderId);

    // Fulfilment is over on a closed order; a new parcel would contradict it.
    if (CLOSED_STATUSES.includes(order.status)) {
      throw new OrderShipmentOrderClosedException('ORDER_CLOSED', order.status);
    }

    // Validate all referenced items belong to this order
    const orderItemIds = new Set(order.items.map((i) => i.id));
    for (const si of dto.items) {
      if (!orderItemIds.has(si.orderItemId)) {
        throw new BadRequestException({
          error: {
            code: 'ORDER_SHIPMENT_ITEM_NOT_IN_ORDER',
            message: `Item "${si.orderItemId}" does not belong to this order`,
          },
        });
      }
    }

    // The status check above is a snapshot, and a concurrent cancel can commit
    // between it and this insert, leaving a CANCELLED order carrying a live
    // PROCESSING parcel: the exact state this phase exists to make impossible.
    //
    // Insert and re-read share one transaction, which closes the window without
    // locking the order row. If the cancel committed first, the re-read sees it
    // and the insert rolls back. If the cancel commits after, its cascade finds
    // this row PROCESSING and cancels it. If they interleave, the cascade misses
    // the uncommitted row and the re-read catches the cancel instead.
    const shipment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shipment.create({
        data: {
          orderId,
          carrier: dto.carrier ?? null,
          trackingNumber: dto.trackingNumber ?? null,
          items: dto.items as unknown as Prisma.InputJsonValue,
        },
      });

      const settled = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (!settled) throw new OrderNotFoundException(orderId);
      if (CLOSED_STATUSES.includes(settled.status)) {
        throw new OrderShipmentOrderClosedException('ORDER_CLOSED', settled.status);
      }

      return created;
    });

    await this.auditLog(performedBy, 'order.shipment_created', 'Order', orderId, {
      shipmentId: shipment.id,
      items: dto.items,
    });

    // The shipment is the fulfilment record, so creating one on a CONFIRMED
    // order is the warehouse starting work: move the order to PROCESSING so the
    // customer stops being offered a cancel button the API would refuse.
    //
    // Creating a shipment used to move a PROCESSING order straight to SHIPPED.
    // That is now wrong in both directions: the new row is PROCESSING, so the
    // order claimed to have shipped a parcel still being packed, and adding a
    // second parcel to a part-shipped order announced the whole order as gone.
    // SHIPPED comes from `updateShipment` instead, once every parcel has left.
    if (order.status === OrderStatus.CONFIRMED) {
      await this.updateStatus(orderId, OrderStatus.PROCESSING, performedBy);
    }

    return shipment;
  }

  async updateShipment(
    orderId: string,
    shipmentId: string,
    dto: UpdateShipmentDto,
    performedBy: string,
  ): Promise<unknown> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, orderId },
    });
    if (!shipment) {
      throw new NotFoundException({
        error: {
          code: 'ORDER_SHIPMENT_NOT_FOUND',
          message: `Shipment "${shipmentId}" not found for order "${orderId}"`,
        },
      });
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) throw new OrderNotFoundException(orderId);

    if (CLOSED_STATUSES.includes(order.status)) {
      throw new OrderShipmentOrderClosedException('ORDER_CLOSED', order.status);
    }
    // CANCELLED is terminal for a shipment in both directions. Nothing may move
    // a cancelled row back into the flow, and nothing may move a live row into
    // CANCELLED except the order cancel cascade, which is also what restores
    // the stock and closes the order (finding AD4).
    //
    // `UpdateShipmentDto` already refuses the second case. This repeats it
    // because the rule belongs to the model, not to one HTTP route, and a
    // service-layer caller never passes through the validation pipe.
    if (shipment.status === ShipmentStatus.CANCELLED) {
      throw new OrderShipmentOrderClosedException('SHIPMENT_CANCELLED', order.status);
    }
    // Widened on purpose. `UpdateShipmentDto.status` is typed to the writable
    // subset, so TypeScript calls this comparison dead, which is the point: the
    // request boundary already makes it unreachable. It stays as a runtime guard
    // for an internal or cast caller that never meets the validation pipe.
    if ((dto.status as ShipmentStatus | undefined) === ShipmentStatus.CANCELLED) {
      throw new OrderShipmentOrderClosedException('CANCEL_THE_ORDER_INSTEAD', order.status);
    }

    const data: Prisma.ShipmentUpdateInput = {};
    if (dto.carrier !== undefined) data.carrier = dto.carrier;
    if (dto.trackingNumber !== undefined) data.trackingNumber = dto.trackingNumber;
    if (dto.status !== undefined) {
      data.status = dto.status;
      // Only on the transition into that status. Stamping on every call let a
      // retried PATCH rewrite when the parcel actually shipped.
      if (dto.status === ShipmentStatus.SHIPPED && shipment.status !== ShipmentStatus.SHIPPED) {
        data.shippedAt = new Date();
      }
      if (dto.status === ShipmentStatus.DELIVERED && shipment.status !== ShipmentStatus.DELIVERED) {
        data.deliveredAt = new Date();
      }
    }

    // WHERE-guarded, not a blind update by id. The read at the top of this
    // method is a snapshot, and the cancel cascade can set this very row to
    // CANCELLED in the gap; a blind write would quietly reinstate it. Zero rows
    // affected means the cascade won the race (§3.4).
    const written = await this.prisma.shipment.updateMany({
      where: { id: shipmentId, status: { not: ShipmentStatus.CANCELLED } },
      data,
    });
    if (written.count === 0) {
      throw new OrderShipmentOrderClosedException('SHIPMENT_CANCELLED', order.status);
    }
    const updated = await this.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });

    await this.auditLog(performedBy, 'order.shipment_updated', 'Order', orderId, {
      shipmentId,
      changes: dto,
    });

    // The shipment lane is where an order actually ships, and it used to emit
    // nothing at all, so `order.shipped` never reached the customer for a
    // multi-parcel or manually-updated order (finding AD15). A two-parcel order
    // waits for its slower half rather than announcing itself twice.
    if (dto.status === ShipmentStatus.SHIPPED) {
      const stillPreparing = await this.prisma.shipment.count({
        where: { orderId, status: ShipmentStatus.PROCESSING },
      });
      if (stillPreparing === 0 && STATUS_TRANSITIONS[order.status].includes(OrderStatus.SHIPPED)) {
        // `updateStatus` emits ORDER_EVENTS.SHIPPED, and the mail resolver
        // already reads carrier and tracking off the newest shipment row, so
        // the event payload needs nothing extra.
        //
        // Two parcels shipped at once both see zero left preparing, and the
        // loser finds the order already SHIPPED. That is the right outcome
        // rather than an error to hand back: its own shipment write succeeded,
        // and the order is in the state it was asking for. Only that one race
        // is swallowed; every other failure still propagates.
        try {
          await this.updateStatus(orderId, OrderStatus.SHIPPED, performedBy);
        } catch (err) {
          if (!isTransitionInvalid(err)) throw err;
        }
      }
    }

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRE-FULFILLMENT EDITING (§4.8)
  // ═══════════════════════════════════════════════════════════════════════════

  async editOrder(
    orderId: string,
    dto: EditOrderDto,
    performedBy: string,
    acceptLanguage?: string,
  ): Promise<unknown> {
    // The locale the line labels are snapshotted in. `variantLabel` is a plain
    // text column, so it is resolved once here rather than by the response
    // interceptor (finding AD2).
    const labelLocale = parseLocale(acceptLanguage);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new OrderNotFoundException(orderId);

    if (!EDITABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException({
        error: {
          code: 'ORDER_UNEDITABLE_STATUS',
          message: `Order in ${order.status} status cannot be edited`,
        },
      });
    }

    const beforeSnapshot = {
      subtotal: toNum(order.subtotal),
      discountAmount: toNum(order.discountAmount),
      total: toNum(order.total),
      shippingAddress: order.shippingAddress,
      items: order.items.map((i) => ({ id: i.id, quantity: i.quantity })),
    };

    // Add items
    if (dto.addItems?.length) {
      for (const addItem of dto.addItems) {
        const variant = await this.prisma.productVariant.findUnique({
          where: { id: addItem.variantId },
          select: {
            id: true,
            sku: true,
            price: true,
            weight: true,
            productId: true,
            product: {
              select: {
                id: true,
                name: true,
                slug: true,
                assets: {
                  where: { isPrimary: true },
                  take: 1,
                  select: {
                    asset: { select: { id: true, status: true, variants: true } },
                  },
                },
              },
            },
            attributeValues: {
              orderBy: [{ attributeValue: { sortOrder: 'asc' } }, { attributeValueId: 'asc' }],
              select: { attributeValue: { select: { value: true } } },
            },
          },
        });

        if (!variant) {
          throw new NotFoundException({
            error: {
              code: 'ORDER_EDIT_VARIANT_NOT_FOUND',
              message: `Variant "${addItem.variantId}" not found`,
            },
          });
        }

        const stock = await this.inventory.checkAvailability(addItem.variantId);
        if (stock.available < addItem.quantity) {
          throw new OrderEditInsufficientStockException(addItem.variantId);
        }

        const success = await this.inventory.decrementStock(addItem.variantId, addItem.quantity, {
          referenceType: 'OrderEdit',
          referenceId: orderId,
          performedBy,
        });
        if (!success) {
          throw new OrderEditInsufficientStockException(
            addItem.variantId,
            `Could not reserve stock for variant "${addItem.variantId}"`,
          );
        }

        await this.prisma.orderItem.create({
          data: {
            orderId,
            variantId: variant.id,
            productId: variant.productId,
            productName: variant.product.name as Prisma.InputJsonValue,
            variantLabel: buildVariantLabel(variant.attributeValues, labelLocale),
            sku: variant.sku,
            unitPrice: variant.price,
            quantity: addItem.quantity,
            total: toNum(variant.price) * addItem.quantity,
            weight: variant.weight ?? null,
            thumbnailUrl:
              tryPickVariantUrl(variant.product.assets[0]?.asset, 'thumbnail')?.url ?? null,
          },
        });
      }
    }

    // Remove items
    if (dto.removeItems?.length) {
      for (const removal of dto.removeItems) {
        const item = await this.prisma.orderItem.findFirst({
          where: { id: removal.orderItemId, orderId },
        });
        if (!item) {
          throw new NotFoundException({
            error: {
              code: 'ORDER_EDIT_ITEM_NOT_FOUND',
              message: `Order item "${removal.orderItemId}" not found`,
            },
          });
        }

        // Restore stock
        if (item.variantId) {
          await this.inventory.incrementStock(
            item.variantId,
            item.quantity,
            AdjustmentReason.RETURN_RESTOCK,
            {
              referenceType: 'OrderEdit',
              referenceId: orderId,
              performedBy,
            },
          );
        }

        await this.prisma.orderItem.delete({ where: { id: removal.orderItemId } });
      }
    }

    // Update shipping address
    if (dto.shippingAddress) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { shippingAddress: dto.shippingAddress as unknown as Prisma.InputJsonValue },
      });
    }

    // Update internal notes
    if (dto.internalNotes !== undefined) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { internalNotes: dto.internalNotes },
      });
    }

    // Recalculate totals
    await this.recalculateOrderTotals(orderId, dto.manualDiscount);

    const afterOrder = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });

    // Audit log with before/after
    await this.auditLog(performedBy, 'order.edited', 'Order', orderId, {
      before: beforeSnapshot,
      after: {
        subtotal: toNum(afterOrder!.subtotal),
        discountAmount: toNum(afterOrder!.discountAmount),
        total: toNum(afterOrder!.total),
        shippingAddress: afterOrder!.shippingAddress,
        items: afterOrder!.items.map((i) => ({ id: i.id, quantity: i.quantity })),
      },
    });

    return afterOrder;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN NOTES
  // ═══════════════════════════════════════════════════════════════════════════

  async addNote(orderId: string, note: string, performedBy: string): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, internalNotes: true },
    });
    if (!order) throw new OrderNotFoundException(orderId);

    const timestamp = new Date().toISOString();
    const existing = order.internalNotes ?? '';
    const updated = existing ? `${existing}\n\n[${timestamp}] ${note}` : `[${timestamp}] ${note}`;

    await this.prisma.order.update({
      where: { id: orderId },
      data: { internalNotes: updated },
    });

    await this.auditLog(performedBy, 'order.note_added', 'Order', orderId, { note });

    return { note: updated };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERIES — STOREFRONT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * One order, for the customer who owns it.
   *
   * Ownership has two shapes now. An account order is owned by its `userId`,
   * exactly as before. A guest order has no user, and is owned by the browser
   * that placed it: the anonymous cart cookie the order recorded in
   * `guestSessionId`. That is what lets the confirmation page render one second
   * after a guest pays, instead of the login wall it used to show them.
   *
   * The two branches never cross. A session cookie cannot open an account
   * order, and a signed-in customer cannot reach a guest order they did not
   * place. A guest order with no recorded session is unreachable by this route
   * at all, rather than matching a caller who also has no cookie.
   */
  /** Ownership rule shared by every storefront read or write on one order. */
  private assertStorefrontOwner(
    order: { userId: string | null; guestSessionId: string | null },
    orderId: string,
    userId?: string,
    sessionId?: string,
  ): void {
    if (order.userId !== null) {
      if (order.userId !== userId) {
        throw userId ? new OrderNotYoursException() : new OrderNotFoundException(orderId);
      }
    } else if (!order.guestSessionId || !sessionId || order.guestSessionId !== sessionId) {
      // A guest order has no authenticated caller to owe an explanation to.
      throw new OrderNotFoundException(orderId);
    }
  }

  /**
   * Opens a new provider session for an order whose payment has not been
   * taken, so a shopper can retry after a failure. The order stays as it is;
   * only the payment reference and status change. The action is returned and
   * never stored (it carries a short-lived client token).
   */
  async retryPayment(
    orderId: string,
    caller: { userId?: string; sessionId?: string; acceptLanguage?: string },
  ): Promise<{ paymentAction: ProviderPaymentAction }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        userId: true,
        guestSessionId: true,
        total: true,
        currency: true,
        paymentStatus: true,
        paymentMethodCode: true,
        paymentReference: true,
        guestEmail: true,
        user: { select: { email: true } },
      },
    });
    if (!order) throw new OrderNotFoundException(orderId);
    this.assertStorefrontOwner(order, orderId, caller.userId, caller.sessionId);

    return this.reopenPaymentSession(order, orderId, caller.acceptLanguage);
  }

  /**
   * Guest pay again from the track page. The order number plus the email on
   * file stand in for the cart session a guest may no longer have.
   */
  async retryTrackedPayment(
    dto: { orderNumber: string; email: string },
    acceptLanguage?: string,
  ): Promise<{ paymentAction: ProviderPaymentAction }> {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber: dto.orderNumber },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        total: true,
        currency: true,
        guestEmail: true,
        paymentStatus: true,
        paymentMethodCode: true,
        paymentReference: true,
        user: { select: { email: true } },
      },
    });
    const onFile = order?.user?.email ?? order?.guestEmail ?? null;
    const supplied = dto.email?.trim().toLowerCase() ?? null;
    if (!order || !onFile || !supplied || onFile.trim().toLowerCase() !== supplied) {
      throw new OrderNotFoundException();
    }
    return this.reopenPaymentSession(order, order.id, acceptLanguage);
  }

  private async reopenPaymentSession(
    order: {
      id: string;
      orderNumber: string;
      status: OrderStatus;
      total: Prisma.Decimal;
      currency: string;
      paymentStatus: PaymentStatus;
      paymentMethodCode: string | null;
      paymentReference: string | null;
      guestEmail?: string | null;
      user?: { email: string } | null;
    },
    orderId: string,
    acceptLanguage?: string,
  ): Promise<{ paymentAction: ProviderPaymentAction }> {
    if (!(await this.isPaymentRetryable(order))) {
      throw new OrderPaymentNotRetryableException(orderId);
    }
    const methodCode = order.paymentMethodCode as string;

    // The previous attempt is closed first so it cannot be paid later. A
    // provider that already lost the session has nothing to close.
    if (order.paymentReference) {
      await this.paymentGateway
        .cancel(methodCode, {
          reference: order.paymentReference,
          status: order.paymentStatus,
          idempotencyKey: `retry-cancel:${order.paymentReference}`,
        })
        .catch(() => undefined);
    }

    const session = await this.paymentGateway.openSession(methodCode, {
      orderId: order.id,
      amount: order.total,
      currencyCode: order.currency,
      returnUrl: this.paymentReturnUrl(order.orderNumber, acceptLanguage),
      customerEmail: order.user?.email ?? order.guestEmail ?? undefined,
    });
    await this.prisma.order.update({
      where: { id: order.id },
      data: { paymentReference: session.reference, paymentStatus: session.status },
    });
    return { paymentAction: session.action };
  }

  private async accountEmail(userId?: string): Promise<string | undefined> {
    if (!userId) return undefined;
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true },
    });
    return user?.email ?? undefined;
  }

  /** Where a hosted payment page sends the shopper back: the order confirmation page. */
  private paymentReturnUrl(orderNumber: string, acceptLanguage?: string): string {
    return `${storefrontBaseUrl()}/${resolveLocale(acceptLanguage)}/order-confirmation/${encodeURIComponent(orderNumber)}`;
  }

  // The storefront calls this when the customer comes back from the provider.
  // The webhook may be late, so the provider is asked directly. The status then
  // moves through the same forward-only rules as a webhook event.
  async confirmPayment(
    orderId: string,
    caller: { userId?: string; sessionId?: string },
  ): Promise<{ paymentStatus: PaymentStatus }> {
    const select = {
      id: true,
      userId: true,
      guestSessionId: true,
      paymentStatus: true,
      paymentMethodCode: true,
      paymentReference: true,
    } as const;
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select });
    if (!order) throw new OrderNotFoundException(orderId);
    this.assertStorefrontOwner(order, orderId, caller.userId, caller.sessionId);

    if (!order.paymentMethodCode || !order.paymentReference) {
      return { paymentStatus: order.paymentStatus };
    }

    const live = await this.paymentGateway.getStatus(order.paymentMethodCode, {
      reference: order.paymentReference,
      status: order.paymentStatus,
    });
    if (live.status !== order.paymentStatus) {
      await this.applyPaymentWebhookEvent(
        await this.paymentGateway.providerIdFor(order.paymentMethodCode),
        { reference: live.reference, status: live.status, eventId: `confirm:${live.reference}` },
        [order.paymentMethodCode],
      );
    }

    const current = await this.prisma.order.findUnique({ where: { id: orderId }, select });
    return { paymentStatus: (current ?? order).paymentStatus };
  }

  async findOneStorefront(orderId: string, userId?: string, sessionId?: string): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new OrderNotFoundException(orderId);
    // An anonymous caller never learns whether an order id exists.
    //
    // This route used to be authenticated-only, so a 403-vs-404 split leaked
    // existence to signed-in customers alone. It serves anonymous callers now,
    // and at 100 requests a minute a bare `403` would turn it into an
    // existence oracle for anyone at all.
    //
    // A signed-in customer who reaches someone else's order still gets the
    // distinct `ORDER_NOT_YOURS`, because the account order page renders a
    // dedicated state for it and they have already proved who they are. It is
    // only the anonymous caller who gets the opaque answer.
    this.assertStorefrontOwner(order, orderId, userId, sessionId);
    return {
      ...toCustomerOrder(await this.withProductSlugs(order)),
      // One server-computed flag instead of a client-side status allowlist that
      // drifted wider than the server rule and offered a button the API refused
      // (finding AD4).
      cancellable: this.isCustomerCancellable(order),
      // Same rule `retryPayment` enforces, so the "pay again" button never
      // offers an action the endpoint refuses.
      paymentRetryable: await this.isPaymentRetryable(order),
    };
  }

  private async isPaymentRetryable(order: {
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    paymentMethodCode: string | null;
  }): Promise<boolean> {
    const retryableStatus =
      order.paymentStatus === PaymentStatus.PENDING || order.paymentStatus === PaymentStatus.FAILED;
    if (!order.paymentMethodCode || !retryableStatus || order.status === OrderStatus.CANCELLED) {
      return false;
    }
    // Cash on delivery and bank transfer have no payment step to retry.
    return this.paymentGateway.collectsPaymentOnline(order.paymentMethodCode);
  }

  /**
   * The exact rule `cancelOrder` enforces, so the button and the endpoint can
   * never disagree: inside the customer-cancellable window and no shipment row
   * that has not itself been cancelled.
   */
  private isCustomerCancellable(order: {
    status: OrderStatus;
    shipments?: { status: ShipmentStatus }[];
  }): boolean {
    if (!CUSTOMER_CANCELLABLE.includes(order.status)) return false;
    return !(order.shipments ?? []).some((s) => s.status !== ShipmentStatus.CANCELLED);
  }

  /**
   * Attach the catalogue slug to each order line.
   *
   * `OrderItem` snapshots what was bought and has no slug column, so the
   * storefront's order detail could not link a line back to its product: the
   * client schema already tolerated `productSlug` and nothing ever sent one.
   *
   * Resolved with a second query rather than by widening the shared
   * `ORDER_INCLUDE`, which the admin order screens also read: this is a
   * storefront-only need and the admin has the product ids already.
   *
   * A product archived since the order was placed gets no slug, because a link
   * into a 404 is worse than plain text. Lines whose product was hard-deleted
   * (`productId` null) simply do not match.
   */
  private async withProductSlugs(order: Record<string, unknown>): Promise<Record<string, unknown>> {
    const items = order['items'];
    if (!Array.isArray(items) || items.length === 0) return order;

    const productIds = [
      ...new Set(
        items
          .map((item) => (item as { productId?: unknown }).productId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (productIds.length === 0) return order;

    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, slug: true, deletedAt: true },
    });
    const slugById = new Map(
      products.filter((p) => p.deletedAt === null).map((p) => [p.id, p.slug]),
    );

    return {
      ...order,
      items: items.map((item) => {
        const productId = (item as { productId?: unknown }).productId;
        const slug = typeof productId === 'string' ? slugById.get(productId) : undefined;
        return slug ? { ...(item as Record<string, unknown>), productSlug: slug } : item;
      }),
    };
  }

  async listStorefront(
    userId: string,
    query: ListOrdersStorefrontDto,
  ): Promise<PaginatedResult<unknown>> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);

    const where: Prisma.OrderWhereInput = { userId };
    if (query.status) where.status = query.status;

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: CUSTOMER_ORDER_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total } };
  }

  async getInvoice(orderId: string, userId?: string): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, orderNumber: true, currency: true },
    });
    if (!order) throw new OrderNotFoundException(orderId);

    // Ownership check for storefront
    if (userId && order.userId !== userId) {
      throw new OrderNotYoursException();
    }

    const invoice = await this.prisma.invoice.findUnique({
      where: { orderId },
    });
    if (!invoice) throw new OrderInvoiceNotReadyException();

    // `downloadUrl` points at the sibling streaming endpoint (browser-facing
    // `/v1/...` path — the storefront proxy/prod reverse-proxy maps it to the
    // API exactly like the JSON route above). The storefront navigates
    // `window.location.href = downloadUrl`; the endpoint re-checks ownership and
    // streams the branded PDF (see `getInvoicePdf` + `orders.controller.ts`).
    // Admin (no userId) gets the admin path for a future fast-follow.
    const downloadUrl = userId
      ? `/v1/orders/${orderId}/invoice/pdf`
      : `/v1/admin/orders/${orderId}/invoice/pdf`;

    // Inline parent-Order fields the storefront contract expects
    // (`libs/storefront-types/src/lib/orders/orders.schemas.ts` invoiceResponseSchema).
    return { ...invoice, orderNumber: order.orderNumber, currency: order.currency, downloadUrl };
  }

  /**
   * Renders (or serves the cached) branded invoice PDF for an order.
   *
   * Lazy + retroactive + idempotent: the PDF is materialised on first download
   * to a deterministic PRIVATE key
   * `invoices/{orderId}/{invoiceNumber}-{locale}.pdf`, so pre-existing orders
   * work with no backfill and the immutable Invoice row is never mutated to
   * hold a path (§3.4 append-only). Subsequent downloads serve the cached
   * object. Concurrent first-downloads at worst render twice and overwrite the
   * same bytes, which is harmless because the render inputs are immutable.
   *
   * Ownership is enforced HERE (per byte), not via a capability URL: storefront
   * passes `userId` (→ OrderNotYoursException on mismatch); admin omits it.
   */
  async getInvoicePdf(
    orderId: string,
    opts: { userId?: string; acceptLanguage?: string } = {},
  ): Promise<{ buffer: Buffer; invoiceNumber: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        orderNumber: true,
        currency: true,
        user: { select: { locale: true } },
      },
    });
    if (!order) throw new OrderNotFoundException(orderId);
    if (opts.userId && order.userId !== opts.userId) throw new OrderNotYoursException();

    const invoice = await this.prisma.invoice.findUnique({ where: { orderId } });
    if (!invoice) throw new OrderInvoiceNotReadyException();

    // The customer's preferred locale, falling back to the caller's
    // Accept-Language (the order itself does not persist a locale column). It
    // resolves both the line-item name snapshots below and the document itself.
    const locale = resolveLocale(order.user?.locale ?? opts.acceptLanguage);

    // Deterministic private key (carries the `private/` prefix so read()/save()
    // route to the private root on both the local and S3 drivers). The locale is
    // part of the key because the rendered document is locale-specific: a shared
    // key would freeze whichever language happened to be requested first and
    // serve it to everyone after. It is also what retires the pre-rebrand
    // artifacts — nothing reads the old key again, so no purge step can be
    // forgotten (tasks.md D7.24).
    const storagePath = `private/invoices/${orderId}/${invoice.invoiceNumber}-${locale}.pdf`;

    let buffer: Buffer;
    try {
      buffer = await this.storage.read(storagePath);
    } catch (err) {
      if (!isStorageNotFound(err)) throw err;
      // Invoice items store `productName` as a Translatable JSON snapshot
      // (`OrderItem.productName` is `Json`), so it MUST be resolved to the
      // render locale here — the renderer takes plain strings. Passing the raw
      // object through would print `[object Object]` on the PDF.
      const rawItems =
        (invoice.items as unknown as Array<{
          productName: unknown;
          sku: string;
          unitPrice: number;
          quantity: number;
          total: number;
        }>) ?? [];
      const snapshot: InvoicePdfSnapshot = {
        invoiceNumber: invoice.invoiceNumber,
        items: rawItems.map((it) => ({
          productName: resolveTranslatable(it.productName, locale),
          sku: it.sku,
          unitPrice: toNum(it.unitPrice),
          quantity: it.quantity,
          total: toNum(it.total),
        })),
        subtotal: toNum(invoice.subtotal),
        discountAmount: toNum(invoice.discountAmount),
        shippingAmount: toNum(invoice.shippingAmount),
        taxAmount: toNum(invoice.taxAmount),
        total: toNum(invoice.total),
        shippingMethodName: invoice.shippingMethodName,
        billingAddress: (invoice.billingAddress as unknown as InvoicePdfBillingAddress) ?? null,
        issuedAt: invoice.issuedAt,
      };
      buffer = await this.invoicePdf.render({
        invoice: snapshot,
        order: { orderNumber: order.orderNumber, currency: order.currency },
        locale: invoiceLocaleOf(locale),
      });
      await this.storage.save(buffer, storagePath, { visibility: 'private' });
    }

    return { buffer, invoiceNumber: invoice.invoiceNumber };
  }

  async trackOrder(dto: { orderNumber: string; email: string }): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber: dto.orderNumber },
      include: {
        user: { select: { email: true } },
        shipments: {
          select: {
            id: true,
            carrier: true,
            trackingNumber: true,
            status: true,
            shippedAt: true,
            deliveredAt: true,
          },
        },
        // Same ordering as ORDER_INCLUDE: this is a timeline and every reader
        // walks it oldest first.
        statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });

    // A guest order has no user row, so its contact address is the only thing
    // that can answer the challenge. Compared case-insensitively and trimmed on
    // both sides: a customer retyping the address off a printed confirmation
    // should not be turned away over capitalisation. A null on either side
    // never matches, so an order with neither address stays unreachable.
    const onFile = order?.user?.email ?? order?.guestEmail ?? null;
    const supplied = dto.email?.trim().toLowerCase() ?? null;
    if (!order || !onFile || !supplied || onFile.trim().toLowerCase() !== supplied) {
      throw new OrderNotFoundException();
    }

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      shipments: order.shipments,
      createdAt: order.createdAt,
      paymentStatus: order.paymentStatus,
      paymentRetryable: await this.isPaymentRetryable(order),
      // The customer projection, not the raw rows: the history table carries an
      // id, an orderId and a fromStatus this surface has no use for, and this
      // response is public behind nothing but the email challenge. Named
      // `timeline` here and `statusHistory` on the authed order shape because
      // the two contracts were published separately; the rows are identical
      // because both go through `toCustomerStatusHistory`.
      timeline: toCustomerStatusHistory(order.statusHistory),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERIES — ADMIN
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * One order for the admin, which is the raw row minus the guest credential.
   *
   * Staff legitimately see everything else here, `internalNotes` included. They
   * must not see `guestSessionId`: it is the only key to that guest's order, so
   * putting it in this response body would push it into browser devtools, into
   * any admin-side error report, and into whatever support pastes into a
   * ticket. The customer-side allowlist does not cover this path, because this
   * is a different projection that deliberately returns nearly everything.
   */
  /**
   * Move the orders a guest placed in one cart session onto their new account.
   *
   * Runs when the anonymous cart is merged at sign-in, which is the moment the
   * `sessionId` cookie is cleared. That cookie is the only key to a guest
   * order, so without this the most natural thing a customer can do — pay as a
   * guest, then make an account to follow the order — permanently destroys
   * their own access to it. The order would not appear in their account list
   * either, because it carries no `userId`.
   *
   * Scoped by `userId: null` so it can only ever adopt orders that belong to
   * nobody. An order already owned by an account is untouchable here, whatever
   * session id is presented.
   *
   * `guestEmail` is deliberately left in place: it is the historical record of
   * where the confirmation went, and the public track page still answers on it.
   * `guestSessionId` is nulled, because the credential has now been spent.
   */
  async claimGuestOrders(userId?: string, sessionId?: string): Promise<void> {
    if (!userId || !sessionId) return;
    const { count } = await this.prisma.order.updateMany({
      where: { userId: null, guestSessionId: sessionId },
      data: { userId, guestSessionId: null },
    });
    if (count > 0) {
      this.logger.log(`Claimed ${count} guest order(s) for userId=${userId}`);
    }
  }

  async findOneAdmin(orderId: string): Promise<unknown> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new OrderNotFoundException(orderId);
    // `guestSessionId` is the bearer credential a guest reads their own order
    // with, so it never leaves in an admin payload. Copy-and-delete rather
    // than a destructured throwaway, which lint reads as an unused binding.
    const adminOrder: Partial<typeof order> = { ...order };
    delete adminOrder.guestSessionId;
    return adminOrder;
  }

  async listAdmin(query: ListOrdersAdminDto): Promise<PaginatedResult<unknown>> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const sortBy = (VALID_ADMIN_ORDER_SORT_FIELDS as readonly string[]).includes(query.sortBy ?? '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const where: Prisma.OrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.paymentStatus) where.paymentStatus = query.paymentStatus;
    if (query.userId) where.userId = query.userId;
    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search, mode: 'insensitive' } },
        { user: { email: { contains: query.search, mode: 'insensitive' } } },
        { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
        { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
        // A guest order has no user row to join to, so the `user.email` clause
        // above can never match one. Support is handed an email address and
        // nothing else, and for a guest that address lives here.
        { guestEmail: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: ORDER_LIST_SELECT,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════════════════════════

  async getStats(): Promise<unknown> {
    const [orderCount, revenueResult, statusCounts] = await Promise.all([
      this.prisma.order.count(),
      this.prisma.order.aggregate({
        _sum: { total: true },
        _avg: { total: true },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
    ]);

    return {
      totalOrders: orderCount,
      totalRevenue: revenueResult._sum.total ? toNum(revenueResult._sum.total) : 0,
      averageOrderValue: revenueResult._avg.total ? toNum(revenueResult._avg.total) : 0,
      byStatus: statusCounts.reduce(
        (acc, s) => ({ ...acc, [s.status]: s._count.id }),
        {} as Record<string, number>,
      ),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CSV EXPORT
  // ═══════════════════════════════════════════════════════════════════════════

  async exportCsv(query: ListOrdersAdminDto): Promise<string> {
    // Remove pagination for export — fetch all matching
    const where: Prisma.OrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.paymentStatus) where.paymentStatus = query.paymentStatus;
    if (query.userId) where.userId = query.userId;
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }

    const orders = await this.prisma.order.findMany({
      where,
      select: {
        orderNumber: true,
        status: true,
        paymentStatus: true,
        subtotal: true,
        discountAmount: true,
        shippingAmount: true,
        taxAmount: true,
        total: true,
        currency: true,
        couponCode: true,
        createdAt: true,
        user: { select: { email: true, firstName: true, lastName: true } },
        // Without this every guest row exports with a blank customer email.
        guestEmail: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    });

    const header =
      'Order Number,Status,Payment Status,Subtotal,Discount,Shipping,Tax,Total,Currency,Coupon,Customer Email,Customer Name,Created At';

    const rows = orders.map((o) => {
      const name = [o.user?.firstName, o.user?.lastName].filter(Boolean).join(' ');
      return [
        o.orderNumber,
        o.status,
        o.paymentStatus,
        toNum(o.subtotal),
        toNum(o.discountAmount),
        toNum(o.shippingAmount),
        toNum(o.taxAmount),
        toNum(o.total),
        o.currency,
        o.couponCode ?? '',
        o.user?.email ?? o.guestEmail ?? '',
        name,
        o.createdAt.toISOString(),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',');
    });

    return [header, ...rows].join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private async resolveAddress(
    inline?: Record<string, unknown>,
    addressId?: string,
    userId?: string,
  ): Promise<Record<string, unknown>> {
    if (inline) return inline;

    if (addressId && userId) {
      const address = await this.prisma.address.findFirst({
        where: { id: addressId, userId },
      });
      if (!address)
        throw new NotFoundException({
          error: {
            code: 'ORDER_ADDRESS_NOT_FOUND',
            message: `Address "${addressId}" not found`,
          },
        });

      return {
        fullName: address.fullName,
        phone: address.phone,
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
      };
    }

    throw new BadRequestException({
      error: {
        code: 'ORDER_SHIPPING_ADDRESS_REQUIRED',
        message: 'Shipping address is required',
      },
    });
  }

  /**
   * Atomically fetches the next value from a year-partitioned PostgreSQL SEQUENCE.
   * Creates the sequence on first use (CREATE SEQUENCE IF NOT EXISTS).
   *
   * Sanctioned $executeRawUnsafe / $queryRawUnsafe: atomic sequence generation (§9.4 C4).
   * The sequence name is derived from hardcoded prefixes + current year — no injection risk.
   */
  private async nextSequenceValue(name: string): Promise<number> {
    const year = new Date().getFullYear();
    const seqName = `${name}_seq_${year}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.prisma as any).$executeRawUnsafe(
      `CREATE SEQUENCE IF NOT EXISTS "${seqName}" START WITH 1 INCREMENT BY 1`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: { value: bigint }[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT nextval('"${seqName}"') AS value`,
    );

    return Number(result[0].value);
  }

  private async generateOrderNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const seq = await this.nextSequenceValue('order');
    return `${ORDER_NUMBER_PREFIX}-${year}-${String(seq).padStart(6, '0')}`;
  }

  private async generateInvoiceNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const seq = await this.nextSequenceValue('invoice');
    return `${INVOICE_NUMBER_PREFIX}-${year}-${String(seq).padStart(6, '0')}`;
  }

  /**
   * Gives back everything a cancelled order held: the open payment, the gift
   * card balance and the promotion usage. Each step logs and never blocks the
   * cancel, which has already committed.
   */
  private async unwindCancelledOrder(order: {
    id: string;
    paymentMethodCode: string | null;
    paymentReference: string | null;
    paymentStatus: PaymentStatus;
  }): Promise<void> {
    const openPayment =
      order.paymentStatus === PaymentStatus.PENDING ||
      order.paymentStatus === PaymentStatus.AUTHORIZED;
    if (openPayment) {
      try {
        if (order.paymentMethodCode && order.paymentReference) {
          await this.paymentGateway.cancel(order.paymentMethodCode, {
            reference: order.paymentReference,
            status: order.paymentStatus,
            idempotencyKey: `order-cancel:${order.id}`,
          });
        }
        await this.prisma.order.updateMany({
          where: { id: order.id, paymentStatus: order.paymentStatus },
          data: { paymentStatus: PaymentStatus.CANCELLED },
        });
      } catch (err) {
        this.logger.error(
          `Failed to void payment on cancel orderId=${order.id}: ${(err as Error).message}`,
        );
      }
    }

    try {
      await this.giftCards.restoreForOrder(order.id);
    } catch (err) {
      this.logger.error(
        `Failed to restore gift card on cancel orderId=${order.id}: ${(err as Error).message}`,
      );
    }

    try {
      await this.promotions.releaseUsageForOrder(order.id);
    } catch (err) {
      this.logger.error(
        `Failed to release promotion usage on cancel orderId=${order.id}: ${(err as Error).message}`,
      );
    }
  }

  /** Restores all item stock for an order (used on cancellation). */
  private async restoreOrderStock(orderId: string, performedBy: string): Promise<void> {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId, variantId: { not: null } },
      select: { variantId: true, quantity: true },
    });

    for (const item of items) {
      if (!item.variantId) continue;
      try {
        await this.inventory.incrementStock(
          item.variantId,
          item.quantity,
          AdjustmentReason.CORRECTION,
          { referenceType: 'OrderCancellation', referenceId: orderId, performedBy },
        );
      } catch (err) {
        this.logger.error(
          `Failed to restore stock for variant=${item.variantId} on cancel orderId=${orderId}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async recalculateOrderTotals(orderId: string, manualDiscount?: number): Promise<void> {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { unitPrice: true, quantity: true },
    });

    const subtotal = sumMoney(items.map((i) => lineTotal(toNum(i.unitPrice), i.quantity)));

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        shippingAmount: true,
        taxAmount: true,
        discountAmount: true,
        shippingAddress: true,
      },
    });

    const discount = manualDiscount ?? toNum(order!.discountAmount);
    const taxableBase = Math.max(0, roundMoney(subtotal - discount));

    // Tax is RE-computed, not carried over. This function used to re-read the
    // stored `taxAmount` and add it back unchanged, so editing an order's line
    // items moved the subtotal while the VAT stayed at whatever the original
    // basket produced. That was invisible while the seeded rate was 0.0 and is
    // an incorrect invoice at 19 per cent.
    const country = (order!.shippingAddress as Record<string, unknown> | null)?.['country'];
    const taxAmount =
      typeof country === 'string' && country
        ? (await this.tax.calculateTax(country, null, taxableBase)).amount
        : toNum(order!.taxAmount);

    const total = Math.max(0, sumMoney([taxableBase, toNum(order!.shippingAmount), taxAmount]));

    await this.prisma.order.update({
      where: { id: orderId },
      data: { subtotal, discountAmount: discount, taxAmount, total },
    });
  }

  private async auditLog(
    userId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    changes: unknown,
  ): Promise<void> {
    try {
      await this.prisma.auditLogEntry.create({
        data: {
          userId,
          action,
          entityType,
          entityId,
          changes: changes as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(`Audit log failed: ${(err as Error).message}`);
    }
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────
//
// `toNum` moved to ./orders.serializer so the customer projection and this
// service round money identically. Imported at the top of this file.

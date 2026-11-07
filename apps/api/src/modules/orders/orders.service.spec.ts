import { FR_EN_LOCALE_SET, NEUTRAL_LOCALE_SET, storeLocales } from '@common/locale';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentStatus, Prisma, ReturnStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { PromotionsService } from '../promotions/promotions.service';
import { GiftCardsService } from '../gift-cards/gift-cards.service';
import { ShippingService } from '../shipping/shipping.service';
import { TaxService } from '../tax/tax.service';
import { CartService } from '../cart/cart.service';
import { IdempotencyService } from '../../common/idempotency.service';
import {
  IdempotencyKeyConflictException,
  IdempotencyKeyForbiddenException,
} from '../../common/exceptions/idempotency.exception';
import { OrdersService } from './orders.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { STORAGE_DRIVER } from '../assets/assets.constants';
import { ORDER_EVENTS, STATUS_TRANSITIONS } from './orders.constants';
import { ShippingUnavailableException } from '../shipping/shipping-unavailable.exception';
import { ShippingMethodInvalidException } from '../shipping/shipping-method-invalid.exception';
import { CheckoutService } from '../checkout/checkout.service';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { PaymentGatewayService } from '../payments/payment-gateway.service';
import { PaymentTransitionNotAllowedException } from '../payments/payment-transition-not-allowed.exception';
import { OrderIdempotencyInFlightException } from './order-idempotency-in-flight.exception';
import { OrderPaymentNotOpenedException } from './order-payment-not-opened.exception';
import { OrderNothingToRefundException } from './order-nothing-to-refund.exception';
import { OrderNotFoundException } from './order-not-found.exception';
import { CouponInvalidException } from '../promotions/coupon-invalid.exception';
import { storeMoney } from '@common/money';
import { MoneyFormatterService } from '../currencies/money-formatter.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function dec(n: number) {
  return { toNumber: () => n } as unknown as Prisma.Decimal;
}

function makeCartResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cart-1',
    items: [
      {
        id: 'ci-1',
        variantId: 'variant-1',
        productName: 'Widget',
        variantLabel: null,
        productSlug: 'widget',
        unitPrice: 100,
        compareAtPrice: null,
        quantity: 2,
        lineTotal: 200,
        inStock: true,
        stockAvailable: 10,
        thumbnailUrl: null,
        weight: 0.5,
        productId: 'product-1',
        categoryId: 'cat-1',
      },
    ],
    subtotal: 200,
    discounts: [],
    shippingEstimate: null,
    taxEstimate: null,
    freeShippingProgress: null,
    total: 200,
    itemCount: 2,
    couponCode: null,
    crossSellProductIds: [],
    ...overrides,
  };
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'ORD-2026-000001',
    userId: 'user-1',
    status: OrderStatus.PENDING,
    paymentStatus: 'PENDING',
    shippingAddress: { country: 'LY', city: 'Tripoli' },
    billingAddress: { country: 'LY', city: 'Tripoli' },
    subtotal: dec(200),
    discountAmount: dec(0),
    shippingAmount: dec(10),
    taxAmount: dec(5),
    total: dec(215),
    shippingMethodName: 'Standard',
    currency: 'LYD',
    notes: null,
    internalNotes: null,
    couponCode: null,
    idempotencyKey: 'idem-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 'oi-1',
        orderId: 'order-1',
        variantId: 'variant-1',
        productId: 'product-1',
        productName: { default: 'Widget' },
        variantLabel: null,
        sku: 'WDG-001',
        unitPrice: dec(100),
        quantity: 2,
        total: dec(200),
        weight: dec(0.5),
        thumbnailUrl: null,
      },
    ],
    shipments: [],
    invoice: null,
    statusHistory: [],
    user: { id: 'user-1', email: 'test@example.com', firstName: 'Test', lastName: 'User' },
    ...overrides,
  };
}

function makePrisma() {
  return {
    order: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      // The status transition is WHERE-guarded on the status it validated
      // against, so a lost race writes zero rows instead of both winning.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
    orderStatusHistory: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orderItem: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    shipment: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      // M1: the cancel cascade flips PROCESSING rows in bulk and the SHIPPED
      // roll-up counts what is left, so both live on the mock.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    invoice: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    address: {
      findFirst: jest.fn(),
    },
    productVariant: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    // `findOneStorefront` resolves the catalogue slug per line. Defaults to an
    // empty result so every existing order-read test keeps its old shape and
    // only the tests that seed products see slugs.
    product: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findFirst: jest.fn(),
    },
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    auditLogEntry: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function makeIdempotency() {
  return {
    beginRequest: jest.fn().mockResolvedValue({ state: 'fresh' }),
    completeRequest: jest.fn().mockResolvedValue(undefined),
    abortRequest: jest.fn().mockResolvedValue(undefined),
    isReplay: jest.fn().mockReturnValue(false),
  };
}

function makeInventory() {
  return {
    checkAvailability: jest.fn(),
    decrementStock: jest.fn(),
    incrementStock: jest.fn(),
  };
}

function makePromotions() {
  return {
    validateCoupon: jest.fn(),
    getApplicableAutomatic: jest.fn(),
    recordUsage: jest.fn(),
    releaseUsageForOrder: jest.fn().mockResolvedValue(undefined),
  };
}

function makeGiftCards() {
  return {
    checkBalance: jest.fn().mockResolvedValue({ currentBalance: 0 }),
    redeem: jest.fn(),
    restoreForOrder: jest.fn().mockResolvedValue(undefined),
    issueStoreCredit: jest.fn(),
  };
}

function makeShipping() {
  return {
    calculateRates: jest.fn(),
    resolveDefaultRate: jest.fn(
      (rates: { isDefault?: boolean }[]) => rates.find((r) => r.isDefault) ?? rates[0] ?? null,
    ),
    // Default to "no zones configured" so shipping-agnostic createOrder tests
    // (sequence, snapshots, idempotency) keep the legacy 0-shipping path; the
    // SHIPPING_UNAVAILABLE test opts in by overriding this to true.
    hasActiveZones: jest.fn().mockResolvedValue(false),
  };
}

function makeTax() {
  // Resolves to a zero-rate result by default. Every path that composes an
  // order total now calls this, including `recalculateOrderTotals`, which
  // re-computes tax on edit rather than carrying the stored amount forward.
  return { calculateTax: jest.fn().mockResolvedValue({ rate: 0, amount: 0, zone: null }) };
}

function makeCart() {
  return {
    getCart: jest.fn(),
    clearCart: jest.fn(),
  };
}

function makeEvents() {
  return { emit: jest.fn() };
}

// ── Shared DTO ───────────────────────────────────────────────────────────────

const ADDRESS_DTO = {
  fullName: 'Test User',
  phone: '+218912345678',
  addressLine1: '123 St',
  city: 'Tripoli',
  country: 'LY',
};

const BASE_ORDER_DTO = {
  shippingAddress: ADDRESS_DTO,
  billingAddress: ADDRESS_DTO,
};

// ── Suite ────────────────────────────────────────────────────────────────────

/** The money formatter over the process snapshot, so amounts follow `storeMoney`. */
function moneyFormatterMock() {
  return {
    format: (value: unknown, code?: string | null) => storeMoney.format(value as never, code),
    currencyCode: () => storeMoney.currencyCode(),
    taxLabel: () => storeMoney.taxLabel(),
    config: () => storeMoney.current(),
  };
}

beforeEach(() => storeLocales.set(FR_EN_LOCALE_SET));
afterEach(() => storeLocales.set(NEUTRAL_LOCALE_SET));

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof makePrisma>;
  let idempotency: ReturnType<typeof makeIdempotency>;
  let inventory: ReturnType<typeof makeInventory>;
  let promotions: ReturnType<typeof makePromotions>;
  let giftCards: ReturnType<typeof makeGiftCards>;
  let shippingService: ReturnType<typeof makeShipping>;
  let taxService: ReturnType<typeof makeTax>;
  let cartService: ReturnType<typeof makeCart>;
  let events: ReturnType<typeof makeEvents>;
  let invoicePdf: { render: jest.Mock };
  let checkout: { getSettings: jest.Mock };
  let paymentMethods: { listStorefront: jest.Mock };
  let paymentGateway: {
    openSession: jest.Mock;
    capture: jest.Mock;
    refund: jest.Mock;
    cancel: jest.Mock;
    providerIdFor: jest.Mock;
    getStatus: jest.Mock;
    collectsPaymentOnline: jest.Mock;
  };
  let storage: { read: jest.Mock; save: jest.Mock; signUrl: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    prisma = makePrisma();
    // M1 runs the cancel cascade and the order update in one interactive
    // transaction. The mock hands the callback the same client so every
    // existing `prisma.order.update` expectation keeps working.
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    idempotency = makeIdempotency();
    inventory = makeInventory();
    promotions = makePromotions();
    giftCards = makeGiftCards();
    shippingService = makeShipping();
    taxService = makeTax();
    cartService = makeCart();
    events = makeEvents();
    invoicePdf = { render: jest.fn(async () => Buffer.from('%PDF-rendered')) };
    storage = { read: jest.fn(), save: jest.fn(), signUrl: jest.fn(), delete: jest.fn() };
    checkout = {
      getSettings: jest.fn().mockResolvedValue({
        guestCheckoutEnabled: true,
        requiredFields: ['email'],
        termsOfServiceUrl: null,
        postPurchaseRedirectUrl: null,
        checkoutMessage: null,
      }),
    };
    paymentMethods = {
      listStorefront: jest.fn().mockResolvedValue([
        {
          code: 'cod',
          name: {
            default: 'Cash on delivery',
            fr: 'Paiement à la livraison',
            en: 'Cash on delivery',
          },
          description: null,
          provider: 'cod',
          sortOrder: 0,
        },
      ]),
    };
    paymentGateway = {
      openSession: jest.fn(async (_code: string, { orderId }: { orderId: string }) => ({
        reference: `cod_${orderId}`,
        status: PaymentStatus.PENDING,
      })),
      capture: jest.fn(async (_code: string, { reference }: { reference: string }) => ({
        reference,
        status: PaymentStatus.CAPTURED,
      })),
      refund: jest.fn(async (_code: string, { reference }: { reference: string }) => ({
        reference,
        status: PaymentStatus.REFUNDED,
      })),
      cancel: jest.fn(async (_code: string, { reference }: { reference: string }) => ({
        reference,
        status: PaymentStatus.CANCELLED,
      })),
      providerIdFor: jest.fn().mockResolvedValue('cod'),
      collectsPaymentOnline: jest.fn().mockResolvedValue(true),
      getStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdempotencyService, useValue: idempotency },
        { provide: InventoryService, useValue: inventory },
        { provide: PromotionsService, useValue: promotions },
        { provide: GiftCardsService, useValue: giftCards },
        { provide: ShippingService, useValue: shippingService },
        { provide: TaxService, useValue: taxService },
        { provide: CartService, useValue: cartService },
        { provide: EventEmitter2, useValue: events },
        { provide: InvoicePdfService, useValue: invoicePdf },
        { provide: MoneyFormatterService, useValue: moneyFormatterMock() },
        { provide: STORAGE_DRIVER, useValue: storage },
        { provide: CheckoutService, useValue: checkout },
        { provide: PaymentMethodsService, useValue: paymentMethods },
        { provide: PaymentGatewayService, useValue: paymentGateway },
      ],
    }).compile();

    service = module.get(OrdersService);
  });

  // ── createOrder (guest checkout) ────────────────────────────────────────
  //
  // Plan F phase F3, finding K3. `Order.userId` has always been nullable for
  // the admin's manual orders, but nothing else on the row said who a
  // user-less order belonged to, so a guest could not be mailed, tracked, or
  // shown their own confirmation. These cases pin the branch that fills that
  // gap. The authed path is untouched by construction: the guest branch only
  // runs when there is no userId.
  describe('createOrder — guest', () => {
    const GUEST_DTO = {
      ...BASE_ORDER_DTO,
      guestEmail: 'guest@example.test',
    };

    /** The same fixtures `createOrder` uses, scoped to this block. */
    function setupGuestCreate() {
      cartService.getCart.mockResolvedValue(makeCartResponse());
      shippingService.calculateRates.mockResolvedValue([
        { methodId: 'sm-1', name: 'Standard', price: 10, estimatedDaysMin: 3, estimatedDaysMax: 5 },
      ]);
      taxService.calculateTax.mockResolvedValue({ rate: 0.05, amount: 10, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);
      prisma.productVariant.findMany.mockResolvedValue([
        {
          id: 'variant-1',
          sku: 'WDG-001',
          price: dec(100),
          weight: dec(0.5),
          productId: 'product-1',
          product: {
            id: 'product-1',
            name: { default: 'Widget', fr: 'Widget', en: 'Widget' },
            slug: 'widget',
            assets: [],
          },
          attributeValues: [],
        },
      ]);
      prisma.order.create.mockResolvedValue(makeOrder());
      promotions.recordUsage.mockResolvedValue(undefined);
      cartService.clearCart.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});
    }

    beforeEach(() => setupGuestCreate());

    it('refuses an anonymous order when the operator has guest checkout off', async () => {
      checkout.getSettings.mockResolvedValue({
        guestCheckoutEnabled: false,
        requiredFields: ['email'],
        termsOfServiceUrl: null,
        postPurchaseRedirectUrl: null,
        checkoutMessage: null,
      });
      await expect(
        service.createOrder(GUEST_DTO as never, undefined, 'idem-guest-off', 'fr', 'sess-1'),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_GUEST_CHECKOUT_DISABLED' } },
      });
    });

    it('checks the flag before it touches the cart, so the refusal is stable', async () => {
      checkout.getSettings.mockResolvedValue({
        guestCheckoutEnabled: false,
        requiredFields: [],
        termsOfServiceUrl: null,
        postPurchaseRedirectUrl: null,
        checkoutMessage: null,
      });
      await expect(
        service.createOrder(GUEST_DTO as never, undefined, 'idem-guest-off-2', 'fr', 'sess-1'),
      ).rejects.toThrow();
      expect(cartService.getCart).not.toHaveBeenCalled();
    });

    it('never consults the flag for a signed-in customer', async () => {
      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-authed-flag');
      expect(checkout.getSettings).not.toHaveBeenCalled();
    });

    it('requires a contact email, which the order access and the receipt depend on', async () => {
      await expect(
        service.createOrder(BASE_ORDER_DTO as never, undefined, 'idem-guest-noemail', 'fr', 's1'),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_GUEST_EMAIL_REQUIRED' } },
      });
    });

    it('requires an inline shipping address — a saved address id is meaningless here', async () => {
      await expect(
        service.createOrder(
          { guestEmail: 'guest@example.test', shippingAddressId: 'addr-1' } as never,
          undefined,
          'idem-guest-noaddr',
          'fr',
          's1',
        ),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_GUEST_ADDRESS_REQUIRED' } },
      });
    });

    it('writes the guest identity onto the order and leaves userId null', async () => {
      await service.createOrder(GUEST_DTO as never, undefined, 'idem-guest-ok', 'fr', 'sess-abc');
      const data = prisma.order.create.mock.calls[0][0].data;
      expect(data.userId).toBeNull();
      expect(data.guestEmail).toBe('guest@example.test');
      expect(data.guestSessionId).toBe('sess-abc');
      expect(data.guestLocale).toBe('fr');
    });

    it('normalises the contact email, so the track challenge can match it', async () => {
      await service.createOrder(
        { ...GUEST_DTO, guestEmail: '  Guest@Example.TEST ' } as never,
        undefined,
        'idem-guest-norm',
        'en',
        'sess-abc',
      );
      expect(prisma.order.create.mock.calls[0][0].data.guestEmail).toBe('guest@example.test');
    });

    it('reads and clears the anonymous session cart, not a user cart', async () => {
      await service.createOrder(GUEST_DTO as never, undefined, 'idem-guest-cart', 'fr', 'sess-abc');
      expect(cartService.getCart).toHaveBeenCalledWith(undefined, 'sess-abc');
      expect(cartService.clearCart).toHaveBeenCalledWith(undefined, 'sess-abc');
    });

    it('refuses a guest with no cart session rather than hashing them all alike', async () => {
      // The `guest:anonymous` fallback would hand every cookieless guest the
      // same caller hash, which is the collision the binding above exists to
      // avoid. There is also no cart to buy from without a session.
      await expect(
        service.createOrder(GUEST_DTO as never, undefined, 'idem-guest-nosess', 'fr', undefined),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_GUEST_SESSION_REQUIRED' } },
      });
    });

    it('binds the idempotency key to the session, not to a missing user id', async () => {
      // Every guest hashes `undefined` to the same value otherwise, so one
      // guest's key would collide with every other guest's.
      await service.createOrder(GUEST_DTO as never, undefined, 'idem-guest-hash', 'fr', 'sess-abc');
      const guestHash = idempotency.beginRequest.mock.calls[0][0].callerHash;

      idempotency.beginRequest.mockClear();
      await service.createOrder(GUEST_DTO as never, undefined, 'idem-guest-h2', 'fr', 'sess-xyz');
      const otherHash = idempotency.beginRequest.mock.calls[0][0].callerHash;

      expect(guestHash).not.toEqual(otherHash);
    });
  });

  // ── admin visibility of guest orders ────────────────────────────────────

  describe('admin search and export reach guest orders', () => {
    it('searches the guest contact address, which is the only address they have', async () => {
      // Support gets handed an email address and nothing else. Searching only
      // `user.email` cannot find a guest order at all, because there is no user
      // row to join to.
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);
      await service.listAdmin({ search: 'guest@example.test' } as never);
      const or = prisma.order.findMany.mock.calls[0][0].where.OR;
      expect(or).toEqual(
        expect.arrayContaining([
          { guestEmail: { contains: 'guest@example.test', mode: 'insensitive' } },
        ]),
      );
    });

    it('exports the guest contact address instead of a blank customer email', async () => {
      prisma.order.findMany.mockResolvedValue([
        {
          orderNumber: 'ORD-1',
          status: 'PENDING',
          paymentStatus: 'PENDING',
          total: dec(10),
          currency: 'LYD',
          createdAt: new Date('2026-08-30T00:00:00Z'),
          user: null,
          guestEmail: 'guest@example.test',
          items: [],
        },
      ]);
      const csv = await service.exportCsv({} as never);
      expect(csv).toContain('guest@example.test');
    });
  });

  // ── claimGuestOrders ────────────────────────────────────────────────────
  //
  // The seam between plan F phases F2 and F3. Signing in merges the anonymous
  // cart and then CLEARS the `sessionId` cookie, which is the only key to any
  // order that guest just placed. Without claiming, the canonical flow — pay as
  // a guest, then make an account to follow the order — destroys the customer's
  // own access: `GET /v1/orders/:id` refuses them forever, and the order is not
  // in their account list either, because it has no `userId`.
  describe('claimGuestOrders', () => {
    it('moves the session orders onto the account', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      await service.claimGuestOrders('user-1', 'sess-abc');
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { userId: null, guestSessionId: 'sess-abc' },
        data: { userId: 'user-1', guestSessionId: null },
      });
    });

    it('consumes the session id, so the credential stops being live', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      await service.claimGuestOrders('user-1', 'sess-abc');
      expect(prisma.order.updateMany.mock.calls[0][0].data.guestSessionId).toBeNull();
    });

    it('keeps the contact address, so the track page still answers', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      await service.claimGuestOrders('user-1', 'sess-abc');
      expect(prisma.order.updateMany.mock.calls[0][0].data).not.toHaveProperty('guestEmail');
    });

    it('never touches an order that already belongs to someone', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      await service.claimGuestOrders('user-1', 'sess-abc');
      expect(prisma.order.updateMany.mock.calls[0][0].where.userId).toBeNull();
    });

    it('is a no-op with no session id', async () => {
      await service.claimGuestOrders('user-1', undefined);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('is a no-op with no user id', async () => {
      await service.claimGuestOrders(undefined, 'sess-abc');
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── findOneAdmin (credential containment) ───────────────────────────────

  describe('findOneAdmin', () => {
    it('never hands the guest session id to an admin client', () => {
      // `guestSessionId` is the only key to a guest order, so it must not reach
      // browser devtools, an admin error report, or a support screenshot. The
      // customer-side allowlist cannot help here: this is a different
      // projection, and it returned the raw row.
      expect.assertions(2);
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: null,
        guestEmail: 'guest@example.test',
        guestSessionId: 'sess-secret-value',
        items: [],
        shipments: [],
        statusHistory: [],
      });
      return service.findOneAdmin('order-1').then((order) => {
        expect(order).not.toHaveProperty('guestSessionId');
        expect(JSON.stringify(order)).not.toContain('sess-secret-value');
      });
    });

    it('still carries the guest contact address, which support needs', () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: null,
        guestEmail: 'guest@example.test',
        guestSessionId: 'sess-secret-value',
        items: [],
        shipments: [],
        statusHistory: [],
      });
      return service.findOneAdmin('order-1').then((order) => {
        expect(order).toMatchObject({ guestEmail: 'guest@example.test' });
      });
    });
  });

  // ── findOneStorefront (guest read) ──────────────────────────────────────

  describe('findOneStorefront — guest', () => {
    function guestOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: 'order-1',
        userId: null,
        guestSessionId: 'sess-abc',
        guestEmail: 'guest@example.test',
        items: [],
        shipments: [],
        statusHistory: [],
        ...overrides,
      };
    }

    it('lets the browser that placed the order read it back', async () => {
      prisma.order.findUnique.mockResolvedValue(guestOrder());
      await expect(
        service.findOneStorefront('order-1', undefined, 'sess-abc'),
      ).resolves.toBeDefined();
    });

    it('refuses a different session', async () => {
      prisma.order.findUnique.mockResolvedValue(guestOrder());
      await expect(service.findOneStorefront('order-1', undefined, 'sess-other')).rejects.toThrow();
    });

    it('answers not-found rather than not-yours, so the route is not an existence oracle', async () => {
      // This route is anonymous now, so a 403-vs-404 split would let anyone
      // confirm whether a given order id exists, at 100 requests a minute.
      // Distinguishing them buys a stranger information and buys the owner
      // nothing.
      prisma.order.findUnique.mockResolvedValue(guestOrder());
      await expect(
        service.findOneStorefront('order-1', undefined, 'sess-other'),
      ).rejects.toMatchObject({ response: { error: { code: 'ORDER_NOT_FOUND' } } });
    });

    it('answers not-found when an ANONYMOUS caller probes an account order', async () => {
      prisma.order.findUnique.mockResolvedValue(guestOrder({ userId: 'user-1' }));
      await expect(
        service.findOneStorefront('order-1', undefined, 'sess-abc'),
      ).rejects.toMatchObject({ response: { error: { code: 'ORDER_NOT_FOUND' } } });
    });

    it('keeps the distinct not-yours for a signed-in customer, whose page renders it', async () => {
      prisma.order.findUnique.mockResolvedValue(guestOrder({ userId: 'user-1' }));
      await expect(service.findOneStorefront('order-1', 'user-2')).rejects.toMatchObject({
        response: { error: { code: 'ORDER_NOT_YOURS' } },
      });
    });

    it('refuses a caller with no session at all', async () => {
      prisma.order.findUnique.mockResolvedValue(guestOrder());
      await expect(service.findOneStorefront('order-1', undefined, undefined)).rejects.toThrow();
    });

    it('refuses a guest order whose session id was never recorded', async () => {
      // Otherwise a cookieless caller and a null column would match each other.
      prisma.order.findUnique.mockResolvedValue(guestOrder({ guestSessionId: null }));
      await expect(service.findOneStorefront('order-1', undefined, undefined)).rejects.toThrow();
    });

    it('never lets a session cookie open an account order', async () => {
      prisma.order.findUnique.mockResolvedValue(
        guestOrder({ userId: 'user-1', guestSessionId: null }),
      );
      await expect(service.findOneStorefront('order-1', undefined, 'sess-abc')).rejects.toThrow();
    });

    it('keeps the account path exactly as it was', async () => {
      prisma.order.findUnique.mockResolvedValue(guestOrder({ userId: 'user-1' }));
      await expect(service.findOneStorefront('order-1', 'user-1')).resolves.toBeDefined();
      await expect(service.findOneStorefront('order-1', 'user-2')).rejects.toThrow();
    });
  });

  // ── trackOrder (guest email challenge) ──────────────────────────────────

  describe('trackOrder — guest', () => {
    const A = new Date('2026-08-30T10:00:00.000Z');
    const B = new Date('2026-08-30T11:00:00.000Z');

    function trackable(overrides: Record<string, unknown> = {}) {
      return {
        id: 'order-1',
        orderNumber: 'ORD-1',
        user: null,
        guestEmail: 'guest@example.test',
        items: [],
        shipments: [],
        statusHistory: [],
        ...overrides,
      };
    }

    it('matches the guest email on a user-less order', async () => {
      prisma.order.findUnique.mockResolvedValue(trackable());
      await expect(
        service.trackOrder({ orderNumber: 'ORD-1', email: 'guest@example.test' }),
      ).resolves.toBeDefined();
    });

    it('matches case-insensitively and ignores surrounding space', async () => {
      // A customer retyping their address off a printed confirmation should not
      // be refused over capitalisation.
      prisma.order.findUnique.mockResolvedValue(trackable());
      await expect(
        service.trackOrder({ orderNumber: 'ORD-1', email: '  Guest@Example.TEST ' }),
      ).resolves.toBeDefined();
    });

    it('still refuses the wrong email', async () => {
      prisma.order.findUnique.mockResolvedValue(trackable());
      await expect(
        service.trackOrder({ orderNumber: 'ORD-1', email: 'someone@else.test' }),
      ).rejects.toThrow();
    });

    it('refuses a user-less order that carries no guest email either', async () => {
      prisma.order.findUnique.mockResolvedValue(trackable({ guestEmail: null }));
      await expect(
        service.trackOrder({ orderNumber: 'ORD-1', email: 'guest@example.test' }),
      ).rejects.toThrow();
    });

    // ── timeline on the track response (findings K11, AD6) ────────────────
    //
    // The track surface rendered a status pill and nothing else, because the
    // endpoint sent no history. It now sends the same projection the authed
    // order-detail page reads, so a customer who lost their session sees the
    // same story as one who did not.

    it('sends the status history, projected the way the customer shape does', async () => {
      prisma.order.findUnique.mockResolvedValue(
        trackable({
          statusHistory: [
            { id: 'h1', orderId: 'order-1', fromStatus: null, toStatus: 'PENDING', createdAt: A },
            {
              id: 'h2',
              orderId: 'order-1',
              fromStatus: 'PENDING',
              toStatus: 'CONFIRMED',
              createdAt: B,
            },
          ],
        }),
      );

      const result = (await service.trackOrder({
        orderNumber: 'ORD-1',
        email: 'guest@example.test',
      })) as { timeline: { status: string; at: Date }[] };

      expect(result.timeline).toEqual([
        { status: 'PENDING', at: A },
        { status: 'CONFIRMED', at: B },
      ]);
    });

    it('never leaks the internal history columns to a public caller', async () => {
      prisma.order.findUnique.mockResolvedValue(
        trackable({
          statusHistory: [
            { id: 'h1', orderId: 'order-1', fromStatus: null, toStatus: 'PENDING', createdAt: A },
          ],
        }),
      );

      const result = (await service.trackOrder({
        orderNumber: 'ORD-1',
        email: 'guest@example.test',
      })) as { timeline: Record<string, unknown>[] };

      expect(Object.keys(result.timeline[0]).sort()).toEqual(['at', 'status']);
    });

    it('sends an empty timeline rather than undefined for an order with no rows', async () => {
      prisma.order.findUnique.mockResolvedValue(trackable());

      const result = (await service.trackOrder({
        orderNumber: 'ORD-1',
        email: 'guest@example.test',
      })) as { timeline: unknown[] };

      expect(result.timeline).toEqual([]);
    });

    it('asks the database for the history in timeline order', async () => {
      prisma.order.findUnique.mockResolvedValue(trackable());

      await service.trackOrder({ orderNumber: 'ORD-1', email: 'guest@example.test' });

      const args = prisma.order.findUnique.mock.calls.at(-1)?.[0] as {
        include: { statusHistory?: unknown };
      };
      expect(args.include.statusHistory).toEqual({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });

    it('never sends the customer email back, on either identity path', async () => {
      // The response is public behind a shared secret, so it must not confirm
      // anything the caller did not already supply.
      prisma.order.findUnique.mockResolvedValue(trackable());

      const result = (await service.trackOrder({
        orderNumber: 'ORD-1',
        email: 'guest@example.test',
      })) as Record<string, unknown>;

      expect(Object.keys(result).sort()).toEqual([
        'createdAt',
        'orderNumber',
        'paymentRetryable',
        'paymentStatus',
        'shipments',
        'status',
        'timeline',
      ]);
    });

    // ── payment state on the track response (finding C13) ─────────────────

    it('sends the payment state and whether the payment can be retried', async () => {
      prisma.order.findUnique.mockResolvedValue(
        trackable({
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          paymentMethodCode: 'card',
        }),
      );

      const result = (await service.trackOrder({
        orderNumber: 'ORD-1',
        email: 'guest@example.test',
      })) as { paymentStatus: string; paymentRetryable: boolean };

      expect(result.paymentStatus).toBe(PaymentStatus.PENDING);
      expect(result.paymentRetryable).toBe(true);
    });

    it('sends paymentRetryable false for a cancelled order', async () => {
      prisma.order.findUnique.mockResolvedValue(
        trackable({
          status: OrderStatus.CANCELLED,
          paymentStatus: PaymentStatus.PENDING,
          paymentMethodCode: 'card',
        }),
      );

      const result = (await service.trackOrder({
        orderNumber: 'ORD-1',
        email: 'guest@example.test',
      })) as { paymentRetryable: boolean };

      expect(result.paymentRetryable).toBe(false);
    });
  });

  describe('retryTrackedPayment (guest pay again behind the email challenge)', () => {
    const action = { type: 'redirect', url: 'https://pay.example.test/s' };

    function payable(overrides: Record<string, unknown> = {}) {
      return makeOrder({
        userId: null,
        guestSessionId: 'sess-other',
        user: null,
        guestEmail: 'guest@example.test',
        paymentMethodCode: 'card',
        paymentStatus: PaymentStatus.PENDING,
        paymentReference: 'pi_old',
        ...overrides,
      });
    }

    it('opens a new session when the email matches, with no cart session needed', async () => {
      prisma.order.findUnique.mockResolvedValue(payable());
      paymentGateway.openSession.mockResolvedValueOnce({
        reference: 'pi_new',
        status: PaymentStatus.PENDING,
        action,
      });

      const result = await service.retryTrackedPayment(
        { orderNumber: 'ORD-2026-000001', email: ' Guest@Example.test ' },
        'en',
      );

      expect(result).toEqual({ paymentAction: action });
      expect(paymentGateway.openSession).toHaveBeenCalledWith(
        'card',
        expect.objectContaining({
          returnUrl: 'https://storefront.example.test/en/order-confirmation/ORD-2026-000001',
        }),
      );
    });

    it('answers not found for the wrong email and opens nothing', async () => {
      prisma.order.findUnique.mockResolvedValue(payable());

      await expect(
        service.retryTrackedPayment(
          { orderNumber: 'ORD-2026-000001', email: 'someone@else.test' },
          'en',
        ),
      ).rejects.toMatchObject({ response: { error: { code: 'ORDER_NOT_FOUND' } } });
      expect(paymentGateway.openSession).not.toHaveBeenCalled();
    });

    it('refuses a payment that is not retryable', async () => {
      prisma.order.findUnique.mockResolvedValue(payable({ status: OrderStatus.CANCELLED }));

      await expect(
        service.retryTrackedPayment(
          { orderNumber: 'ORD-2026-000001', email: 'guest@example.test' },
          'en',
        ),
      ).rejects.toMatchObject({ response: { error: { code: 'ORDER_PAYMENT_NOT_RETRYABLE' } } });
      expect(paymentGateway.openSession).not.toHaveBeenCalled();
    });
  });

  // ── createManualOrder (admin manual order) ──────────────────────────────

  describe('createManualOrder', () => {
    const VARIANT_ROW = {
      id: 'variant-1',
      sku: 'WDG-001',
      price: dec(100),
      weight: dec(0.5),
      isActive: true,
      productId: 'product-1',
      product: {
        id: 'product-1',
        name: { default: 'Widget', fr: 'Widget', en: 'Widget' },
        slug: 'widget',
        deletedAt: null,
        assets: [],
      },
      attributeValues: [],
    };

    const MANUAL_DTO = {
      items: [{ variantId: 'variant-1', quantity: 2 }],
      shippingAddress: ADDRESS_DTO,
    };

    function setupManual() {
      prisma.productVariant.findMany.mockResolvedValue([VARIANT_ROW]);
      shippingService.calculateRates.mockResolvedValue([
        {
          methodId: 'sm-std',
          name: { default: 'Standard Delivery' },
          price: 10,
          isDefault: true,
          estimatedDaysMin: 1,
          estimatedDaysMax: 3,
        },
      ]);
      taxService.calculateTax.mockResolvedValue({ rate: 0.05, amount: 10, zone: null });
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);
      prisma.order.create.mockResolvedValue(makeOrder());
      prisma.user.findFirst.mockResolvedValue({ id: 'cust-1' });
    }

    it('creates a manual order with the default shipping folded into the total', async () => {
      setupManual();

      const result = await service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m1');

      expect(result).toHaveProperty('id', 'order-1');
      // subtotal 200 + shipping 10 + tax 10 = 220
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            subtotal: 200,
            shippingAmount: 10,
            shippingMethodName: 'Standard Delivery',
            taxAmount: 10,
            total: 220,
          }),
        }),
      );
    });

    // The admin manual-order path shares the AD2 defect: same join, same column.
    it('snapshots the line label as resolved text under the admin request locale', async () => {
      setupManual();
      prisma.productVariant.findMany.mockResolvedValue([
        {
          ...VARIANT_ROW,
          attributeValues: [
            { attributeValue: { value: { default: 'Métal', fr: 'Métal', en: 'Metal' } } },
            { attributeValue: { value: { default: 'Grand', fr: 'Grand', en: 'Large' } } },
          ],
        },
      ]);

      await service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m-label', 'en');

      const created = prisma.order.create.mock.calls.at(-1)?.[0] as {
        data: { items: { create: { variantLabel: string | null }[] } };
      };
      expect(created.data.items.create[0].variantLabel).toBe('Metal, Large');
    });

    it('throws ORDER_VARIANT_NOT_FOUND when a line item variant is missing', async () => {
      setupManual();
      prisma.productVariant.findMany.mockResolvedValue([]);

      await expect(
        service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m2'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('does not look up a customer for a guest order (no userId)', async () => {
      setupManual();

      await service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m3');

      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('throws when a linked customer does not exist', async () => {
      setupManual();
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.createManualOrder(
          { ...MANUAL_DTO, userId: 'missing' } as never,
          'admin-1',
          'idem-m4',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('rolls back stock and aborts idempotency when order.create fails', async () => {
      setupManual();
      prisma.order.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m5'),
      ).rejects.toThrow('db down');

      expect(inventory.incrementStock).toHaveBeenCalledWith(
        'variant-1',
        2,
        expect.anything(),
        expect.objectContaining({ referenceType: 'OrderRollback' }),
      );
      expect(idempotency.abortRequest).toHaveBeenCalled();
    });

    it('throws SHIPPING_UNAVAILABLE when no rate resolves but the store has active zones', async () => {
      setupManual();
      shippingService.calculateRates.mockResolvedValue([]);
      shippingService.hasActiveZones.mockResolvedValue(true);

      await expect(
        service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m6'),
      ).rejects.toBeInstanceOf(ShippingUnavailableException);
      expect(inventory.decrementStock).not.toHaveBeenCalled();
    });

    // ── Accept-Language polarity on the manual-order path ────────────────────
    //
    // `createManualOrder` snapshots the shipping-method name through the same
    // `localeFromHeader` helper as `createOrder`, and D2 flipped that helper's
    // polarity: an unrecognised header now resolves to `fr`, where it used to
    // resolve to `en`. `setupManual`'s rate carries the single-key name
    // `{ default: 'Standard Delivery' }`, which resolves to the same string
    // under every locale, so the polarity was never exercised here.
    //
    // The fixture below gives `default`, `fr` and `en` three DIFFERENT strings,
    // so the asserted value names exactly which key answered: `default` would
    // mean the locale key missed, and `en` would mean the pre-D2 polarity.

    const LOCALISED_RATE = {
      methodId: 'sm-std',
      name: {
        default: 'Livraison par defaut',
        fr: 'Livraison standard',
        en: 'Standard Delivery',
      },
      price: 10,
      isDefault: true,
      estimatedDaysMin: 1,
      estimatedDaysMax: 3,
    };

    it('snapshots the fr shipping name when Accept-Language is unrecognised', async () => {
      setupManual();
      shippingService.calculateRates.mockResolvedValue([LOCALISED_RATE]);

      await service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m7', 'de-DE');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingMethodName: 'Livraison standard' }),
        }),
      );
    });

    it('snapshots the fr shipping name when the admin sends no Accept-Language', async () => {
      setupManual();
      shippingService.calculateRates.mockResolvedValue([LOCALISED_RATE]);

      await service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m8');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingMethodName: 'Livraison standard' }),
        }),
      );
    });

    it('snapshots the en shipping name when Accept-Language asks for en', async () => {
      // The control for the two cases above: without it, hardcoding `fr` in
      // place of the helper would keep them both green.
      setupManual();
      shippingService.calculateRates.mockResolvedValue([LOCALISED_RATE]);

      await service.createManualOrder(MANUAL_DTO as never, 'admin-1', 'idem-m9', 'en-GB,en;q=0.9');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingMethodName: 'Standard Delivery' }),
        }),
      );
    });
  });

  // ── createOrder (basics) ────────────────────────────────────────────────

  describe('createOrder', () => {
    function setupCreate(variantPrice = 100) {
      cartService.getCart.mockResolvedValue(makeCartResponse());
      shippingService.calculateRates.mockResolvedValue([
        { methodId: 'sm-1', name: 'Standard', price: 10, estimatedDaysMin: 3, estimatedDaysMax: 5 },
      ]);
      taxService.calculateTax.mockResolvedValue({ rate: 0.05, amount: 10, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);
      prisma.productVariant.findMany.mockResolvedValue([
        {
          id: 'variant-1',
          sku: 'WDG-001',
          price: dec(variantPrice),
          weight: dec(0.5),
          productId: 'product-1',
          product: {
            id: 'product-1',
            name: { default: 'Widget', fr: 'Widget', en: 'Widget' },
            slug: 'widget',
            assets: [],
          },
          attributeValues: [],
        },
      ]);
      prisma.order.create.mockResolvedValue(makeOrder());
      promotions.recordUsage.mockResolvedValue(undefined);
      cartService.clearCart.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});
    }

    /**
     * Plan F phase F5, findings K2 (payment half), D2 and D3.
     *
     * The payment-methods module was admin-only config nothing consumed:
     * checkout hardcoded a COD note, no code reached the API, and the order
     * row had no field to record what the customer chose. The snapshot columns
     * landed with F3; these pin what writes them.
     */
    describe('payment method', () => {
      function createdOrderData(): Record<string, unknown> {
        return prisma.order.create.mock.calls[0][0].data as Record<string, unknown>;
      }

      it('snapshots the code and the locale-resolved name of the chosen method', async () => {
        setupCreate();
        await service.createOrder(
          { ...BASE_ORDER_DTO, paymentMethodCode: 'cod' } as never,
          'user-1',
          'idem-pm-1',
          'fr',
        );
        const data = createdOrderData();
        expect(data.paymentMethodCode).toBe('cod');
        // The name column is plain text, outside the locale interceptor's
        // reach, so it is resolved at write time like `shippingMethodName`.
        expect(data.paymentMethodName).toBe('Paiement à la livraison');
      });

      it('refuses a code that is not in the enabled set', async () => {
        setupCreate();
        await expect(
          service.createOrder(
            { ...BASE_ORDER_DTO, paymentMethodCode: 'stripe' } as never,
            'user-1',
            'idem-pm-2',
            'en',
          ),
        ).rejects.toMatchObject({
          response: { error: { code: 'ORDER_PAYMENT_METHOD_INVALID' } },
        });
        expect(prisma.order.create).not.toHaveBeenCalled();
      });

      it('refuses every order when the operator has enabled no method at all', async () => {
        // Pass-2 finding D2: the store had zero methods configured and orders
        // were placed anyway as implicit COD, which is a tender nobody chose.
        setupCreate();
        paymentMethods.listStorefront.mockResolvedValue([]);
        await expect(
          service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-pm-3', 'en'),
        ).rejects.toMatchObject({
          response: { error: { code: 'ORDER_PAYMENT_METHOD_UNAVAILABLE' } },
        });
        expect(prisma.order.create).not.toHaveBeenCalled();
      });

      it('falls back to the single enabled method when the client sends no code', async () => {
        // Old clients and replayed payloads still have to place an order, and
        // a store with exactly one tender has no ambiguity to resolve.
        setupCreate();
        await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-pm-4', 'en');
        const data = createdOrderData();
        expect(data.paymentMethodCode).toBe('cod');
        expect(data.paymentMethodName).toBe('Cash on delivery');
      });

      it('requires an explicit choice when the operator offers more than one', async () => {
        setupCreate();
        paymentMethods.listStorefront.mockResolvedValue([
          { code: 'cod', name: { default: 'COD' }, provider: 'cod', sortOrder: 0 },
          { code: 'bank', name: { default: 'Bank transfer' }, provider: 'manual', sortOrder: 1 },
        ]);
        await expect(
          service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-pm-5', 'en'),
        ).rejects.toMatchObject({
          response: { error: { code: 'ORDER_PAYMENT_METHOD_INVALID' } },
        });
      });

      it('leaves paymentStatus off the create: only the provider session sets it', async () => {
        setupCreate();
        await service.createOrder(
          { ...BASE_ORDER_DTO, paymentMethodCode: 'cod' } as never,
          'user-1',
          'idem-pm-6',
          'en',
        );
        expect(createdOrderData().paymentStatus).toBeUndefined();
      });

      it('opens a provider session and stores its reference and status on the order', async () => {
        setupCreate();
        prisma.user.findFirst.mockResolvedValue({ email: 'test@example.com' });
        await service.createOrder(
          { ...BASE_ORDER_DTO, paymentMethodCode: 'cod' } as never,
          'user-1',
          'idem-pm-7',
          'en',
        );

        const order = makeOrder();
        expect(paymentGateway.openSession).toHaveBeenCalledWith('cod', {
          orderId: 'order-1',
          amount: expect.any(Prisma.Decimal),
          currencyCode: order.currency,
          returnUrl: `https://storefront.example.test/en/order-confirmation/${order.orderNumber}`,
          customerEmail: 'test@example.com',
        });
        expect(prisma.order.update).toHaveBeenCalledWith({
          where: { id: 'order-1' },
          data: { paymentReference: 'cod_order-1', paymentStatus: PaymentStatus.PENDING },
        });
      });

      it('returns the session action next to the order, without storing it', async () => {
        setupCreate();
        const action = { type: 'embedded', clientToken: 'tok_1', publicConfig: { k: 'pk' } };
        paymentGateway.openSession.mockResolvedValueOnce({
          reference: 'pi_1',
          status: PaymentStatus.PENDING,
          action,
        });
        const result = (await service.createOrder(
          { ...BASE_ORDER_DTO, paymentMethodCode: 'cod' } as never,
          'user-1',
          'idem-pm-act',
          'en',
        )) as unknown as Record<string, unknown>;

        expect(result['paymentAction']).toEqual(action);
        expect(prisma.order.update).toHaveBeenCalledWith({
          where: { id: 'order-1' },
          data: { paymentReference: 'pi_1', paymentStatus: PaymentStatus.PENDING },
        });
      });

      it('opens the session before the cart is cleared', async () => {
        setupCreate();
        await service.createOrder(
          { ...BASE_ORDER_DTO, paymentMethodCode: 'cod' } as never,
          'user-1',
          'idem-pm-8',
          'en',
        );
        expect(paymentGateway.openSession.mock.invocationCallOrder[0]).toBeLessThan(
          cartService.clearCart.mock.invocationCallOrder[0],
        );
      });

      it('rolls the order and the stock back when the provider refuses the session', async () => {
        setupCreate();
        paymentGateway.openSession.mockRejectedValue(new Error('provider down'));

        await expect(
          service.createOrder(
            { ...BASE_ORDER_DTO, paymentMethodCode: 'cod' } as never,
            'user-1',
            'idem-pm-9',
            'en',
          ),
        ).rejects.toThrow('provider down');

        // OrderItem.order is onDelete: Restrict, so a bare order.delete always
        // fails once the lines exist and leaves an orphan PENDING order.
        expect(prisma.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'order-1' } });
        expect(prisma.order.delete).toHaveBeenCalledWith({ where: { id: 'order-1' } });
        expect(prisma.orderItem.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.order.delete.mock.invocationCallOrder[0],
        );
        expect(inventory.incrementStock).toHaveBeenCalled();
        expect(cartService.clearCart).not.toHaveBeenCalled();
        expect(idempotency.completeRequest).not.toHaveBeenCalled();
        expect(paymentGateway.cancel).not.toHaveBeenCalled();
      });

      it('cancels the opened payment session when a later checkout step fails', async () => {
        setupCreate();
        cartService.clearCart.mockRejectedValue(new Error('cart store down'));

        await expect(
          service.createOrder(
            { ...BASE_ORDER_DTO, paymentMethodCode: 'cod' } as never,
            'user-1',
            'idem-pm-10',
            'en',
          ),
        ).rejects.toThrow('cart store down');

        expect(paymentGateway.cancel).toHaveBeenCalledWith('cod', {
          reference: 'cod_order-1',
          status: PaymentStatus.PENDING,
          idempotencyKey: 'checkout-cancel:order-1',
        });
        expect(prisma.order.delete).toHaveBeenCalledWith({ where: { id: 'order-1' } });
      });

      it('still rolls the order back when the session cancel fails', async () => {
        setupCreate();
        cartService.clearCart.mockRejectedValue(new Error('cart store down'));
        paymentGateway.cancel.mockRejectedValue(new Error('provider down'));

        await expect(
          service.createOrder(
            { ...BASE_ORDER_DTO, paymentMethodCode: 'cod' } as never,
            'user-1',
            'idem-pm-11',
            'en',
          ),
        ).rejects.toThrow('cart store down');

        expect(prisma.order.delete).toHaveBeenCalledWith({ where: { id: 'order-1' } });
        expect(inventory.incrementStock).toHaveBeenCalled();
      });
    });

    // ── variantLabel snapshot (finding AD2) ───────────────────────
    //
    // `OrderItem.variantLabel` is a plain text column, outside the Translatable
    // interceptor's reach, so the label is resolved at write time. All three
    // order-writing paths used to join `attributeValue.value` into a string and
    // every one of those values is a Translatable object, so the admin order
    // page rendered "[object Object]" once per attribute per line.

    const ATTRIBUTE_VALUES = [
      { attributeValue: { value: { default: 'Métal', fr: 'Métal', en: 'Metal' } } },
      { attributeValue: { value: { default: 'Grand', fr: 'Grand', en: 'Large' } } },
    ];

    function setupCreateWithAttributes() {
      setupCreate();
      prisma.productVariant.findMany.mockResolvedValue([
        {
          id: 'variant-1',
          sku: 'WDG-001',
          price: dec(100),
          weight: dec(0.5),
          productId: 'product-1',
          product: {
            id: 'product-1',
            name: { default: 'Widget', fr: 'Widget', en: 'Widget' },
            slug: 'widget',
            assets: [],
          },
          attributeValues: ATTRIBUTE_VALUES,
        },
      ]);
    }

    function createdVariantLabel() {
      const created = prisma.order.create.mock.calls.at(-1)?.[0] as {
        data: { items: { create: { variantLabel: string | null }[] } };
      };
      return created.data.items.create[0].variantLabel;
    }

    it('snapshots each line label as resolved text under the requested locale', async () => {
      setupCreateWithAttributes();

      await service.createOrder(BASE_ORDER_DTO, 'user-1', 'idem-label-en', 'en');

      expect(createdVariantLabel()).toBe('Metal, Large');
    });

    it('snapshots each line label in French for a French shopper', async () => {
      setupCreateWithAttributes();

      await service.createOrder(BASE_ORDER_DTO, 'user-1', 'idem-label-fr', 'fr');

      expect(createdVariantLabel()).toBe('Métal, Grand');
    });

    it('snapshots the default rung when the request states no locale', async () => {
      setupCreateWithAttributes();

      await service.createOrder(BASE_ORDER_DTO, 'user-1', 'idem-label-default');

      expect(createdVariantLabel()).toBe('Métal, Grand');
    });

    it('gives a new order its birth row in the same write that creates it', async () => {
      // Nested into the order's own create, so an order can never exist without
      // the first row of its timeline (finding AD6).
      setupCreate();

      await service.createOrder(BASE_ORDER_DTO, 'user-1', 'idem-history-1', 'en');

      const created = prisma.order.create.mock.calls.at(-1)?.[0] as {
        data: { statusHistory?: { create: Record<string, unknown> } };
      };
      expect(created.data.statusHistory).toEqual({
        create: { toStatus: OrderStatus.PENDING },
      });
    });

    it('charges nothing for shipping when a FREE_SHIPPING promotion applies', async () => {
      // The promotions engine returns 0 for FREE_SHIPPING and calls it a
      // signal, to be honoured at checkout. `createOrder` set
      // `shippingAmount = selected.price` unconditionally and never looked at
      // the automatic list, so a cart that displayed "free shipping,
      // qualified" was charged the full rate on placement.
      setupCreate();
      promotions.getApplicableAutomatic.mockResolvedValue([
        {
          promotionId: 'promo-freeship',
          type: 'FREE_SHIPPING',
          discountAmount: 0,
          label: { default: 'Free shipping over 300 LYD' },
          priority: 5,
        },
      ]);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-free-ship');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            shippingAmount: 0,
            // The shopper still gets the delivery method, at no charge.
            shippingMethodName: 'Standard',
          }),
        }),
      );
    });

    it('still charges shipping when no FREE_SHIPPING promotion is in the list', async () => {
      setupCreate();
      promotions.getApplicableAutomatic.mockResolvedValue([
        {
          promotionId: 'promo-pct',
          type: 'PERCENTAGE',
          discountAmount: 20,
          label: { default: 'Sale' },
          priority: 1,
        },
      ]);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-paid-ship');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ shippingAmount: 10 }) }),
      );
    });

    it('evaluates promotions against the real product and category of each line', async () => {
      // Promo items were built with empty ids ("Not needed for amount-based
      // promos"), while the cart built real ones. Any promotion restricted to
      // certain products or categories therefore applied in the cart and
      // silently evaporated at order create.
      setupCreate();

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-promo-items');

      expect(promotions.getApplicableAutomatic).toHaveBeenCalledWith(
        200,
        [{ productId: 'product-1', categoryId: 'cat-1', quantity: 2, unitPrice: 100 }],
        'user-1',
      );
    });

    it('creates an order and returns it', async () => {
      setupCreate();
      const result = await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');
      expect(result).toHaveProperty('id', 'order-1');
      expect(prisma.order.create).toHaveBeenCalled();
    });

    it('persists the shipping amount + method name and folds shipping into the total', async () => {
      setupCreate();

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');

      // subtotal 200 − discount 0 + shipping 10 + tax 10 = 220
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subtotal: 200,
            shippingAmount: 10,
            shippingMethodName: 'Standard',
            taxAmount: 10,
            total: 220,
          }),
        }),
      );
    });

    it('snapshots the shipping method name in the customer locale (fr)', async () => {
      setupCreate();
      shippingService.calculateRates.mockResolvedValue([
        {
          methodId: 'sm-std',
          name: {
            default: 'Livraison standard',
            fr: 'Livraison standard',
            en: 'Standard Delivery',
          },
          price: 10,
          isDefault: true,
          estimatedDaysMin: null,
          estimatedDaysMax: null,
        },
      ]);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1', 'fr');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingMethodName: 'Livraison standard' }),
        }),
      );
    });

    it('snapshots the shipping method name in en when Accept-Language asks for en', async () => {
      setupCreate();
      shippingService.calculateRates.mockResolvedValue([
        {
          methodId: 'sm-std',
          name: {
            default: 'Livraison standard',
            fr: 'Livraison standard',
            en: 'Standard Delivery',
          },
          price: 10,
          isDefault: true,
          estimatedDaysMin: null,
          estimatedDaysMax: null,
        },
      ]);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-en', 'en-GB,en;q=0.9');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingMethodName: 'Standard Delivery' }),
        }),
      );
    });

    it('snapshots the fr name when Accept-Language is absent or unrecognised', async () => {
      // Polarity check, not a rename: an unrecognised header resolves to the
      // store default `fr`. Under the previous client it resolved to `en`, so
      // an en-only assertion here would pass for the wrong reason.
      setupCreate();
      shippingService.calculateRates.mockResolvedValue([
        {
          methodId: 'sm-std',
          name: {
            default: 'Livraison standard',
            fr: 'Livraison standard',
            en: 'Standard Delivery',
          },
          price: 10,
          isDefault: true,
          estimatedDaysMin: null,
          estimatedDaysMax: null,
        },
      ]);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-de', 'de-DE');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingMethodName: 'Livraison standard' }),
        }),
      );
    });

    it('falls back through the store default, then default, exactly like the canonical resolver', async () => {
      // The rung order is the assertion. `orders.service.ts` carried its own
      // two-and-a-half rung copy that went locale, default, en, so a row whose
      // `default` differs from both localised strings snapshotted a different
      // value here than the response interceptor resolves for the same row and
      // the same locale. Constitution 3.14: one resolver.
      //
      // A name with no `fr` is what separates the two chains. The old one
      // answered `default`, the canonical one answers `en`.
      setupCreate();
      shippingService.calculateRates.mockResolvedValue([
        {
          methodId: 'sm-std',
          name: { default: 'Valeur par defaut', en: 'Standard Delivery' },
          price: 10,
          isDefault: true,
          estimatedDaysMin: null,
          estimatedDaysMax: null,
        },
      ]);

      // The middle rung is the store default locale (DR-31); this store's is en.
      storeLocales.set({
        supportedLocales: ['fr', 'en'],
        defaultLocale: 'en',
        rtlLocales: [],
        timezone: 'UTC',
      });
      try {
        await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-rungs', 'fr');
      } finally {
        storeLocales.set(NEUTRAL_LOCALE_SET);
      }

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingMethodName: 'Standard Delivery' }),
        }),
      );
    });

    it('uses the resolved default rate when no shipping method is requested', async () => {
      setupCreate();
      shippingService.calculateRates.mockResolvedValue([
        {
          methodId: 'sm-cheap',
          name: 'Cheap',
          price: 5,
          isDefault: false,
          estimatedDaysMin: null,
          estimatedDaysMax: null,
        },
        {
          methodId: 'sm-std',
          name: 'Standard Delivery',
          price: 10,
          isDefault: true,
          estimatedDaysMin: null,
          estimatedDaysMax: null,
        },
      ]);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            shippingAmount: 10,
            shippingMethodName: 'Standard Delivery',
          }),
        }),
      );
    });

    it('throws SHIPPING_METHOD_INVALID when the requested method is not among the rates', async () => {
      setupCreate();
      shippingService.calculateRates.mockResolvedValue([
        {
          methodId: 'sm-1',
          name: 'Standard',
          price: 10,
          isDefault: true,
          estimatedDaysMin: null,
          estimatedDaysMax: null,
        },
      ]);

      await expect(
        service.createOrder(
          { ...BASE_ORDER_DTO, shippingMethodId: 'does-not-exist' } as never,
          'user-1',
          'idem-1',
        ),
      ).rejects.toBeInstanceOf(ShippingMethodInvalidException);
    });

    it('throws SHIPPING_UNAVAILABLE when no rate resolves but the store has active zones', async () => {
      setupCreate();
      shippingService.calculateRates.mockResolvedValue([]);
      shippingService.hasActiveZones.mockResolvedValue(true);

      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1'),
      ).rejects.toBeInstanceOf(ShippingUnavailableException);
    });

    it('charges 0 shipping (legacy) when the store has no shipping zones at all', async () => {
      setupCreate();
      shippingService.calculateRates.mockResolvedValue([]);
      shippingService.hasActiveZones.mockResolvedValue(false);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingAmount: 0, shippingMethodName: null }),
        }),
      );
    });

    it('throws BadRequest when cart is empty', async () => {
      cartService.getCart.mockResolvedValue(makeCartResponse({ items: [] }));
      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws Conflict when items are out of stock', async () => {
      cartService.getCart.mockResolvedValue(
        makeCartResponse({ items: [{ ...makeCartResponse().items[0], inStock: false }] }),
      );
      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('decrements stock for each item', async () => {
      setupCreate();
      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');
      expect(inventory.decrementStock).toHaveBeenCalledWith(
        'variant-1',
        2,
        expect.objectContaining({ referenceType: 'Order' }),
      );
    });

    it('rolls back stock on decrement failure and rethrows', async () => {
      const twoItems = makeCartResponse({
        items: [
          { ...makeCartResponse().items[0], variantId: 'v-1' },
          { ...makeCartResponse().items[0], variantId: 'v-2' },
        ],
      });
      cartService.getCart.mockResolvedValue(twoItems);
      shippingService.calculateRates.mockResolvedValue([]);
      taxService.calculateTax.mockResolvedValue({ rate: 0, amount: 0, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);
      prisma.productVariant.findMany.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      inventory.incrementStock.mockResolvedValue(undefined);

      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1'),
      ).rejects.toThrow(ConflictException);

      expect(inventory.incrementStock).toHaveBeenCalledWith(
        'v-1',
        2,
        expect.anything(),
        expect.objectContaining({ referenceType: 'OrderRollback' }),
      );
    });

    it('clears the cart after successful order', async () => {
      setupCreate();
      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');
      expect(cartService.clearCart).toHaveBeenCalledWith('user-1');
    });

    it('completes the idempotency record on success — scope orders, entityId order.id', async () => {
      setupCreate();
      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');
      expect(idempotency.completeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'orders',
          key: 'idem-1',
          entityId: 'order-1',
          responseJson: expect.objectContaining({ id: 'order-1' }),
        }),
      );
    });

    it('caches the SERIALIZED payload, so a replay cannot leak admin fields (plan J)', async () => {
      setupCreate();
      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');

      // The cached payload is replayed verbatim for the 24h idempotency TTL,
      // so serializing only the return value would keep leaking for a day.
      const cached = idempotency.completeRequest.mock.calls.at(-1)?.[0] as {
        responseJson: Record<string, unknown>;
      };
      expect(cached.responseJson).not.toHaveProperty('internalNotes');
      expect(cached.responseJson).not.toHaveProperty('idempotencyKey');
      expect(cached.responseJson).not.toHaveProperty('userId');
      expect(cached.responseJson).not.toHaveProperty('user');
    });

    it('returns the customer shape, not the raw created row (plan J)', async () => {
      setupCreate();
      prisma.order.create.mockResolvedValue(
        makeOrder({ internalNotes: 'admin only', idempotencyKey: 'idem-1' }),
      );

      const result = (await service.createOrder(
        BASE_ORDER_DTO as never,
        'user-1',
        'idem-1',
      )) as Record<string, unknown>;

      expect(result).toHaveProperty('orderNumber');
      expect(result).not.toHaveProperty('internalNotes');
      expect(result).not.toHaveProperty('idempotencyKey');
      expect(result).not.toHaveProperty('userId');
      expect(result).not.toHaveProperty('user');
    });

    it('emits order.created event', async () => {
      setupCreate();
      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');
      expect(events.emit).toHaveBeenCalledWith(
        ORDER_EVENTS.CREATED,
        expect.objectContaining({ orderId: 'order-1', userId: 'user-1' }),
      );
    });

    it('records promotion usage for automatic discounts', async () => {
      setupCreate();
      promotions.getApplicableAutomatic.mockResolvedValue([
        { promotionId: 'promo-1', discountAmount: 20, type: 'PERCENTAGE', label: '', priority: 0 },
      ]);
      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');
      expect(promotions.recordUsage).toHaveBeenCalledWith('promo-1', 'order-1', 20, 'user-1');
    });

    it('taxes the goods total AFTER discount, not the gross subtotal', async () => {
      // The assertion that was missing. `calculateTax` used to be called from a
      // Promise.all sixty lines before `totalDiscount` existed, so VAT was
      // charged on the PRE-discount subtotal and every discounted order was
      // over-taxed. Nothing caught it: the suite never asserted what
      // `calculateTax` was called WITH, and the e2e check was self-referential,
      // reconciling the order total against the very tax figure it read back.
      setupCreate();
      promotions.getApplicableAutomatic.mockResolvedValue([
        { promotionId: 'promo-1', discountAmount: 20, type: 'PERCENTAGE', label: '', priority: 0 },
      ]);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');

      // Cart subtotal is 200 and the discount is 20, so the base is 180.
      expect(taxService.calculateTax).toHaveBeenCalledWith(expect.any(String), null, 180);
      expect(taxService.calculateTax).not.toHaveBeenCalledWith(expect.any(String), null, 200);
    });

    it('never taxes a negative base when the discount exceeds the subtotal', async () => {
      setupCreate();
      promotions.getApplicableAutomatic.mockResolvedValue([
        { promotionId: 'promo-1', discountAmount: 500, type: 'PERCENTAGE', label: '', priority: 0 },
      ]);

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');

      expect(taxService.calculateTax).toHaveBeenCalledWith(expect.any(String), null, 0);
    });

    it('redeems gift card when code provided', async () => {
      setupCreate();
      // checkBalance must return a non-zero balance so giftCardDiscount > 0 and redeem fires
      giftCards.checkBalance.mockResolvedValue({ currentBalance: 100 });
      giftCards.redeem.mockResolvedValue({
        transactionId: 'tx-1',
        amountDebited: 100,
        remainingBalance: 0,
      });
      await service.createOrder(
        { ...BASE_ORDER_DTO, giftCardCode: 'ABCD1234EFGH5678' } as never,
        'user-1',
        'idem-1',
      );
      // The order's currency is passed so `redeem` can refuse a card
      // denominated in another one. Nothing checked that before, so a card in
      // one currency paid an order in another at 1:1.
      expect(giftCards.redeem).toHaveBeenCalledWith(
        'ABCD1234EFGH5678',
        expect.any(Number),
        'order-1',
        expect.any(String),
      );
    });

    /**
     * The cart is the fallback source for the code, mirroring `couponCode`.
     * Before the card was persisted on the cart there was no fallback: the
     * checkout payload spread `cart.giftCard?.code`, a field the backend never
     * emitted, so `dto.giftCardCode` arrived undefined on every real checkout
     * and the shopper paid full price with a card showing as applied.
     */
    it('redeems the card the shopper applied on the cart, with no code in the payload', async () => {
      setupCreate();
      cartService.getCart.mockResolvedValue(
        makeCartResponse({ giftCard: { code: 'CARTCARD00000001', balanceApplied: 100 } }),
      );
      giftCards.checkBalance.mockResolvedValue({ currentBalance: 100 });
      giftCards.redeem.mockResolvedValue({
        transactionId: 'tx-1',
        amountDebited: 100,
        remainingBalance: 0,
      });

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1');

      expect(giftCards.redeem).toHaveBeenCalledWith(
        'CARTCARD00000001',
        expect.any(Number),
        'order-1',
        expect.any(String),
      );
    });

    it('never counts a payload code and a cart code as two cards', async () => {
      // The order folds the gift card into `discountAmount` alongside
      // promotions and coupons, so counting the same tender twice, or two
      // tenders where the shopper holds one, silently discounts the order.
      setupCreate();
      cartService.getCart.mockResolvedValue(
        makeCartResponse({ giftCard: { code: 'CARTCARD00000001', balanceApplied: 100 } }),
      );
      giftCards.checkBalance.mockResolvedValue({ currentBalance: 100 });
      giftCards.redeem.mockResolvedValue({
        transactionId: 'tx-1',
        amountDebited: 100,
        remainingBalance: 0,
      });

      await service.createOrder(
        { ...BASE_ORDER_DTO, giftCardCode: 'PAYLOADCARD00001' } as never,
        'user-1',
        'idem-1',
      );

      expect(giftCards.redeem).toHaveBeenCalledTimes(1);
      expect(giftCards.redeem).toHaveBeenCalledWith(
        'PAYLOADCARD00001',
        expect.any(Number),
        'order-1',
        expect.any(String),
      );
    });

    it('drops a cart card that died since the cart page, rather than blocking checkout', async () => {
      // Expired, emptied by another order, or deactivated. The shopper never
      // typed this code at checkout, so failing the whole order over it would
      // strand them; an invalid coupon is dropped the same way.
      setupCreate();
      cartService.getCart.mockResolvedValue(
        makeCartResponse({ giftCard: { code: 'DEADCARD00000001', balanceApplied: 100 } }),
      );
      giftCards.checkBalance.mockRejectedValue(new BadRequestException('expired'));

      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1'),
      ).resolves.toBeDefined();
      expect(giftCards.redeem).not.toHaveBeenCalled();
    });

    it('but surfaces the error when the caller named the card explicitly', async () => {
      // They asked for that card. Silently charging them the full amount
      // instead is worse than an error they can act on.
      setupCreate();
      cartService.getCart.mockResolvedValue(makeCartResponse());
      giftCards.checkBalance.mockRejectedValue(new BadRequestException('expired'));

      await expect(
        service.createOrder(
          { ...BASE_ORDER_DTO, giftCardCode: 'DEADCARD00000001' } as never,
          'user-1',
          'idem-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(giftCards.redeem).not.toHaveBeenCalled();
    });

    it('refuses the order when the caller typed a coupon that does not validate', async () => {
      // A silent drop charged the full price with no hint the code failed.
      setupCreate();
      cartService.getCart.mockResolvedValue(makeCartResponse());
      promotions.validateCoupon.mockRejectedValue(new CouponInvalidException());

      await expect(
        service.createOrder({ ...BASE_ORDER_DTO, couponCode: 'NOPE' } as never, 'user-1', 'idem-1'),
      ).rejects.toBeInstanceOf(CouponInvalidException);
    });

    it('still drops a coupon that only sits on the cart and died since', async () => {
      setupCreate();
      cartService.getCart.mockResolvedValue(makeCartResponse({ couponCode: 'OLD10' }));
      promotions.validateCoupon.mockRejectedValue(new CouponInvalidException());

      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-1'),
      ).resolves.toBeDefined();
    });
  });

  // ── Idempotency ─────────────────────────────────────────────────────────

  describe('idempotency', () => {
    function setupCreate() {
      cartService.getCart.mockResolvedValue(makeCartResponse());
      shippingService.calculateRates.mockResolvedValue([]);
      taxService.calculateTax.mockResolvedValue({ rate: 0, amount: 0, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);
      prisma.productVariant.findMany.mockResolvedValue([]);
      prisma.order.create.mockResolvedValue(makeOrder());
      promotions.recordUsage.mockResolvedValue(undefined);
      cartService.clearCart.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});
    }

    it('returns cached response when IdempotencyService reports cached', async () => {
      const cachedOrder = makeOrder({ id: 'original-order' });
      idempotency.beginRequest.mockResolvedValue({
        state: 'cached',
        cachedResponse: cachedOrder,
      });

      const result = await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'same-key');

      expect((result as { id: string }).id).toBe('original-order');
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(inventory.decrementStock).not.toHaveBeenCalled();
      expect(cartService.clearCart).not.toHaveBeenCalled();
      expect(idempotency.completeRequest).not.toHaveBeenCalled();
    });

    it('throws ConflictException when IdempotencyService reports in-flight', async () => {
      idempotency.beginRequest.mockResolvedValue({ state: 'in-flight' });

      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'same-key'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('throws IdempotencyKeyConflictException on body-fingerprint mismatch', async () => {
      idempotency.beginRequest.mockResolvedValue({ state: 'conflict' });

      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'same-key'),
      ).rejects.toThrow(IdempotencyKeyConflictException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('throws IdempotencyKeyForbiddenException on caller-hash mismatch', async () => {
      idempotency.beginRequest.mockResolvedValue({ state: 'forbidden' });

      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'same-key'),
      ).rejects.toThrow(IdempotencyKeyForbiddenException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('binds callerHash to userId via sha256 — different userId derives a different hash', async () => {
      setupCreate();
      idempotency.beginRequest.mockResolvedValue({ state: 'fresh' });
      await service.createOrder(BASE_ORDER_DTO as never, 'user-A', 'idem-1');
      await service.createOrder(BASE_ORDER_DTO as never, 'user-B', 'idem-1');

      const calls = idempotency.beginRequest.mock.calls;
      expect(calls.length).toBe(2);
      const [argsA] = calls[0] as [{ callerHash: string }];
      const [argsB] = calls[1] as [{ callerHash: string }];
      expect(argsA.callerHash).toBe(IdempotencyService.sha256Hex('user-A'));
      expect(argsB.callerHash).toBe(IdempotencyService.sha256Hex('user-B'));
      expect(argsA.callerHash).not.toBe(argsB.callerHash);
    });

    it('binds bodyHash to stable JSON — same payload + key-order yields same hash', async () => {
      setupCreate();
      idempotency.beginRequest.mockResolvedValue({ state: 'fresh' });

      const dtoA = { shippingAddress: ADDRESS_DTO, billingAddress: ADDRESS_DTO };
      const dtoB = { billingAddress: ADDRESS_DTO, shippingAddress: ADDRESS_DTO };
      await service.createOrder(dtoA as never, 'user-1', 'idem-1');
      await service.createOrder(dtoB as never, 'user-1', 'idem-1');

      const calls = idempotency.beginRequest.mock.calls;
      const [argsA] = calls[0] as [{ bodyHash: string }];
      const [argsB] = calls[1] as [{ bodyHash: string }];
      expect(argsA.bodyHash).toBe(argsB.bodyHash);
    });

    it('calls IdempotencyService.abortRequest on validation failure', async () => {
      idempotency.beginRequest.mockResolvedValue({ state: 'fresh' });
      cartService.getCart.mockResolvedValue(makeCartResponse({ items: [] }));

      await expect(
        service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-fail'),
      ).rejects.toThrow(BadRequestException);

      expect(idempotency.abortRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'orders',
          key: 'idem-fail',
        }),
      );
    });
  });

  // ── Payment actions (OS4.2) ─────────────────────────────────────────────
  //
  // `paymentStatus` is written by the server from the provider result, never
  // from a request body (§3.5). The write is guarded on the status the provider
  // was called with, so two admins acting at once cannot both land.

  describe('payment actions', () => {
    const paymentTotal = new Prisma.Decimal('215.000');

    function mockPaymentOrder(overrides: Record<string, unknown> = {}) {
      const order = makeOrder({
        paymentMethodCode: 'cod',
        paymentReference: 'cod_order-1',
        total: paymentTotal,
        returns: [],
        ...overrides,
      });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(order);
      prisma.auditLogEntry.create.mockResolvedValue({});
      return order;
    }

    it('captures through the gateway and writes the provider status', async () => {
      mockPaymentOrder();

      await service.capturePayment('order-1', 'admin-1', 'pay-key');

      expect(paymentGateway.capture).toHaveBeenCalledWith('cod', {
        reference: 'cod_order-1',
        status: PaymentStatus.PENDING,
        amount: paymentTotal,
        currencyCode: 'LYD',
        idempotencyKey: expect.any(String),
      });
      // Providers compare amounts with Decimal methods, so a plain number crashes them.
      expect(paymentGateway.capture.mock.calls[0][1].amount).toBeInstanceOf(Prisma.Decimal);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: PaymentStatus.PENDING },
        data: { paymentStatus: PaymentStatus.CAPTURED },
      });
      expect(prisma.auditLogEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'order.payment_captured',
            entityId: 'order-1',
          }),
        }),
      );
    });

    it('refunds the full order total', async () => {
      mockPaymentOrder({ status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.CAPTURED });

      await service.refundPayment('order-1', 'admin-1', 'pay-key');

      expect(paymentGateway.refund).toHaveBeenCalledWith('cod', {
        reference: 'cod_order-1',
        status: PaymentStatus.CAPTURED,
        amount: paymentTotal,
        refundableAmount: paymentTotal,
        currencyCode: 'LYD',
        idempotencyKey: expect.any(String),
      });
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: PaymentStatus.CAPTURED },
        data: { paymentStatus: PaymentStatus.REFUNDED },
      });
    });

    it('refunds only what processed returns have not given back', async () => {
      mockPaymentOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.CAPTURED,
        returns: [{ refundAmount: new Prisma.Decimal('15.000') }, { refundAmount: null }],
      });

      await service.refundPayment('order-1', 'admin-1', 'pay-key');

      expect(prisma.order.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            returns: {
              where: { status: { in: [ReturnStatus.REFUND_PROCESSED, ReturnStatus.CLOSED] } },
              select: { refundAmount: true },
            },
          }),
        }),
      );
      const remaining = new Prisma.Decimal('200.000');
      const input = paymentGateway.refund.mock.calls[0][1];
      expect(input.amount).toEqual(remaining);
      expect(input.refundableAmount).toEqual(remaining);
    });

    it('refuses a refund with a stable code when returns gave back the whole total', async () => {
      mockPaymentOrder({
        paymentStatus: PaymentStatus.CAPTURED,
        returns: [
          { refundAmount: new Prisma.Decimal('200.000') },
          { refundAmount: new Prisma.Decimal('15.000') },
        ],
      });

      const refusal = service.refundPayment('order-1', 'admin-1', 'pay-key');

      await expect(refusal).rejects.toBeInstanceOf(OrderNothingToRefundException);
      await expect(refusal).rejects.toMatchObject({
        response: { error: { code: 'ORDER_NOTHING_TO_REFUND' } },
      });
      expect(paymentGateway.refund).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    describe('refund of an order nobody confirmed (E2)', () => {
      it('cancels a PENDING order after a full refund so its stock is released', async () => {
        mockPaymentOrder({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.CAPTURED });
        const cancel = jest.spyOn(service, 'updateStatus').mockResolvedValue({} as never);

        await service.refundPayment('order-1', 'admin-1', 'pay-key');

        expect(cancel).toHaveBeenCalledWith('order-1', OrderStatus.CANCELLED, 'admin-1');
      });

      it('keeps a CONFIRMED order open after a full refund', async () => {
        mockPaymentOrder({ status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.CAPTURED });
        const cancel = jest.spyOn(service, 'updateStatus').mockResolvedValue({} as never);

        await service.refundPayment('order-1', 'admin-1', 'pay-key');

        expect(cancel).not.toHaveBeenCalled();
      });

      it('keeps a PENDING order open when the provider only refunded part', async () => {
        mockPaymentOrder({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.CAPTURED });
        paymentGateway.refund.mockResolvedValueOnce({
          status: PaymentStatus.PARTIALLY_REFUNDED,
        });
        const cancel = jest.spyOn(service, 'updateStatus').mockResolvedValue({} as never);

        await service.refundPayment('order-1', 'admin-1', 'pay-key');

        expect(cancel).not.toHaveBeenCalled();
      });

      it('does not cancel on capture or void', async () => {
        mockPaymentOrder({ status: OrderStatus.PENDING });
        const cancel = jest.spyOn(service, 'updateStatus').mockResolvedValue({} as never);

        await service.capturePayment('order-1', 'admin-1', 'pay-key');

        expect(cancel).not.toHaveBeenCalled();
      });
    });

    it('refuses a full refund once part of the payment was refunded', async () => {
      mockPaymentOrder({ paymentStatus: PaymentStatus.PARTIALLY_REFUNDED });

      await expect(service.refundPayment('order-1', 'admin-1', 'pay-key')).rejects.toBeInstanceOf(
        PaymentTransitionNotAllowedException,
      );
      expect(paymentGateway.refund).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('cancels through the gateway', async () => {
      mockPaymentOrder();

      await service.cancelPayment('order-1', 'admin-1', 'pay-key');

      expect(paymentGateway.cancel).toHaveBeenCalledWith('cod', {
        reference: 'cod_order-1',
        status: PaymentStatus.PENDING,
        idempotencyKey: expect.any(String),
      });
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: PaymentStatus.PENDING },
        data: { paymentStatus: PaymentStatus.CANCELLED },
      });
    });

    it('passes the provider a key that is stable for one request key and new for another', async () => {
      mockPaymentOrder();

      await service.capturePayment('order-1', 'admin-1', 'pay-key');
      await service.capturePayment('order-1', 'admin-1', 'pay-key');
      await service.capturePayment('order-1', 'admin-1', 'other-key');
      await service.capturePayment('order-1', 'admin-2', 'pay-key');

      const [first, retry, otherKey, otherAdmin] = paymentGateway.capture.mock.calls.map(
        (c) => c[1].idempotencyKey,
      );
      expect(first).toBe(retry);
      expect(otherKey).not.toBe(first);
      expect(otherAdmin).not.toBe(first);
      expect(first).not.toContain('pay-key');
    });

    it('keys a refund by the order and the amount, so a second request key cannot refund twice', async () => {
      mockPaymentOrder({ status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.CAPTURED });

      await service.refundPayment('order-1', 'admin-1', 'pay-key');
      await service.refundPayment('order-1', 'admin-1', 'other-key');
      await service.refundPayment('order-1', 'admin-2', 'third-key');

      const keys = paymentGateway.refund.mock.calls.map((c) => c[1].idempotencyKey);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).not.toContain('pay-key');
    });

    it('treats a concurrent write that landed the same status as done and audits it', async () => {
      const order = mockPaymentOrder();
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        ...order,
        paymentStatus: PaymentStatus.CAPTURED,
      });

      const result = await service.capturePayment('order-1', 'admin-1', 'pay-key');

      expect(result).toMatchObject({ paymentStatus: PaymentStatus.CAPTURED });
      expect(prisma.auditLogEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'order.payment_captured' }),
        }),
      );
    });

    it('rejects with 409 when another write moved the status first', async () => {
      mockPaymentOrder();
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = service.capturePayment('order-1', 'admin-1', 'pay-key');

      await expect(result).rejects.toBeInstanceOf(PaymentTransitionNotAllowedException);
      expect(prisma.auditLogEntry.create).not.toHaveBeenCalled();
    });

    it('passes a provider transition refusal through without writing', async () => {
      mockPaymentOrder({ paymentStatus: PaymentStatus.REFUNDED });
      paymentGateway.capture.mockRejectedValueOnce(
        new PaymentTransitionNotAllowedException('cod', PaymentStatus.REFUNDED, 'capture'),
      );

      await expect(service.capturePayment('order-1', 'admin-1', 'pay-key')).rejects.toBeInstanceOf(
        PaymentTransitionNotAllowedException,
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects with 409 when the order never opened a payment session', async () => {
      mockPaymentOrder({ paymentReference: null });

      await expect(service.capturePayment('order-1', 'admin-1', 'pay-key')).rejects.toBeInstanceOf(
        OrderPaymentNotOpenedException,
      );
      expect(paymentGateway.capture).not.toHaveBeenCalled();
    });

    it('rejects with 404 for an unknown order', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(service.refundPayment('missing', 'admin-1', 'pay-key')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('replays a cached response without calling the provider again', async () => {
      const cached = makeOrder({ id: 'order-1', paymentStatus: PaymentStatus.CAPTURED });
      idempotency.beginRequest.mockResolvedValue({ state: 'cached', cachedResponse: cached });

      const result = await service.capturePayment('order-1', 'admin-1', 'pay-key');

      expect(result).toBe(cached);
      expect(paymentGateway.capture).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('binds the key to the admin, the order and the action, then completes it', async () => {
      mockPaymentOrder();

      await service.capturePayment('order-1', 'admin-1', 'pay-key');
      await service.cancelPayment('order-1', 'admin-1', 'pay-key');

      const [captureArgs, cancelArgs] = idempotency.beginRequest.mock.calls.map((c) => c[0]);
      expect(captureArgs.key).toBe('pay-key');
      expect(captureArgs.bodyHash).not.toBe(cancelArgs.bodyHash);
      expect(idempotency.completeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'pay-key', entityId: 'order-1' }),
      );
    });

    it('rejects an in-flight key and releases the key when the action fails', async () => {
      idempotency.beginRequest.mockResolvedValueOnce({ state: 'in-flight' });
      await expect(service.capturePayment('order-1', 'admin-1', 'pay-key')).rejects.toBeInstanceOf(
        OrderIdempotencyInFlightException,
      );

      mockPaymentOrder({ paymentReference: null });
      await expect(service.capturePayment('order-1', 'admin-1', 'pay-key')).rejects.toBeInstanceOf(
        OrderPaymentNotOpenedException,
      );
      expect(idempotency.abortRequest).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'pay-key' }),
      );
    });
  });

  // ── Payment webhooks (OS4.3) ────────────────────────────────────────────
  //
  // A verified provider event moves `paymentStatus` through OrdersService only
  // (§3.1). The order is found by its provider reference, never by a body id.

  describe('applyPaymentWebhookEvent', () => {
    const event = {
      reference: 'cod_order-1',
      status: PaymentStatus.AUTHORIZED,
      eventId: 'evt-1',
    };

    function mockWebhookOrder(overrides: Record<string, unknown> = {}) {
      const order = makeOrder({
        paymentMethodCode: 'cod',
        paymentReference: 'cod_order-1',
        ...overrides,
      });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.auditLogEntry.create.mockResolvedValue({});
      return order;
    }

    it('writes the event status guarded on the current one and audits it as a system action', async () => {
      mockWebhookOrder();

      await service.applyPaymentWebhookEvent('cod', event, ['cod']);

      expect(prisma.order.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { paymentReference: 'cod_order-1' } }),
      );
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: PaymentStatus.PENDING },
        data: { paymentStatus: PaymentStatus.AUTHORIZED },
      });
      expect(prisma.auditLogEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: null,
          action: 'order.payment_webhook',
          entityId: 'order-1',
          changes: { from: PaymentStatus.PENDING, to: PaymentStatus.AUTHORIZED, eventId: 'evt-1' },
        }),
      });
    });

    it('is a no-op when the order already holds the event status', async () => {
      mockWebhookOrder({ paymentStatus: PaymentStatus.AUTHORIZED });

      await service.applyPaymentWebhookEvent('cod', event, ['cod']);

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLogEntry.create).not.toHaveBeenCalled();
    });

    it.each([
      [PaymentStatus.REFUNDED, PaymentStatus.CAPTURED],
      [PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED],
      [PaymentStatus.CANCELLED, PaymentStatus.PENDING],
      [PaymentStatus.FAILED, PaymentStatus.CAPTURED],
    ])('ignores a stale event that would move %s back to %s', async (current, stale) => {
      mockWebhookOrder({ paymentStatus: current });

      await expect(
        service.applyPaymentWebhookEvent('cod', { ...event, status: stale }, ['cod']),
      ).resolves.toBeUndefined();

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLogEntry.create).not.toHaveBeenCalled();
    });

    it('moves a captured payment forward to refunded', async () => {
      mockWebhookOrder({ paymentStatus: PaymentStatus.CAPTURED });

      await service.applyPaymentWebhookEvent('cod', { ...event, status: PaymentStatus.REFUNDED }, [
        'cod',
      ]);

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: PaymentStatus.CAPTURED },
        data: { paymentStatus: PaymentStatus.REFUNDED },
      });
    });

    it('rejects with 404 for an unknown reference', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(service.applyPaymentWebhookEvent('cod', event, ['cod'])).rejects.toBeInstanceOf(
        OrderNotFoundException,
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects with 404 when the order is on a method whose secret did not verify the event', async () => {
      // A deleted method of the same provider still verifies, but only for its own orders.
      mockWebhookOrder({ paymentMethodCode: 'cod-live' });

      await expect(
        service.applyPaymentWebhookEvent('cod', event, ['cod-deleted']),
      ).rejects.toBeInstanceOf(OrderNotFoundException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('applies an event verified by several methods to an order on any of them', async () => {
      mockWebhookOrder({ paymentMethodCode: 'cod-live' });

      await service.applyPaymentWebhookEvent('cod', event, ['cod-deleted', 'cod-live']);

      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    });

    it('rejects with 404 when the order has no payment method', async () => {
      mockWebhookOrder({ paymentMethodCode: null });

      await expect(service.applyPaymentWebhookEvent('cod', event, ['cod'])).rejects.toBeInstanceOf(
        OrderNotFoundException,
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects with 409 when another write moved the status first', async () => {
      mockWebhookOrder();
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.order.findUniqueOrThrow.mockResolvedValueOnce({
        paymentStatus: PaymentStatus.CANCELLED,
      });

      await expect(service.applyPaymentWebhookEvent('cod', event, ['cod'])).rejects.toBeInstanceOf(
        PaymentTransitionNotAllowedException,
      );
      expect(prisma.auditLogEntry.create).not.toHaveBeenCalled();
    });

    it('is a no-op when another write already moved the status to the event status', async () => {
      // An admin capture and the provider's own event race; the provider must not retry forever.
      mockWebhookOrder();
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.order.findUniqueOrThrow.mockResolvedValueOnce({
        paymentStatus: PaymentStatus.AUTHORIZED,
      });

      await expect(
        service.applyPaymentWebhookEvent('cod', event, ['cod']),
      ).resolves.toBeUndefined();
      expect(prisma.auditLogEntry.create).not.toHaveBeenCalled();
    });
  });

  // ── Status transitions ──────────────────────────────────────────────────

  describe('status transitions', () => {
    function mockOrderWithStatus(status: OrderStatus) {
      const order = makeOrder({ status });
      prisma.order.findUnique.mockResolvedValue(order);
      return order;
    }

    function setupForTransition(fromStatus: OrderStatus, toStatus: OrderStatus) {
      const order = makeOrder({ status: fromStatus });
      // updateStatus lookup
      prisma.order.findUnique.mockResolvedValueOnce(order);
      // If confirming, invoice generation needs another findUnique
      if (toStatus === OrderStatus.CONFIRMED) {
        prisma.order.findUnique.mockResolvedValueOnce(order);
        prisma.invoice.findUnique.mockResolvedValue(null);
        prisma.invoice.create.mockResolvedValue({});
        prisma.$executeRawUnsafe.mockResolvedValue(0);
        prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);
      }
      // If cancelling, restoreOrderStock queries orderItem
      if (toStatus === OrderStatus.CANCELLED) {
        prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
        inventory.incrementStock.mockResolvedValue(undefined);
      }
      prisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: toStatus }));
      prisma.auditLogEntry.create.mockResolvedValue({});
    }

    // ── Valid transitions ─────────────────────────────────────────────────

    const validTransitions: [OrderStatus, OrderStatus][] = [
      [OrderStatus.PENDING, OrderStatus.CONFIRMED],
      [OrderStatus.PENDING, OrderStatus.CANCELLED],
      [OrderStatus.CONFIRMED, OrderStatus.PROCESSING],
      [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
      [OrderStatus.PROCESSING, OrderStatus.ON_HOLD],
      [OrderStatus.PROCESSING, OrderStatus.SHIPPED],
      [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
      [OrderStatus.ON_HOLD, OrderStatus.PROCESSING],
      [OrderStatus.SHIPPED, OrderStatus.DELIVERED],
      [OrderStatus.DELIVERED, OrderStatus.COMPLETED],
      // H-1: DELIVERED now transitions to RETURNED (spec-correct terminal state)
      [OrderStatus.DELIVERED, OrderStatus.RETURNED],
    ];

    it.each(validTransitions)('allows %s → %s', async (from, to) => {
      setupForTransition(from, to);
      const result = await service.updateStatus('order-1', to, 'admin-1');
      expect((result as { status: OrderStatus }).status).toBe(to);
    });

    // ── Cancel unwinds what the order spent (QA D9, C32, E3, G6, H1, H2) ──

    describe('cancel unwinding', () => {
      function setupCancel(overrides: Record<string, unknown>) {
        setupForTransition(OrderStatus.PENDING, OrderStatus.CANCELLED);
        prisma.order.findUnique.mockReset();
        prisma.order.findUnique.mockResolvedValueOnce(
          makeOrder({
            status: OrderStatus.PENDING,
            paymentMethodCode: 'stripe-card',
            paymentReference: 'pi_1',
            ...overrides,
          }),
        );
      }

      it('voids an authorized payment through the gateway and records the result', async () => {
        setupCancel({ paymentStatus: PaymentStatus.AUTHORIZED });

        await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

        expect(paymentGateway.cancel).toHaveBeenCalledWith('stripe-card', {
          reference: 'pi_1',
          status: PaymentStatus.AUTHORIZED,
          idempotencyKey: 'order-cancel:order-1',
        });
        expect(prisma.order.updateMany).toHaveBeenCalledWith({
          where: { id: 'order-1', paymentStatus: PaymentStatus.AUTHORIZED },
          data: { paymentStatus: PaymentStatus.CANCELLED },
        });
      });

      it('closes the payment of a cancelled pending order', async () => {
        setupCancel({ paymentStatus: PaymentStatus.PENDING });

        await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

        expect(paymentGateway.cancel).toHaveBeenCalledTimes(1);
        expect(prisma.order.updateMany).toHaveBeenCalledWith({
          where: { id: 'order-1', paymentStatus: PaymentStatus.PENDING },
          data: { paymentStatus: PaymentStatus.CANCELLED },
        });
      });

      it('leaves a captured payment alone, a refund is a separate action', async () => {
        setupCancel({ paymentStatus: PaymentStatus.CAPTURED });

        await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

        expect(paymentGateway.cancel).not.toHaveBeenCalled();
      });

      it('restores the gift card balance and releases the promotion usage', async () => {
        setupCancel({ paymentStatus: PaymentStatus.PENDING });

        await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

        expect(giftCards.restoreForOrder).toHaveBeenCalledWith('order-1');
        expect(promotions.releaseUsageForOrder).toHaveBeenCalledWith('order-1');
      });

      it('still cancels when the provider void fails', async () => {
        setupCancel({ paymentStatus: PaymentStatus.AUTHORIZED });
        paymentGateway.cancel.mockRejectedValue(new Error('provider down'));

        const result = await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

        expect((result as { status: OrderStatus }).status).toBe(OrderStatus.CANCELLED);
        expect(giftCards.restoreForOrder).toHaveBeenCalledWith('order-1');
        expect(promotions.releaseUsageForOrder).toHaveBeenCalledWith('order-1');
      });

      it('does nothing extra for a non-cancel transition', async () => {
        setupForTransition(OrderStatus.PENDING, OrderStatus.CONFIRMED);

        await service.updateStatus('order-1', OrderStatus.CONFIRMED, 'admin-1');

        expect(giftCards.restoreForOrder).not.toHaveBeenCalled();
        expect(promotions.releaseUsageForOrder).not.toHaveBeenCalled();
        expect(paymentGateway.cancel).not.toHaveBeenCalled();
      });
    });

    // ── Invalid transitions ───────────────────────────────────────────────

    const invalidTransitions: [OrderStatus, OrderStatus][] = [
      [OrderStatus.DELIVERED, OrderStatus.PROCESSING],
      [OrderStatus.DELIVERED, OrderStatus.PENDING],
      [OrderStatus.COMPLETED, OrderStatus.PENDING],
      [OrderStatus.COMPLETED, OrderStatus.CONFIRMED],
      [OrderStatus.CANCELLED, OrderStatus.PENDING],
      [OrderStatus.CANCELLED, OrderStatus.CONFIRMED],
      [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
      [OrderStatus.SHIPPED, OrderStatus.PROCESSING],
      [OrderStatus.RETURN_REQUESTED, OrderStatus.CONFIRMED],
      [OrderStatus.RETURN_REQUESTED, OrderStatus.DELIVERED],
    ];

    it.each(invalidTransitions)('rejects %s → %s with 400', async (from, to) => {
      mockOrderWithStatus(from);
      await expect(service.updateStatus('order-1', to, 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    // ── STATUS_TRANSITIONS map completeness ───────────────────────────────

    it('STATUS_TRANSITIONS map covers all OrderStatus values', () => {
      const allStatuses = Object.values(OrderStatus);
      for (const status of allStatuses) {
        expect(STATUS_TRANSITIONS).toHaveProperty(status);
      }
    });

    // ── Event emission per transition ─────────────────────────────────────

    it('emits order.confirmed on PENDING → CONFIRMED', async () => {
      setupForTransition(OrderStatus.PENDING, OrderStatus.CONFIRMED);
      await service.updateStatus('order-1', OrderStatus.CONFIRMED, 'admin-1');
      expect(events.emit).toHaveBeenCalledWith(
        ORDER_EVENTS.CONFIRMED,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('emits order.shipped on → SHIPPED', async () => {
      setupForTransition(OrderStatus.PROCESSING, OrderStatus.SHIPPED);
      await service.updateStatus('order-1', OrderStatus.SHIPPED, 'admin-1');
      expect(events.emit).toHaveBeenCalledWith(
        ORDER_EVENTS.SHIPPED,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('emits order.delivered on → DELIVERED', async () => {
      setupForTransition(OrderStatus.SHIPPED, OrderStatus.DELIVERED);
      await service.updateStatus('order-1', OrderStatus.DELIVERED, 'admin-1');
      expect(events.emit).toHaveBeenCalledWith(
        ORDER_EVENTS.DELIVERED,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('emits order.status_changed on every transition', async () => {
      setupForTransition(OrderStatus.CONFIRMED, OrderStatus.PROCESSING);
      await service.updateStatus('order-1', OrderStatus.PROCESSING, 'admin-1');
      expect(events.emit).toHaveBeenCalledWith(
        ORDER_EVENTS.STATUS_CHANGED,
        expect.objectContaining({ from: OrderStatus.CONFIRMED, to: OrderStatus.PROCESSING }),
      );
    });

    // ── Stock restoration on CANCELLED ────────────────────────────────────

    it('calls incrementStock for each item when transitioning to CANCELLED', async () => {
      setupForTransition(OrderStatus.PROCESSING, OrderStatus.CANCELLED);
      await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

      expect(inventory.incrementStock).toHaveBeenCalledWith(
        'variant-1',
        2,
        'CORRECTION',
        expect.objectContaining({ referenceType: 'OrderCancellation', referenceId: 'order-1' }),
      );
    });

    it('does NOT call incrementStock for non-CANCELLED transitions', async () => {
      setupForTransition(OrderStatus.PENDING, OrderStatus.CONFIRMED);
      await service.updateStatus('order-1', OrderStatus.CONFIRMED, 'admin-1');
      expect(inventory.incrementStock).not.toHaveBeenCalled();
    });

    it('skips incrementStock for items with null variantId', async () => {
      const order = makeOrder({ status: OrderStatus.PENDING });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CANCELLED }),
      );
      prisma.auditLogEntry.create.mockResolvedValue({});
      // Item has null variantId (product was deleted)
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: null, quantity: 1 }]);

      await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

      expect(inventory.incrementStock).not.toHaveBeenCalled();
    });

    it('throws NotFound for non-existent order', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(
        service.updateStatus('missing', OrderStatus.CONFIRMED, 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('auto-generates invoice only once (skips if already exists)', async () => {
      const order = makeOrder({ status: OrderStatus.PENDING });
      prisma.order.findUnique.mockResolvedValueOnce(order).mockResolvedValueOnce(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CONFIRMED }),
      );
      // Invoice already exists
      prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-existing' });
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateStatus('order-1', OrderStatus.CONFIRMED, 'admin-1');

      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });

  // ── Order number sequence ────────────────────────────────────────────────

  describe('order number sequence', () => {
    function setupCreateWithSeq(seqValue: number) {
      cartService.getCart.mockResolvedValue(makeCartResponse());
      shippingService.calculateRates.mockResolvedValue([]);
      taxService.calculateTax.mockResolvedValue({ rate: 0, amount: 0, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: BigInt(seqValue) }]);
      prisma.productVariant.findMany.mockResolvedValue([]);
      promotions.recordUsage.mockResolvedValue(undefined);
      cartService.clearCart.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});
    }

    it('generates order number with ORD- prefix, year, and 6-digit padded sequence', async () => {
      const year = new Date().getFullYear();
      setupCreateWithSeq(1);
      prisma.order.create.mockResolvedValue(makeOrder({ orderNumber: `ORD-${year}-000001` }));

      const result = await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-seq');
      expect((result as { orderNumber: string }).orderNumber).toBe(`ORD-${year}-000001`);
    });

    it('creates PostgreSQL SEQUENCE and calls nextval for order numbers', async () => {
      const year = new Date().getFullYear();
      setupCreateWithSeq(1);
      prisma.order.create.mockResolvedValue(makeOrder());

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-seq2');

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        `CREATE SEQUENCE IF NOT EXISTS "order_seq_${year}" START WITH 1 INCREMENT BY 1`,
      );
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
        `SELECT nextval('"order_seq_${year}"') AS value`,
      );
    });

    it('pads sequence to 6 digits (value=42 → 000042)', async () => {
      const year = new Date().getFullYear();
      setupCreateWithSeq(42);
      prisma.order.create.mockResolvedValue(makeOrder({ orderNumber: `ORD-${year}-000042` }));

      const result = await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'idem-seq3');
      expect((result as { orderNumber: string }).orderNumber).toMatch(/ORD-\d{4}-000042/);
    });

    it('invoice number uses INV- prefix and invoice PostgreSQL SEQUENCE', async () => {
      const order = makeOrder({ status: OrderStatus.PENDING });
      const year = new Date().getFullYear();

      prisma.order.findUnique.mockResolvedValueOnce(order).mockResolvedValueOnce(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CONFIRMED }),
      );
      prisma.invoice.findUnique.mockResolvedValue(null);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 7n }]);
      prisma.invoice.create.mockResolvedValue({ invoiceNumber: `INV-${year}-000007` });
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateStatus('order-1', OrderStatus.CONFIRMED, 'admin-1');

      expect(prisma.invoice.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            invoiceNumber: `INV-${year}-000007`,
          }),
        }),
      );
    });

    it('sequential calls produce incrementing sequence values', async () => {
      setupCreateWithSeq(1);
      prisma.order.create.mockResolvedValue(makeOrder({ orderNumber: 'ORD-2026-000001' }));
      const r1 = await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'key-s1');

      setupCreateWithSeq(2);
      prisma.order.create.mockResolvedValue(makeOrder({ orderNumber: 'ORD-2026-000002' }));
      const r2 = await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'key-s2');

      expect((r1 as { orderNumber: string }).orderNumber).toBe('ORD-2026-000001');
      expect((r2 as { orderNumber: string }).orderNumber).toBe('ORD-2026-000002');
    });
  });

  // ── Order item snapshot (frozen prices / names) ──────────────────────────

  describe('order item snapshot', () => {
    it('snapshots the variant SKU at order time', async () => {
      cartService.getCart.mockResolvedValue(makeCartResponse());
      shippingService.calculateRates.mockResolvedValue([]);
      taxService.calculateTax.mockResolvedValue({ rate: 0, amount: 0, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);
      promotions.recordUsage.mockResolvedValue(undefined);
      cartService.clearCart.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});

      prisma.productVariant.findMany.mockResolvedValue([
        {
          id: 'variant-1',
          sku: 'SKU-AT-ORDER-TIME',
          price: dec(100),
          weight: dec(0.5),
          productId: 'product-1',
          product: {
            id: 'product-1',
            name: {
              default: 'Widget at order time',
              fr: 'Widget at order time',
              en: 'Widget at order time',
            },
            slug: 'widget',
            assets: [],
          },
          attributeValues: [],
        },
      ]);

      const createdOrder = makeOrder({
        items: [
          {
            ...makeOrder().items[0],
            sku: 'SKU-AT-ORDER-TIME',
            productName: { default: 'Widget at order time' },
          },
        ],
      });
      prisma.order.create.mockResolvedValue(createdOrder);

      const result = await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'snap-1');
      const items = (result as { items: Array<{ sku: string }> }).items;
      expect(items[0].sku).toBe('SKU-AT-ORDER-TIME');
    });

    it('passes variant price at order time to order.create (frozen unitPrice)', async () => {
      // Cart has item with price 100
      cartService.getCart.mockResolvedValue(makeCartResponse());
      shippingService.calculateRates.mockResolvedValue([]);
      taxService.calculateTax.mockResolvedValue({ rate: 0, amount: 0, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);
      // Variant price at snapshot time is 100 — even if it later becomes 200
      prisma.productVariant.findMany.mockResolvedValue([
        {
          id: 'variant-1',
          sku: 'WDG-001',
          price: dec(100),
          weight: null,
          productId: 'product-1',
          product: { id: 'p-1', name: { default: 'Widget' }, slug: 'w', assets: [] },
          attributeValues: [],
        },
      ]);
      prisma.order.create.mockResolvedValue(makeOrder());
      promotions.recordUsage.mockResolvedValue(undefined);
      cartService.clearCart.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'snap-2');

      // unitPrice in the create call should be the cart item price (live price at cart time)
      const createCall = prisma.order.create.mock.calls[0] as [
        { data: { items: { create: Array<{ unitPrice: number }> } } },
      ];
      const createdItems = createCall[0].data.items.create;
      expect(createdItems[0].unitPrice).toBe(100);
    });

    it('snapshots the product name in all locales from variant at order time', async () => {
      cartService.getCart.mockResolvedValue(makeCartResponse());
      shippingService.calculateRates.mockResolvedValue([]);
      taxService.calculateTax.mockResolvedValue({ rate: 0, amount: 0, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);

      const productName = {
        default: 'Widget Original',
        fr: 'Widget Original',
        en: 'Widget Original',
      };
      prisma.productVariant.findMany.mockResolvedValue([
        {
          id: 'variant-1',
          sku: 'WDG-001',
          price: dec(100),
          weight: null,
          productId: 'product-1',
          product: { id: 'p-1', name: productName, slug: 'w', assets: [] },
          attributeValues: [],
        },
      ]);
      prisma.order.create.mockResolvedValue(makeOrder());
      promotions.recordUsage.mockResolvedValue(undefined);
      cartService.clearCart.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'snap-3');

      const createCall = prisma.order.create.mock.calls[0] as [
        { data: { items: { create: Array<{ productName: unknown }> } } },
      ];
      const createdItems = createCall[0].data.items.create;
      // productName stored is the full Translatable object from the variant at time of order
      expect(createdItems[0].productName).toEqual(productName);
    });

    it('snapshots thumbnailUrl from the canonical thumbnail variant at order time (AV1)', async () => {
      cartService.getCart.mockResolvedValue(makeCartResponse());
      shippingService.calculateRates.mockResolvedValue([]);
      taxService.calculateTax.mockResolvedValue({ rate: 0, amount: 0, zone: null });
      promotions.getApplicableAutomatic.mockResolvedValue([]);
      inventory.decrementStock.mockResolvedValue(true);
      prisma.$executeRawUnsafe.mockResolvedValue(0);
      prisma.$queryRawUnsafe.mockResolvedValue([{ value: 1n }]);

      const variants = {
        thumbnail: {
          webp: {
            url: 'https://cdn.example.com/thumbnail.webp',
            storagePath: 'assets/widget/thumbnail.webp',
            width: 150,
            height: 150,
            size: 100,
          },
          avif: {
            url: 'https://cdn.example.com/thumbnail.avif',
            storagePath: 'assets/widget/thumbnail.avif',
            width: 150,
            height: 150,
            size: 100,
          },
        },
        small: {
          webp: { url: 'u', storagePath: 'p', width: 400, height: 400, size: 100 },
          avif: { url: 'u', storagePath: 'p', width: 400, height: 400, size: 100 },
        },
        medium: {
          webp: { url: 'u', storagePath: 'p', width: 800, height: 800, size: 100 },
          avif: { url: 'u', storagePath: 'p', width: 800, height: 800, size: 100 },
        },
        large: {
          webp: { url: 'u', storagePath: 'p', width: 1200, height: 1200, size: 100 },
          avif: { url: 'u', storagePath: 'p', width: 1200, height: 1200, size: 100 },
        },
      };

      prisma.productVariant.findMany.mockResolvedValue([
        {
          id: 'variant-1',
          sku: 'WDG-001',
          price: dec(100),
          weight: null,
          productId: 'product-1',
          product: {
            id: 'p-1',
            name: { default: 'Widget' },
            slug: 'w',
            assets: [
              {
                asset: {
                  id: 'a-1',
                  status: 'READY',
                  variants,
                },
              },
            ],
          },
          attributeValues: [],
        },
      ]);
      prisma.order.create.mockResolvedValue(makeOrder());
      promotions.recordUsage.mockResolvedValue(undefined);
      cartService.clearCart.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.createOrder(BASE_ORDER_DTO as never, 'user-1', 'snap-4');

      const createCall = prisma.order.create.mock.calls[0] as [
        { data: { items: { create: Array<{ thumbnailUrl: string }> } } },
      ];
      expect(createCall[0].data.items.create[0].thumbnailUrl).toBe(
        'https://cdn.example.com/thumbnail.webp',
      );
    });
  });

  // ── cancelOrder (customer) ──────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('allows customer to cancel PENDING order', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING }));
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CANCELLED }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
      inventory.incrementStock.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});

      const result = await service.cancelOrder('order-1', 'user-1');
      expect((result as { status: OrderStatus }).status).toBe(OrderStatus.CANCELLED);
    });

    it('allows customer to cancel CONFIRMED order', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.CONFIRMED }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.CONFIRMED }));
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CANCELLED }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
      inventory.incrementStock.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});

      const result = await service.cancelOrder('order-1', 'user-1');
      expect((result as { status: OrderStatus }).status).toBe(OrderStatus.CANCELLED);
    });

    it('serializes the cancel response while updateStatus keeps the full row (plan J)', async () => {
      const full = makeOrder({
        status: OrderStatus.CANCELLED,
        internalNotes: 'admin only',
      });
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING }));
      // The shared admin path still hands back everything; the strip happens at
      // the cancelOrder boundary so the admin status route is unaffected.
      prisma.order.findUniqueOrThrow.mockResolvedValue(full);
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
      inventory.incrementStock.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});

      const result = (await service.cancelOrder('order-1', 'user-1')) as Record<string, unknown>;

      expect(result['status']).toBe(OrderStatus.CANCELLED);
      expect(result).not.toHaveProperty('internalNotes');
      expect(result).not.toHaveProperty('idempotencyKey');
      expect(result).not.toHaveProperty('userId');
      expect(result).not.toHaveProperty('user');
      expect(full).toHaveProperty('internalNotes', 'admin only');
    });

    it('rejects cancellation of SHIPPED order with ORDER_CANCEL_INELIGIBLE (409)', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.SHIPPED }));
      // B2 flips status from 400 to 409 (ConflictException) so the storefront
      // page's existing StorefrontConflictError catch fires for the first time.
      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { error: { code: 'ORDER_CANCEL_INELIGIBLE' } },
      });
    });

    it('rejects cancellation of DELIVERED order with ORDER_CANCEL_INELIGIBLE (409)', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.DELIVERED }));
      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { error: { code: 'ORDER_CANCEL_INELIGIBLE' } },
      });
    });

    it('rejects cancellation by non-owner', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder());
      await expect(service.cancelOrder('order-1', 'other-user')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('restores stock for each item on cancellation', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING }));
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CANCELLED }),
      );
      prisma.orderItem.findMany.mockResolvedValue([
        { variantId: 'v-1', quantity: 3 },
        { variantId: 'v-2', quantity: 1 },
      ]);
      inventory.incrementStock.mockResolvedValue(undefined);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.cancelOrder('order-1', 'user-1');

      expect(inventory.incrementStock).toHaveBeenCalledTimes(2);
      expect(inventory.incrementStock).toHaveBeenCalledWith(
        'v-1',
        3,
        'CORRECTION',
        expect.objectContaining({ referenceType: 'OrderCancellation' }),
      );
      expect(inventory.incrementStock).toHaveBeenCalledWith(
        'v-2',
        1,
        'CORRECTION',
        expect.objectContaining({ referenceType: 'OrderCancellation' }),
      );
    });
  });

  // == Order status history (plan M, phase M2, finding AD6) =================

  describe('order status history', () => {
    it('writes a transition row inside the same transaction as the status write', async () => {
      // Outside it, a status change could land with no history row and the
      // customer timeline would silently skip a step.
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PENDING }));
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CONFIRMED }),
      );
      prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1' });
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateStatus('order-1', OrderStatus.CONFIRMED, 'admin-1');

      expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.CONFIRMED,
        },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('writes no history row when the status race is lost', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PENDING }));
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateStatus('order-1', OrderStatus.CONFIRMED, 'admin-1'),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_STATUS_TRANSITION_INVALID' } },
      });
      expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });

    it('orders the timeline deterministically, not by timestamp alone', async () => {
      // `createdAt` is timestamp(3). A create followed immediately by a
      // programmatic status move can land two rows in the same millisecond, and
      // sorting on the timestamp alone would then order them arbitrarily.
      prisma.order.findUnique.mockResolvedValue(makeOrder());

      await service.findOneStorefront('order-1', 'user-1');

      const read = prisma.order.findUnique.mock.calls.at(-1)?.[0] as {
        include: { statusHistory: { orderBy: unknown } };
      };
      expect(read.include.statusHistory.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    });

    it('projects the history onto the two fields the customer timeline reads', async () => {
      const placed = new Date('2026-08-01T10:00:00.000Z');
      const confirmed = new Date('2026-08-01T11:00:00.000Z');
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({
          status: OrderStatus.CONFIRMED,
          statusHistory: [
            {
              id: 'h1',
              orderId: 'order-1',
              fromStatus: null,
              toStatus: 'PENDING',
              createdAt: placed,
            },
            {
              id: 'h2',
              orderId: 'order-1',
              fromStatus: 'PENDING',
              toStatus: 'CONFIRMED',
              createdAt: confirmed,
            },
          ],
        }),
      );

      const result = (await service.findOneStorefront('order-1', 'user-1')) as {
        statusHistory: Array<Record<string, unknown>>;
      };

      // The raw row carries an id, an orderId and a fromStatus the customer has
      // no use for. Only the two fields the timeline renders cross the wire.
      expect(result.statusHistory).toEqual([
        { status: 'PENDING', at: placed },
        { status: 'CONFIRMED', at: confirmed },
      ]);
    });

    it('carries the history through the cancel response too', async () => {
      // The page replaces its order with the cancel response, so a cancel that
      // dropped the history would blank the timeline until the next reload.
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING, shipments: [] }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING }));
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({
          status: OrderStatus.CANCELLED,
          statusHistory: [
            {
              id: 'h1',
              orderId: 'order-1',
              fromStatus: null,
              toStatus: 'PENDING',
              createdAt: new Date(),
            },
            {
              id: 'h2',
              orderId: 'order-1',
              fromStatus: 'PENDING',
              toStatus: 'CANCELLED',
              createdAt: new Date(),
            },
          ],
        }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
      prisma.auditLogEntry.create.mockResolvedValue({});

      const result = (await service.cancelOrder('order-1', 'user-1')) as {
        statusHistory: Array<{ status: string }>;
      };

      expect(result.statusHistory.map((e) => e.status)).toEqual(['PENDING', 'CANCELLED']);
    });
  });

  // == Cancel and shipment contract (plan M, phase M1) ======================

  describe('cancel and shipment contract', () => {
    function shipment(overrides: Record<string, unknown> = {}) {
      return {
        id: 'ship-1',
        orderId: 'order-1',
        carrier: 'DHL',
        trackingNumber: 'T123',
        status: 'PROCESSING',
        shippedAt: null,
        deliveredAt: null,
        items: [],
        ...overrides,
      };
    }

    it('refuses a customer cancel once the order has a shipment, naming the reason', async () => {
      // A shipment row is the warehouse saying fulfilment started. From that
      // point the customer talks to the store instead of self-serving.
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: OrderStatus.CONFIRMED, shipments: [shipment()] }),
      );

      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: {
          error: { code: 'ORDER_CANCEL_INELIGIBLE', details: { reason: 'HAS_SHIPMENT' } },
        },
      });
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(inventory.incrementStock).not.toHaveBeenCalled();
    });

    it('reports the status reason when the cancel is refused on status alone', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: OrderStatus.SHIPPED, shipments: [] }),
      );

      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { error: { code: 'ORDER_CANCEL_INELIGIBLE', details: { reason: 'STATUS' } } },
      });
    });

    it('does not tell a delivered customer their order is being prepared', async () => {
      // A DELIVERED order has shipments too. "Being prepared" would be a lie,
      // so the shipment branch only claims that inside the fulfilment window.
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: OrderStatus.DELIVERED, shipments: [shipment()] }),
      );

      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { error: { code: 'ORDER_CANCEL_INELIGIBLE', details: { reason: 'STATUS' } } },
      });
    });

    it('reports HAS_SHIPMENT once the shipment has moved the order to PROCESSING', async () => {
      // The realistic shape: creating the shipment also left the cancellable
      // window, so the status rule alone would answer the vaguer STATUS.
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: OrderStatus.PROCESSING, shipments: [shipment()] }),
      );

      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: {
          error: { code: 'ORDER_CANCEL_INELIGIBLE', details: { reason: 'HAS_SHIPMENT' } },
        },
      });
    });

    it('asks the database for non-cancelled shipments only', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.CONFIRMED, shipments: [] }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.CONFIRMED }));
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CANCELLED }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
      prisma.auditLogEntry.create.mockResolvedValue({});

      const result = await service.cancelOrder('order-1', 'user-1');

      expect((result as { status: OrderStatus }).status).toBe(OrderStatus.CANCELLED);
      // Filtered in the query, not in memory: a cancelled shipment must not
      // keep blocking the customer forever.
      expect(prisma.order.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            shipments: expect.objectContaining({
              where: { status: { not: 'CANCELLED' } },
            }),
          }),
        }),
      );
    });

    it('cascades PROCESSING shipments to CANCELLED in the same transaction as the order', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: OrderStatus.PROCESSING, shipments: [shipment()] }),
      );
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CANCELLED }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.shipment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'order-1', status: 'PROCESSING' },
        data: { status: 'CANCELLED' },
      });
      expect(inventory.incrementStock).toHaveBeenCalledTimes(1);
    });

    it('refuses an admin cancel while a shipment is in transit, before restoring stock', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.shipment.count.mockResolvedValue(1);

      await expect(
        service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1'),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_CANCEL_SHIPMENT_IN_TRANSIT' } },
      });
      expect(prisma.shipment.count).toHaveBeenCalledWith({
        where: { orderId: 'order-1', status: { in: ['SHIPPED', 'DELIVERED'] } },
      });
      // Stock must not be restored for a cancel that never happens.
      expect(inventory.incrementStock).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('rolls the new shipment back when the order closes underneath it', async () => {
      // A concurrent cancel can commit between the status check and the insert,
      // leaving a CANCELLED order carrying a live PROCESSING parcel, which is
      // the exact state this phase exists to make impossible. The insert and
      // the re-read share one transaction, so the re-read rolls it back.
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.CONFIRMED }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.CANCELLED }));
      prisma.shipment.create.mockResolvedValue(shipment());

      await expect(
        service.createShipment(
          'order-1',
          { items: [{ orderItemId: 'oi-1', quantity: 1 }] },
          'admin-1',
        ),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_SHIPMENT_ORDER_CLOSED' } },
      });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to create a shipment on a closed order', async () => {
      for (const status of [OrderStatus.CANCELLED, OrderStatus.COMPLETED, OrderStatus.RETURNED]) {
        prisma.order.findUnique.mockResolvedValue(makeOrder({ status }));
        await expect(
          service.createShipment(
            'order-1',
            { items: [{ orderItemId: 'oi-1', quantity: 1 }] },
            'admin-1',
          ),
        ).rejects.toMatchObject({
          response: { error: { code: 'ORDER_SHIPMENT_ORDER_CLOSED' } },
        });
      }
      expect(prisma.shipment.create).not.toHaveBeenCalled();
    });

    it('advances a CONFIRMED order to PROCESSING when its first shipment is created', async () => {
      // Three reads: the guard, the in-transaction re-read that catches a
      // concurrent cancel, and the one inside `updateStatus`.
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.CONFIRMED }));
      prisma.shipment.create.mockResolvedValue(shipment());
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.PROCESSING }),
      );
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.createShipment(
        'order-1',
        { items: [{ orderItemId: 'oi-1', quantity: 2 }] },
        'admin-1',
      );

      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSING' }) }),
      );
    });

    it('does not ship the order when a second parcel is added to a PROCESSING one', async () => {
      // The old auto-advance announced the whole order as shipped the moment a
      // second parcel was created, while the first was still being packed.
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.shipment.create.mockResolvedValue(shipment({ id: 'ship-2' }));
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.createShipment(
        'order-1',
        { items: [{ orderItemId: 'oi-1', quantity: 1 }] },
        'admin-1',
      );

      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalledWith(ORDER_EVENTS.SHIPPED, expect.anything());
    });

    it('refuses a shipment write on a closed order', async () => {
      prisma.shipment.findFirst.mockResolvedValue(shipment());
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.CANCELLED }));

      await expect(
        service.updateShipment('order-1', 'ship-1', { status: 'DELIVERED' }, 'admin-1'),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_SHIPMENT_ORDER_CLOSED' } },
      });
      expect(prisma.shipment.update).not.toHaveBeenCalled();
    });

    it('refuses to move a cancelled shipment back into the flow', async () => {
      prisma.shipment.findFirst.mockResolvedValue(shipment({ status: 'CANCELLED' }));
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));

      await expect(
        service.updateShipment('order-1', 'ship-1', { status: 'SHIPPED' }, 'admin-1'),
      ).rejects.toMatchObject({
        response: {
          error: {
            code: 'ORDER_SHIPMENT_ORDER_CLOSED',
            details: { reason: 'SHIPMENT_CANCELLED' },
          },
        },
      });
      expect(prisma.shipment.update).not.toHaveBeenCalled();
    });

    it('emits order.shipped once every non-cancelled shipment has shipped', async () => {
      // AD15: the mail resolver already reads carrier and tracking off the
      // newest shipment row, so the fix is firing the event at all.
      prisma.shipment.findFirst.mockResolvedValue(shipment());
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PROCESSING }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.shipment.update.mockResolvedValue(shipment({ status: 'SHIPPED' }));
      prisma.shipment.count.mockResolvedValue(0);
      prisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: OrderStatus.SHIPPED }));
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateShipment('order-1', 'ship-1', { status: 'SHIPPED' }, 'admin-1');

      expect(prisma.shipment.count).toHaveBeenCalledWith({
        where: { orderId: 'order-1', status: 'PROCESSING' },
      });
      expect(events.emit).toHaveBeenCalledWith(
        ORDER_EVENTS.SHIPPED,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('holds the order back while a sibling shipment is still being prepared', async () => {
      prisma.shipment.findFirst.mockResolvedValue(shipment());
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.shipment.update.mockResolvedValue(shipment({ status: 'SHIPPED' }));
      prisma.shipment.count.mockResolvedValue(1);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateShipment('order-1', 'ship-1', { status: 'SHIPPED' }, 'admin-1');

      expect(events.emit).not.toHaveBeenCalledWith(ORDER_EVENTS.SHIPPED, expect.anything());
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('refuses to cancel a shipment directly, and points at the order instead', async () => {
      // Cancelling the shipment on its own would strand it terminal while its
      // order stayed live and its stock stayed decremented. The DTO refuses it
      // too; this is the same rule at the service boundary.
      prisma.shipment.findFirst.mockResolvedValue(shipment());
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));

      await expect(
        service.updateShipment('order-1', 'ship-1', { status: 'CANCELLED' as never }, 'admin-1'),
      ).rejects.toMatchObject({
        response: {
          error: {
            code: 'ORDER_SHIPMENT_ORDER_CLOSED',
            details: { reason: 'CANCEL_THE_ORDER_INSTEAD' },
          },
        },
      });
      expect(prisma.shipment.updateMany).not.toHaveBeenCalled();
    });

    it('takes the shipment lock before reading what is in transit', async () => {
      // Counting first, outside the lock, left a window where a parcel shipped
      // between the check and the write, and the order was cancelled anyway.
      const calls: string[] = [];
      prisma.shipment.updateMany.mockImplementation(async () => {
        calls.push('cascade');
        return { count: 1 };
      });
      prisma.shipment.count.mockImplementation(async () => {
        calls.push('count');
        return 0;
      });
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CANCELLED }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

      expect(calls).toEqual(['cascade', 'count']);
    });

    it('restores stock only after the cancel has actually committed', async () => {
      // The restore used to run before the transaction, so a cancel that then
      // rolled back handed back units the warehouse still held.
      const calls: string[] = [];
      prisma.order.updateMany.mockImplementation(async () => {
        calls.push('order');
        return { count: 1 };
      });
      inventory.incrementStock.mockImplementation(async () => {
        calls.push('restore');
      });
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        makeOrder({ status: OrderStatus.CANCELLED }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1');

      // The payment close that follows is a second guarded order write.
      expect(calls.slice(0, 2)).toEqual(['order', 'restore']);
    });

    it('loses a status race cleanly, and restores no stock when it does', async () => {
      // Two concurrent cancels both read PROCESSING and both passed the
      // transition check. The write is WHERE-guarded on the status it read, so
      // exactly one of them writes a row and only that one restores stock.
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      prisma.orderItem.findMany.mockResolvedValue([{ variantId: 'variant-1', quantity: 2 }]);

      await expect(
        service.updateStatus('order-1', OrderStatus.CANCELLED, 'admin-1'),
      ).rejects.toMatchObject({
        response: { error: { code: 'ORDER_STATUS_TRANSITION_INVALID' } },
      });
      expect(inventory.incrementStock).not.toHaveBeenCalled();
    });

    it('refuses the shipment write when the cascade won the race for that row', async () => {
      // The read at the top of updateShipment is a snapshot. A blind update by
      // id would quietly reinstate a row the cascade had just cancelled.
      prisma.shipment.findFirst.mockResolvedValue(shipment());
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.shipment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateShipment('order-1', 'ship-1', { status: 'SHIPPED' }, 'admin-1'),
      ).rejects.toMatchObject({
        response: {
          error: {
            code: 'ORDER_SHIPMENT_ORDER_CLOSED',
            details: { reason: 'SHIPMENT_CANCELLED' },
          },
        },
      });
    });

    it('does not re-stamp shippedAt when the shipment is already shipped', async () => {
      // A retried PATCH used to rewrite "when did this actually ship".
      prisma.shipment.findFirst.mockResolvedValue(shipment({ status: 'SHIPPED' }));
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.SHIPPED }));
      prisma.shipment.updateMany.mockResolvedValue({ count: 1 });
      prisma.shipment.findUniqueOrThrow.mockResolvedValue(shipment({ status: 'SHIPPED' }));
      prisma.shipment.count.mockResolvedValue(0);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.updateShipment('order-1', 'ship-1', { status: 'SHIPPED' }, 'admin-1');

      const written = prisma.shipment.updateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(written.data).not.toHaveProperty('shippedAt');
    });

    it('swallows only the lost roll-up race, never another error', async () => {
      // Two parcels shipped at once both see zero left preparing. The loser
      // finds the order already SHIPPED, which is the right outcome, not an
      // error to hand back: its own shipment write succeeded.
      prisma.shipment.findFirst.mockResolvedValue(shipment());
      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PROCESSING }))
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.SHIPPED }));
      prisma.shipment.updateMany.mockResolvedValue({ count: 1 });
      prisma.shipment.findUniqueOrThrow.mockResolvedValue(shipment({ status: 'SHIPPED' }));
      prisma.shipment.count.mockResolvedValue(0);
      prisma.auditLogEntry.create.mockResolvedValue({});

      const result = await service.updateShipment(
        'order-1',
        'ship-1',
        { status: 'SHIPPED' },
        'admin-1',
      );

      expect((result as { status: string }).status).toBe('SHIPPED');
      expect(events.emit).not.toHaveBeenCalledWith(ORDER_EVENTS.SHIPPED, expect.anything());
    });

    it('sends cancellable true only while the customer can still act', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: OrderStatus.CONFIRMED, shipments: [] }),
      );
      const open = (await service.findOneStorefront('order-1', 'user-1')) as {
        cancellable: boolean;
      };
      expect(open.cancellable).toBe(true);

      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: OrderStatus.CONFIRMED, shipments: [shipment()] }),
      );
      const shipped = (await service.findOneStorefront('order-1', 'user-1')) as {
        cancellable: boolean;
      };
      expect(shipped.cancellable).toBe(false);

      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: OrderStatus.PROCESSING, shipments: [] }),
      );
      const processing = (await service.findOneStorefront('order-1', 'user-1')) as {
        cancellable: boolean;
      };
      // PROCESSING is outside CUSTOMER_CANCELLABLE; the storefront used to
      // offer the button here and take a 409 on click.
      expect(processing.cancellable).toBe(false);
    });

    it('still reports cancellable when the only shipment is cancelled', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({
          status: OrderStatus.CONFIRMED,
          shipments: [shipment({ status: 'CANCELLED' })],
        }),
      );

      const result = (await service.findOneStorefront('order-1', 'user-1')) as {
        cancellable: boolean;
      };

      expect(result.cancellable).toBe(true);
    });

    it('sends paymentRetryable true only where retryPayment would accept the order', async () => {
      const read = async (overrides: Record<string, unknown>) => {
        prisma.order.findUnique.mockResolvedValue(makeOrder(overrides));
        const out = (await service.findOneStorefront('order-1', 'user-1')) as {
          paymentRetryable: boolean;
        };
        return out.paymentRetryable;
      };

      expect(await read({ paymentMethodCode: 'card', paymentStatus: PaymentStatus.PENDING })).toBe(
        true,
      );
      expect(await read({ paymentMethodCode: 'card', paymentStatus: PaymentStatus.FAILED })).toBe(
        true,
      );
      expect(await read({ paymentMethodCode: 'card', paymentStatus: PaymentStatus.CAPTURED })).toBe(
        false,
      );
      expect(await read({ paymentMethodCode: null, paymentStatus: PaymentStatus.PENDING })).toBe(
        false,
      );
      expect(
        await read({
          paymentMethodCode: 'card',
          paymentStatus: PaymentStatus.PENDING,
          status: OrderStatus.CANCELLED,
        }),
      ).toBe(false);
    });

    it('sends paymentRetryable false for a method that collects no payment online', async () => {
      paymentGateway.collectsPaymentOnline.mockResolvedValue(false);
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ paymentMethodCode: 'cod', paymentStatus: PaymentStatus.PENDING }),
      );

      const out = (await service.findOneStorefront('order-1', 'user-1')) as {
        paymentRetryable: boolean;
      };

      expect(out.paymentRetryable).toBe(false);
    });
  });

  // ── createShipment ──────────────────────────────────────────────────────

  describe('createShipment', () => {
    it('creates a shipment for valid items', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.PROCESSING }));
      prisma.shipment.create.mockResolvedValue({
        id: 'ship-1',
        orderId: 'order-1',
        carrier: 'DHL',
        trackingNumber: 'T123',
        status: 'PROCESSING',
        items: [],
      });
      prisma.auditLogEntry.create.mockResolvedValue({});

      const result = await service.createShipment(
        'order-1',
        { items: [{ orderItemId: 'oi-1', quantity: 2 }], carrier: 'DHL', trackingNumber: 'T123' },
        'admin-1',
      );
      expect((result as { id: string }).id).toBe('ship-1');
    });

    it('rejects items not belonging to order', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder());
      await expect(
        service.createShipment(
          'order-1',
          { items: [{ orderItemId: 'wrong-item', quantity: 1 }] },
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── editOrder ───────────────────────────────────────────────────────────

  describe('editOrder', () => {
    it('rejects editing a SHIPPED order', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: OrderStatus.SHIPPED }));
      await expect(
        service.editOrder('order-1', { internalNotes: 'test' }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows editing a PENDING order', async () => {
      const order = makeOrder({ status: OrderStatus.PENDING });
      prisma.order.findUnique
        .mockResolvedValueOnce(order)
        .mockResolvedValueOnce(order)
        .mockResolvedValueOnce(order);
      prisma.order.update.mockResolvedValue(makeOrder());
      prisma.orderItem.findMany.mockResolvedValue(makeOrder().items);
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.editOrder('order-1', { internalNotes: 'VIP customer' }, 'admin-1');
      expect(prisma.order.update).toHaveBeenCalled();
    });

    // The third AD2 site: adding a line to an existing order from the admin.
    it('snapshots an added line label as resolved text, not "[object Object]"', async () => {
      const order = makeOrder({ status: OrderStatus.PENDING });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.update.mockResolvedValue(makeOrder());
      prisma.orderItem.findMany.mockResolvedValue(makeOrder().items);
      prisma.orderItem.create.mockResolvedValue({});
      prisma.auditLogEntry.create.mockResolvedValue({});
      prisma.productVariant.findUnique.mockResolvedValue({
        id: 'variant-2',
        sku: 'WDG-002',
        price: dec(100),
        weight: dec(0.5),
        isActive: true,
        deletedAt: null,
        productId: 'product-1',
        product: {
          id: 'product-1',
          name: { default: 'Widget', fr: 'Widget', en: 'Widget' },
          slug: 'widget',
          deletedAt: null,
          assets: [],
        },
        attributeValues: [
          { attributeValue: { value: { default: 'Métal', fr: 'Métal', en: 'Metal' } } },
        ],
      });
      inventory.checkAvailability.mockResolvedValue({ available: 10, locations: [] });
      inventory.decrementStock.mockResolvedValue(true);

      await service.editOrder(
        'order-1',
        { addItems: [{ variantId: 'variant-2', quantity: 1 }] } as never,
        'admin-1',
        'en',
      );

      const created = prisma.orderItem.create.mock.calls.at(-1)?.[0] as {
        data: { variantLabel: string | null };
      };
      expect(created.data.variantLabel).toBe('Metal');
    });

    it('RE-computes tax on edit rather than carrying the stored amount forward', async () => {
      // `recalculateOrderTotals` used to read the stored `taxAmount` and add it
      // back unchanged, so editing an order's line items moved the subtotal
      // while the VAT stayed at whatever the original basket produced. Latent
      // at a 0 per cent rate; an incorrect invoice at 19 per cent.
      const order = makeOrder({ status: OrderStatus.PENDING });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.update.mockResolvedValue(makeOrder());
      // One line at 100 x 1 rather than the fixture's 200, so the subtotal
      // moves and a carried-forward tax would be visibly stale.
      prisma.orderItem.findMany.mockResolvedValue([{ unitPrice: dec(100), quantity: 1 }]);
      prisma.auditLogEntry.create.mockResolvedValue({});
      taxService.calculateTax.mockResolvedValue({ rate: 0.19, amount: 19, zone: null });

      await service.editOrder('order-1', { internalNotes: 'x' }, 'admin-1');

      // Taxed on the new post-discount base, using the order's own country.
      expect(taxService.calculateTax).toHaveBeenCalledWith('LY', null, 100);
      const written = prisma.order.update.mock.calls.at(-1)?.[0] as {
        data: { subtotal: number; taxAmount: number; total: number };
      };
      expect(written.data.subtotal).toBe(100);
      expect(written.data.taxAmount).toBe(19);
      // 100 goods + 10 shipping + 19 VAT. The stale value would have been 5.
      expect(written.data.total).toBe(129);
    });

    it('keeps the stored tax when the order carries no shipping country', async () => {
      const order = makeOrder({ status: OrderStatus.PENDING, shippingAddress: {} });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.update.mockResolvedValue(makeOrder());
      prisma.orderItem.findMany.mockResolvedValue([{ unitPrice: dec(100), quantity: 1 }]);
      prisma.auditLogEntry.create.mockResolvedValue({});
      taxService.calculateTax.mockClear();

      await service.editOrder('order-1', { internalNotes: 'x' }, 'admin-1');

      expect(taxService.calculateTax).not.toHaveBeenCalled();
      const written = prisma.order.update.mock.calls.at(-1)?.[0] as {
        data: { taxAmount: number };
      };
      expect(written.data.taxAmount).toBe(5);
    });
  });

  // ── queries ─────────────────────────────────────────────────────────────

  describe('confirmPayment', () => {
    function pendingCard(overrides: Record<string, unknown> = {}) {
      return makeOrder({
        paymentMethodCode: 'card',
        paymentStatus: PaymentStatus.PENDING,
        paymentReference: 'pi_1',
        ...overrides,
      });
    }

    beforeEach(() => {
      paymentGateway.providerIdFor.mockResolvedValue('stripe');
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
    });

    it('asks the provider and moves the order forward, then answers the stored status', async () => {
      prisma.order.findUnique
        .mockResolvedValueOnce(pendingCard())
        .mockResolvedValueOnce(pendingCard())
        .mockResolvedValueOnce(pendingCard({ paymentStatus: PaymentStatus.CAPTURED }));
      paymentGateway.getStatus.mockResolvedValue({
        reference: 'pi_1',
        status: PaymentStatus.CAPTURED,
      });

      const result = await service.confirmPayment('order-1', { userId: 'user-1' });

      expect(paymentGateway.getStatus).toHaveBeenCalledWith('card', {
        reference: 'pi_1',
        status: PaymentStatus.PENDING,
      });
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: PaymentStatus.PENDING },
        data: { paymentStatus: PaymentStatus.CAPTURED },
      });
      expect(result).toEqual({ paymentStatus: PaymentStatus.CAPTURED });
    });

    it('leaves the order alone when the provider still says pending', async () => {
      prisma.order.findUnique.mockResolvedValue(pendingCard());
      paymentGateway.getStatus.mockResolvedValue({
        reference: 'pi_1',
        status: PaymentStatus.PENDING,
      });

      const result = await service.confirmPayment('order-1', { userId: 'user-1' });

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ paymentStatus: PaymentStatus.PENDING });
    });

    it('answers not found to a caller who does not own the order', async () => {
      prisma.order.findUnique.mockResolvedValue(pendingCard());
      await expect(service.confirmPayment('order-1', {})).rejects.toMatchObject({
        response: { error: { code: 'ORDER_NOT_FOUND' } },
      });
      expect(paymentGateway.getStatus).not.toHaveBeenCalled();
    });

    it('does not call the provider for an order with no provider payment', async () => {
      prisma.order.findUnique.mockResolvedValue(
        pendingCard({ paymentMethodCode: null, paymentReference: null }),
      );
      const result = await service.confirmPayment('order-1', { userId: 'user-1' });
      expect(paymentGateway.getStatus).not.toHaveBeenCalled();
      expect(result).toEqual({ paymentStatus: PaymentStatus.PENDING });
    });
  });

  describe('retryPayment', () => {
    const action = { type: 'embedded', clientToken: 'tok_2' };

    function retryable(overrides: Record<string, unknown> = {}) {
      return makeOrder({
        paymentMethodCode: 'card',
        paymentStatus: PaymentStatus.FAILED,
        paymentReference: 'pi_old',
        ...overrides,
      });
    }

    it('opens a fresh session for the owner and returns its action', async () => {
      prisma.order.findUnique.mockResolvedValue(retryable());
      paymentGateway.openSession.mockResolvedValueOnce({
        reference: 'pi_new',
        status: PaymentStatus.PENDING,
        action,
      });

      const result = await service.retryPayment('order-1', {
        userId: 'user-1',
        acceptLanguage: 'en',
      });

      expect(paymentGateway.openSession).toHaveBeenCalledWith(
        'card',
        expect.objectContaining({
          orderId: 'order-1',
          currencyCode: 'LYD',
          returnUrl: 'https://storefront.example.test/en/order-confirmation/ORD-2026-000001',
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { paymentReference: 'pi_new', paymentStatus: PaymentStatus.PENDING },
      });
      expect(result).toEqual({ paymentAction: action });
    });

    it('closes the previous attempt with a key tied to its reference', async () => {
      prisma.order.findUnique.mockResolvedValue(retryable());
      paymentGateway.openSession.mockResolvedValueOnce({
        reference: 'pi_new',
        status: PaymentStatus.PENDING,
        action,
      });

      await service.retryPayment('order-1', { userId: 'user-1' });

      expect(paymentGateway.cancel).toHaveBeenCalledWith(
        'card',
        expect.objectContaining({
          reference: 'pi_old',
          idempotencyKey: 'retry-cancel:pi_old',
        }),
      );
    });

    it('still opens a new session when the old one cannot be closed', async () => {
      prisma.order.findUnique.mockResolvedValue(retryable());
      paymentGateway.cancel.mockRejectedValueOnce(new Error('session gone'));
      paymentGateway.openSession.mockResolvedValueOnce({
        reference: 'pi_new',
        status: PaymentStatus.PENDING,
        action,
      });

      const result = await service.retryPayment('order-1', { userId: 'user-1' });

      expect(result).toEqual({ paymentAction: action });
    });

    it('lets the guest session that placed the order retry', async () => {
      prisma.order.findUnique.mockResolvedValue(
        retryable({ userId: null, guestSessionId: 'sess-1' }),
      );
      await expect(
        service.retryPayment('order-1', { sessionId: 'sess-1' }),
      ).resolves.toHaveProperty('paymentAction');
    });

    it('answers not found to an anonymous caller who does not own the order', async () => {
      prisma.order.findUnique.mockResolvedValue(retryable());
      await expect(service.retryPayment('order-1', {})).rejects.toMatchObject({
        response: { error: { code: 'ORDER_NOT_FOUND' } },
      });
      expect(paymentGateway.openSession).not.toHaveBeenCalled();
    });

    it.each([PaymentStatus.CAPTURED, PaymentStatus.REFUNDED, PaymentStatus.AUTHORIZED])(
      'refuses with a stable code when the payment is %s',
      async (paymentStatus) => {
        prisma.order.findUnique.mockResolvedValue(retryable({ paymentStatus }));
        await expect(service.retryPayment('order-1', { userId: 'user-1' })).rejects.toMatchObject({
          response: { error: { code: 'ORDER_PAYMENT_NOT_RETRYABLE' } },
        });
        expect(paymentGateway.openSession).not.toHaveBeenCalled();
      },
    );

    it('refuses when the method collects no payment online (cod, manual)', async () => {
      paymentGateway.collectsPaymentOnline.mockResolvedValue(false);
      prisma.order.findUnique.mockResolvedValue(
        retryable({ paymentMethodCode: 'cod', paymentStatus: PaymentStatus.PENDING }),
      );
      await expect(service.retryPayment('order-1', { userId: 'user-1' })).rejects.toMatchObject({
        response: { error: { code: 'ORDER_PAYMENT_NOT_RETRYABLE' } },
      });
      expect(paymentGateway.openSession).not.toHaveBeenCalled();
    });

    it('refuses on a cancelled order', async () => {
      prisma.order.findUnique.mockResolvedValue(retryable({ status: OrderStatus.CANCELLED }));
      await expect(service.retryPayment('order-1', { userId: 'user-1' })).rejects.toMatchObject({
        response: { error: { code: 'ORDER_PAYMENT_NOT_RETRYABLE' } },
      });
    });

    it('refuses when the order never chose a payment method', async () => {
      prisma.order.findUnique.mockResolvedValue(retryable({ paymentMethodCode: null }));
      await expect(service.retryPayment('order-1', { userId: 'user-1' })).rejects.toMatchObject({
        response: { error: { code: 'ORDER_PAYMENT_NOT_RETRYABLE' } },
      });
    });
  });

  describe('findOneStorefront', () => {
    it('returns order for the owner', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder());
      const result = await service.findOneStorefront('order-1', 'user-1');
      expect(result).toHaveProperty('orderNumber');
    });

    it('throws Forbidden for non-owner', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder());
      await expect(service.findOneStorefront('order-1', 'other-user')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('maps a live product slug onto each line so the order links back', async () => {
      // `OrderItem` snapshots the purchase and has no slug column, so the
      // storefront could not link an order line to its product: the schema
      // already tolerated `productSlug` and the API simply never sent one.
      // Resolved in this query only, never by widening the shared
      // ORDER_INCLUDE the admin also reads.
      prisma.order.findUnique.mockResolvedValue(makeOrder());
      prisma.product.findMany.mockResolvedValue([
        { id: 'product-1', slug: 'widget', deletedAt: null },
      ]);

      const result = (await service.findOneStorefront('order-1', 'user-1')) as {
        items: Array<Record<string, unknown>>;
      };

      expect(result.items[0].productSlug).toBe('widget');
    });

    it('omits the slug for a product archived since the order was placed', async () => {
      // A link into a 404 is worse than plain text.
      prisma.order.findUnique.mockResolvedValue(makeOrder());
      prisma.product.findMany.mockResolvedValue([
        { id: 'product-1', slug: 'widget', deletedAt: new Date() },
      ]);

      const result = (await service.findOneStorefront('order-1', 'user-1')) as {
        items: Array<Record<string, unknown>>;
      };

      expect(result.items[0].productSlug).toBeUndefined();
    });

    it('returns the customer field set and no admin fields (finding AD2)', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ internalNotes: 'QA-SECRET-NOTE: fraud check pending' }),
      );

      const result = (await service.findOneStorefront('order-1', 'user-1')) as Record<
        string,
        unknown
      >;

      expect(Object.keys(result).sort()).toEqual(
        [
          'billingAddress',
          'cancellable',
          'couponCode',
          'createdAt',
          'currency',
          'discountAmount',
          'id',
          'invoice',
          'items',
          'notes',
          'orderNumber',
          'paymentRetryable',
          'paymentStatus',
          'shippingAddress',
          'shippingAmount',
          'shippingMethodName',
          'shipments',
          'status',
          'statusHistory',
          'subtotal',
          'taxAmount',
          'total',
          'updatedAt',
        ].sort(),
      );
      expect(JSON.stringify(result)).not.toContain('QA-SECRET-NOTE');
    });

    it('keeps the money remap bit-identical to the pre-serializer behaviour', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder());

      const result = (await service.findOneStorefront('order-1', 'user-1')) as {
        subtotal: number;
        total: number;
        items: { unitPrice: number; total: number }[];
      };

      expect(result.subtotal).toBe(200);
      expect(result.total).toBe(215);
      expect(result.items[0].unitPrice).toBe(100);
      expect(result.items[0].total).toBe(200);
    });
  });

  describe('listStorefront', () => {
    it('returns paginated orders scoped to the caller userId', async () => {
      const orders = [makeOrder({ id: 'o1' }), makeOrder({ id: 'o2' })];
      prisma.order.findMany.mockResolvedValue(orders);
      prisma.order.count.mockResolvedValue(2);

      const result = await service.listStorefront('user-1', { page: 1, pageSize: 20 });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
      expect(prisma.order.count).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(result.data).toHaveLength(2);
      expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 2 });
    });

    it('selects the customer list shape — no userId, no user relation (plan J)', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.listStorefront('user-1', { page: 1, pageSize: 20 });

      const args = prisma.order.findMany.mock.calls.at(-1)?.[0] as {
        select: Record<string, unknown>;
      };
      expect(args.select).not.toHaveProperty('userId');
      expect(args.select).not.toHaveProperty('user');
      expect(args.select).toHaveProperty('orderNumber', true);
      expect(args.select).toHaveProperty('total', true);
    });

    it('returns empty array + zeroed total for a user with no orders', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const result = await service.listStorefront('user-empty', { page: 1, pageSize: 20 });

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
    });

    it('honours page + pageSize and translates them to skip/take', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.listStorefront('user-1', { page: 3, pageSize: 5 });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 }),
      );
    });

    it('caps pageSize at 100 even when caller asks for more', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.listStorefront('user-1', { page: 1, pageSize: 500 });

      expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    });

    it('threads status through the where clause when caller supplies it', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.listStorefront('user-1', {
        page: 1,
        pageSize: 20,
        status: OrderStatus.SHIPPED,
      });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', status: OrderStatus.SHIPPED } }),
      );
      expect(prisma.order.count).toHaveBeenCalledWith({
        where: { userId: 'user-1', status: OrderStatus.SHIPPED },
      });
    });
  });

  describe('getInvoice', () => {
    it('returns the invoice payload for the owner', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        orderNumber: 'ORD-2026-000001',
        currency: 'LYD',
      });
      const invoice = { id: 'inv-1', orderId: 'order-1', issuedAt: new Date() };
      prisma.invoice.findUnique.mockResolvedValue(invoice);

      const result = await service.getInvoice('order-1', 'user-1');

      expect(result).toMatchObject({
        id: 'inv-1',
        orderId: 'order-1',
        orderNumber: 'ORD-2026-000001',
        currency: 'LYD',
      });
      expect(prisma.invoice.findUnique).toHaveBeenCalledWith({ where: { orderId: 'order-1' } });
    });

    it('attaches the storefront downloadUrl for the owner caller', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        orderNumber: 'ORD-2026-000001',
        currency: 'LYD',
      });
      prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', orderId: 'order-1' });

      const result = (await service.getInvoice('order-1', 'user-1')) as { downloadUrl: string };
      expect(result.downloadUrl).toBe('/v1/orders/order-1/invoice/pdf');
    });

    it('attaches the admin downloadUrl when called without a userId', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        orderNumber: 'ORD-2026-000001',
        currency: 'LYD',
      });
      prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', orderId: 'order-1' });

      const result = (await service.getInvoice('order-1')) as { downloadUrl: string };
      expect(result.downloadUrl).toBe('/v1/admin/orders/order-1/invoice/pdf');
    });

    it('throws NotFound when the order does not exist', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(service.getInvoice('missing-order', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getInvoicePdf', () => {
    const order = {
      id: 'order-1',
      userId: 'user-1',
      orderNumber: 'ORD-2026-000001',
      currency: 'LYD',
      user: { locale: 'fr' },
    };
    const invoice = {
      id: 'inv-1',
      orderId: 'order-1',
      invoiceNumber: 'INV-2026-000001',
      items: [
        {
          orderItemId: 'oi-1',
          // Stored as a Translatable snapshot (OrderItem.productName is Json) —
          // the renderer must receive a resolved string, not this object.
          productName: { default: 'Miel', fr: 'Miel', en: 'Honey' },
          sku: 'H1',
          unitPrice: 10,
          quantity: 2,
          total: 20,
        },
      ],
      subtotal: 20,
      discountAmount: 0,
      shippingAmount: 10,
      taxAmount: 0,
      total: 30,
      shippingMethodName: 'Standard',
      billingAddress: { fullName: 'A', country: 'LY' },
      issuedAt: new Date('2026-06-24T00:00:00Z'),
    };

    it('renders + persists the PDF to the deterministic private key on first download', async () => {
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.invoice.findUnique.mockResolvedValue(invoice);
      storage.read.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      storage.save.mockResolvedValue({
        storagePath: 'private/invoices/order-1/INV-2026-000001.pdf',
        url: '',
      });

      const result = await service.getInvoicePdf('order-1', { userId: 'user-1' });

      // The document renders in the customer's own locale since D7. Before it,
      // one constant pinned every invoice to English because the renderer had
      // no French label set, which put French line items inside an
      // English-labelled document.
      expect(invoicePdf.render).toHaveBeenCalledWith(
        expect.objectContaining({
          locale: 'fr',
          order: { orderNumber: 'ORD-2026-000001', currency: 'LYD' },
        }),
      );
      // The Translatable productName snapshot must be resolved to the
      // customer's locale (fr) BEFORE reaching the renderer, never passed as
      // the raw object (which would print `[object Object]` on the PDF).
      const renderArg = invoicePdf.render.mock.calls[0][0];
      expect(renderArg.invoice.items[0].productName).toBe('Miel');
      expect(storage.save).toHaveBeenCalledWith(
        expect.any(Buffer),
        'private/invoices/order-1/INV-2026-000001-fr.pdf',
        { visibility: 'private' },
      );
      expect(result.invoiceNumber).toBe('INV-2026-000001');
      expect(result.buffer.toString()).toContain('%PDF');
    });

    it('keys the cached object by locale, so one reader cannot freeze the other', async () => {
      prisma.order.findUnique.mockResolvedValue({ ...order, user: { locale: 'en' } });
      prisma.invoice.findUnique.mockResolvedValue(invoice);
      storage.read.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      invoicePdf.render.mockResolvedValue(Buffer.from('%PDF-en'));

      await service.getInvoicePdf('order-1', { userId: 'user-1' });

      // A shared key would have served whichever language was requested first
      // to every later reader, and would have kept every pre-rebrand document
      // alive forever.
      expect(storage.read).toHaveBeenCalledWith('private/invoices/order-1/INV-2026-000001-en.pdf');
      expect(storage.save).toHaveBeenCalledWith(
        expect.any(Buffer),
        'private/invoices/order-1/INV-2026-000001-en.pdf',
        { visibility: 'private' },
      );
    });

    it('serves the cached object without re-rendering on subsequent downloads', async () => {
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.invoice.findUnique.mockResolvedValue(invoice);
      storage.read.mockResolvedValue(Buffer.from('%PDF-cached'));

      const result = await service.getInvoicePdf('order-1', { userId: 'user-1' });

      expect(invoicePdf.render).not.toHaveBeenCalled();
      expect(storage.save).not.toHaveBeenCalled();
      expect(result.buffer.toString()).toBe('%PDF-cached');
    });

    it('rejects a non-owner caller with OrderNotYoursException (no render)', async () => {
      prisma.order.findUnique.mockResolvedValue(order);

      await expect(service.getInvoicePdf('order-1', { userId: 'intruder' })).rejects.toThrow(
        ForbiddenException,
      );
      expect(invoicePdf.render).not.toHaveBeenCalled();
    });

    it('throws ORDER_INVOICE_NOT_READY when the invoice is not generated yet', async () => {
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.invoice.findUnique.mockResolvedValue(null);

      await expect(service.getInvoicePdf('order-1', { userId: 'user-1' })).rejects.toMatchObject({
        response: { error: { code: 'ORDER_INVOICE_NOT_READY' } },
      });
    });

    it('throws OrderNotFound when the order does not exist', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(service.getInvoicePdf('missing', { userId: 'user-1' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('propagates a non-not-found storage error instead of masking it as a re-render', async () => {
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.invoice.findUnique.mockResolvedValue(invoice);
      storage.read.mockRejectedValue(Object.assign(new Error('creds'), { name: 'AccessDenied' }));

      await expect(service.getInvoicePdf('order-1', { userId: 'user-1' })).rejects.toThrow('creds');
      expect(invoicePdf.render).not.toHaveBeenCalled();
    });
  });

  describe('getInvoice — ownership + readiness', () => {
    it('throws Forbidden for a non-owner caller (storefront context)', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        orderNumber: 'ORD-2026-000001',
        currency: 'LYD',
      });

      await expect(service.getInvoice('order-1', 'other-user')).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFound when the invoice has not yet been generated', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        orderNumber: 'ORD-2026-000001',
        currency: 'LYD',
      });
      prisma.invoice.findUnique.mockResolvedValue(null);

      await expect(service.getInvoice('order-1', 'user-1')).rejects.toMatchObject({
        response: { error: { code: 'ORDER_INVOICE_NOT_READY' } },
      });
    });
  });

  describe('listAdmin', () => {
    it('returns paginated results', async () => {
      prisma.order.findMany.mockResolvedValue([makeOrder()]);
      prisma.order.count.mockResolvedValue(1);
      const result = await service.listAdmin({ page: 1, pageSize: 20 });
      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    });
  });

  describe('trackOrder', () => {
    it('returns tracking info for valid order+email', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...makeOrder(),
        user: { email: 'test@example.com' },
        shipments: [],
      });
      const result = await service.trackOrder({
        orderNumber: 'ORD-2026-000001',
        email: 'test@example.com',
      });
      expect(result).toHaveProperty('orderNumber', 'ORD-2026-000001');
    });

    it('throws NotFound for wrong email', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...makeOrder(),
        user: { email: 'real@example.com' },
      });
      await expect(
        service.trackOrder({ orderNumber: 'ORD-2026-000001', email: 'wrong@example.com' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getStats', () => {
    it('returns aggregated statistics', async () => {
      prisma.order.count.mockResolvedValue(10);
      prisma.order.aggregate.mockResolvedValue({
        _sum: { total: dec(1000) },
        _avg: { total: dec(100) },
      });
      prisma.order.groupBy.mockResolvedValue([
        { status: 'PENDING', _count: { id: 5 } },
        { status: 'COMPLETED', _count: { id: 5 } },
      ]);

      const result = (await service.getStats()) as Record<string, unknown>;
      expect(result.totalOrders).toBe(10);
      expect(result.totalRevenue).toBe(1000);
      expect(result.averageOrderValue).toBe(100);
    });
  });

  describe('exportCsv', () => {
    it('returns CSV string with header and rows', async () => {
      prisma.order.findMany.mockResolvedValue([
        {
          orderNumber: 'ORD-2026-000001',
          status: 'PENDING',
          paymentStatus: 'PENDING',
          subtotal: dec(200),
          discountAmount: dec(0),
          shippingAmount: dec(10),
          taxAmount: dec(5),
          total: dec(215),
          currency: 'LYD',
          couponCode: null,
          createdAt: new Date('2026-01-01'),
          user: { email: 'test@example.com', firstName: 'Test', lastName: 'User' },
        },
      ]);

      const csv = await service.exportCsv({});
      expect(csv).toContain('Order Number');
      expect(csv).toContain('ORD-2026-000001');
      expect(csv).toContain('test@example.com');
    });
  });
});

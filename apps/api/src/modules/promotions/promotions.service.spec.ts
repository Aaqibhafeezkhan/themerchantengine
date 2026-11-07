import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PromotionApplicationMethod, PromotionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PromotionsService } from './promotions.service';
import { storeMoney } from '@common/money';
import { MoneyFormatterService } from '../currencies/money-formatter.service';

// ── Factories ─────────────────────────────────────────────────────────────────

function makePromotion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'promo-1',
    name: { default: 'Summer Sale', en: 'Summer Sale', fr: 'Soldes d’été' },
    description: null,
    type: PromotionType.PERCENTAGE,
    applicationMethod: PromotionApplicationMethod.COUPON,
    couponCode: 'SUMMER20',
    value: 20,
    minimumOrderAmount: null,
    maximumDiscount: null,
    usageLimit: null,
    usageLimitPerUser: null,
    isExclusive: false,
    priority: 0,
    buyQuantity: null,
    getQuantity: null,
    tierConfig: null,
    startsAt: null,
    endsAt: null,
    isActive: true,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    eligibleProducts: [],
    eligibleCategories: [],
    ...overrides,
  };
}

const CART_ITEMS = [{ productId: 'prod-1', categoryId: 'cat-1', quantity: 2, unitPrice: 50 }];

// ── Prisma mock ───────────────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    promotion: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    promotionUsage: {
      create: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

/** The money formatter over the process snapshot, so amounts follow `storeMoney`. */
function moneyFormatterMock() {
  return {
    format: (value: unknown, code?: string | null) => storeMoney.format(value as never, code),
    currencyCode: () => storeMoney.currencyCode(),
    taxLabel: () => storeMoney.taxLabel(),
    config: () => storeMoney.current(),
  };
}

describe('PromotionsService', () => {
  let service: PromotionsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromotionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MoneyFormatterService, useValue: moneyFormatterMock() },
      ],
    }).compile();

    service = module.get(PromotionsService);
  });

  // ── validateCoupon ─────────────────────────────────────────────────────────

  describe('validateCoupon', () => {
    // Default: no exclusive automatic promotions active (H-3 check passes through)
    beforeEach(() => {
      prisma.promotion.findMany.mockResolvedValue([]);
    });

    it('returns discount for valid PERCENTAGE coupon', async () => {
      prisma.promotion.findFirst.mockResolvedValue(makePromotion({ value: 20 }));
      prisma.promotionUsage.count.mockResolvedValue(0);

      const result = await service.validateCoupon('SUMMER20', 100, CART_ITEMS);

      expect(result.discountAmount).toBeCloseTo(20); // 100 × 20%
      expect(result.code).toBe('SUMMER20');
      expect(result.type).toBe(PromotionType.PERCENTAGE);
    });

    it('matches the code case-insensitively and ignores surrounding spaces', async () => {
      prisma.promotion.findFirst.mockResolvedValue(makePromotion({ value: 20 }));
      prisma.promotionUsage.count.mockResolvedValue(0);

      await service.validateCoupon(' summer20 ', 100, CART_ITEMS);

      expect(prisma.promotion.findFirst.mock.calls[0][0].where.couponCode).toBe('SUMMER20');
    });

    it('throws COUPON_INVALID for unknown code', async () => {
      prisma.promotion.findFirst.mockResolvedValue(null);

      // All four validateCoupon failure modes (not-found, expired,
      // usage-exceeded, exclusive-collision) emit the same code by §8.1
      // API6 enumeration-mask design; the rest of the failure-mode tests
      // below assert instanceof BadRequestException and inherit the code
      // assertion transitively (CouponInvalidException extends).
      await expect(service.validateCoupon('INVALID', 100, CART_ITEMS)).rejects.toMatchObject({
        response: { error: { code: 'COUPON_INVALID' } },
      });
    });

    it('throws BadRequestException when promotion is inactive', async () => {
      prisma.promotion.findFirst.mockResolvedValue(null); // findFirst filters isActive:true

      await expect(service.validateCoupon('SUMMER20', 100, CART_ITEMS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when subtotal is below minimumOrderAmount', async () => {
      prisma.promotion.findFirst.mockResolvedValue(makePromotion({ minimumOrderAmount: 200 }));

      await expect(service.validateCoupon('SUMMER20', 50, CART_ITEMS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when startsAt is in the future', async () => {
      const future = new Date(Date.now() + 86_400_000);
      prisma.promotion.findFirst.mockResolvedValue(makePromotion({ startsAt: future }));

      await expect(service.validateCoupon('SUMMER20', 100, CART_ITEMS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when endsAt is in the past', async () => {
      const past = new Date(Date.now() - 86_400_000);
      prisma.promotion.findFirst.mockResolvedValue(makePromotion({ endsAt: past }));

      await expect(service.validateCoupon('SUMMER20', 100, CART_ITEMS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when global usageLimit is exhausted', async () => {
      prisma.promotion.findFirst.mockResolvedValue(makePromotion({ usageLimit: 5 }));
      prisma.promotionUsage.count.mockResolvedValue(5); // at limit

      await expect(service.validateCoupon('SUMMER20', 100, CART_ITEMS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when per-user usageLimitPerUser is exhausted', async () => {
      prisma.promotion.findFirst.mockResolvedValue(makePromotion({ usageLimitPerUser: 1 }));
      // First count = per-user (1 usage), second = global (0 limit = not checked)
      prisma.promotionUsage.count.mockResolvedValue(1);

      await expect(service.validateCoupon('SUMMER20', 100, CART_ITEMS, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when no cart item matches eligible products', async () => {
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({
          eligibleProducts: [{ productId: 'prod-UNRELATED' }],
          eligibleCategories: [],
        }),
      );

      await expect(service.validateCoupon('SUMMER20', 100, CART_ITEMS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('passes eligibility when cart item matches eligible product', async () => {
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({
          eligibleProducts: [{ productId: 'prod-1' }],
          eligibleCategories: [],
        }),
      );
      prisma.promotionUsage.count.mockResolvedValue(0);

      const result = await service.validateCoupon('SUMMER20', 100, CART_ITEMS);
      expect(result.discountAmount).toBeGreaterThanOrEqual(0);
    });

    it('caps discount at maximumDiscount when set', async () => {
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({ value: 50, maximumDiscount: 30 }),
      );
      prisma.promotionUsage.count.mockResolvedValue(0);

      const result = await service.validateCoupon('SUMMER20', 200, CART_ITEMS);

      // 200 × 50% = 100, but capped at 30
      expect(result.discountAmount).toBeCloseTo(30);
    });

    it('calculates FIXED_AMOUNT discount correctly', async () => {
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({ type: PromotionType.FIXED_AMOUNT, value: 15 }),
      );
      prisma.promotionUsage.count.mockResolvedValue(0);

      const result = await service.validateCoupon('FIXED15', 100, CART_ITEMS);
      expect(result.discountAmount).toBeCloseTo(15);
    });

    it('FIXED_AMOUNT is capped at subtotal when value exceeds it', async () => {
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({ type: PromotionType.FIXED_AMOUNT, value: 200 }),
      );
      prisma.promotionUsage.count.mockResolvedValue(0);

      const result = await service.validateCoupon('BIG', 50, CART_ITEMS);
      expect(result.discountAmount).toBeCloseTo(50); // capped at subtotal
    });

    it('FREE_SHIPPING returns discountAmount of 0', async () => {
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({ type: PromotionType.FREE_SHIPPING, value: 0 }),
      );
      prisma.promotionUsage.count.mockResolvedValue(0);

      const result = await service.validateCoupon('FREESHIP', 100, CART_ITEMS);
      expect(result.discountAmount).toBe(0);
    });

    it('BUY_X_GET_Y calculates free item value', async () => {
      const items = [{ productId: 'prod-1', categoryId: 'cat-1', quantity: 3, unitPrice: 40 }];
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({
          type: PromotionType.BUY_X_GET_Y,
          value: 0,
          buyQuantity: 2,
          getQuantity: 1,
        }),
      );
      prisma.promotionUsage.count.mockResolvedValue(0);

      const result = await service.validateCoupon('BOGO', 120, items);
      // 3 items / 2 = 1 set → 1 free item × 40 = 40
      expect(result.discountAmount).toBeCloseTo(40);
    });

    it('BUY_X_GET_Y gives the Y item away free and never reads `value`', async () => {
      // The adjudicated contract, pinned so nobody "fixes" the engine into a
      // percentage without a decision. The schema documents "buy this many,
      // get this many free", the DTO calls `getQuantity` the number of items
      // given free, and the executed admin plan A relabelled these promotions
      // "Buy X, get Y free" across the admin on the strength of it.
      //
      // `value: 10` is the seed's dormant field, and it is set here on purpose:
      // the pre-existing test used `value: 0`, which cannot tell "value is
      // ignored" apart from "value happened to be zero".
      const items = [{ productId: 'prod-1', categoryId: 'cat-1', quantity: 2, unitPrice: 480 }];
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({
          type: PromotionType.BUY_X_GET_Y,
          value: 10,
          buyQuantity: 2,
          getQuantity: 1,
        }),
      );
      prisma.promotionUsage.count.mockResolvedValue(0);

      const result = await service.validateCoupon('BOGO', 960, items);
      // One whole unit free, not 10 per cent of one: 480, not 48.
      expect(result.discountAmount).toBeCloseTo(480);
      expect(result.discountAmount).not.toBeCloseTo(48);
    });

    it('VOLUME_DISCOUNT applies tier discount', async () => {
      const items = [{ productId: 'prod-1', categoryId: 'cat-1', quantity: 10, unitPrice: 20 }];
      prisma.promotion.findFirst.mockResolvedValue(
        makePromotion({
          type: PromotionType.VOLUME_DISCOUNT,
          value: 0,
          tierConfig: [{ minQty: 5, maxQty: null, discountPercent: 10 }],
        }),
      );
      prisma.promotionUsage.count.mockResolvedValue(0);
      prisma.promotion.findMany.mockResolvedValue([]);

      const result = await service.validateCoupon('VOL10', 200, items);
      // 10 × 20 × 10% = 20
      expect(result.discountAmount).toBeCloseTo(20);
    });

    // H-3: exclusive automatic promo blocks coupon stacking (§4.11)
    it('throws BadRequestException when an exclusive automatic promotion is active', async () => {
      prisma.promotion.findFirst.mockResolvedValue(makePromotion({ value: 10 }));
      prisma.promotionUsage.count.mockResolvedValue(0);
      prisma.promotion.findMany.mockResolvedValue([
        makePromotion({
          applicationMethod: PromotionApplicationMethod.AUTOMATIC,
          isExclusive: true,
          couponCode: null,
        }),
      ]);

      await expect(service.validateCoupon('SUMMER20', 100, CART_ITEMS)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── getApplicableAutomatic ─────────────────────────────────────────────────

  describe('getApplicableAutomatic', () => {
    it('returns empty array when no automatic promotions exist', async () => {
      prisma.promotion.findMany.mockResolvedValue([]);

      const result = await service.getApplicableAutomatic(100, CART_ITEMS);
      expect(result).toEqual([]);
    });

    it('returns all non-exclusive automatic promotions', async () => {
      prisma.promotion.findMany.mockResolvedValue([
        makePromotion({
          id: 'p1',
          applicationMethod: PromotionApplicationMethod.AUTOMATIC,
          value: 10,
          isExclusive: false,
          priority: 0,
        }),
        makePromotion({
          id: 'p2',
          applicationMethod: PromotionApplicationMethod.AUTOMATIC,
          value: 5,
          isExclusive: false,
          priority: 1,
        }),
      ]);

      const result = await service.getApplicableAutomatic(100, CART_ITEMS);
      expect(result).toHaveLength(2);
    });

    it('returns only the top-priority exclusive promotion when found', async () => {
      prisma.promotion.findMany.mockResolvedValue([
        makePromotion({
          id: 'exclusive-1',
          applicationMethod: PromotionApplicationMethod.AUTOMATIC,
          value: 30,
          isExclusive: true,
          priority: 0,
        }),
        makePromotion({
          id: 'normal-1',
          applicationMethod: PromotionApplicationMethod.AUTOMATIC,
          value: 10,
          isExclusive: false,
          priority: 1,
        }),
      ]);

      const result = await service.getApplicableAutomatic(100, CART_ITEMS);
      expect(result).toHaveLength(1);
      expect(result[0].promotionId).toBe('exclusive-1');
    });

    it('filters out promotions below minimumOrderAmount', async () => {
      prisma.promotion.findMany.mockResolvedValue([
        makePromotion({
          id: 'p1',
          applicationMethod: PromotionApplicationMethod.AUTOMATIC,
          value: 10,
          minimumOrderAmount: 500,
        }),
      ]);

      const result = await service.getApplicableAutomatic(100, CART_ITEMS);
      expect(result).toEqual([]);
    });

    it('filters out promotions with no eligible items in cart', async () => {
      prisma.promotion.findMany.mockResolvedValue([
        makePromotion({
          id: 'p1',
          applicationMethod: PromotionApplicationMethod.AUTOMATIC,
          value: 10,
          eligibleProducts: [{ productId: 'prod-UNRELATED' }],
          eligibleCategories: [],
        }),
      ]);

      const result = await service.getApplicableAutomatic(100, CART_ITEMS);
      expect(result).toEqual([]);
    });
  });

  // ── Admin CRUD ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates and returns the new promotion', async () => {
      const promo = makePromotion();
      prisma.promotion.create.mockResolvedValue(promo);

      const result = await service.create({
        name: { default: 'Summer Sale' },
        type: PromotionType.PERCENTAGE,
        applicationMethod: PromotionApplicationMethod.COUPON,
        couponCode: 'SUMMER20',
        value: 20,
      });

      expect(prisma.promotion.create).toHaveBeenCalled();
      expect(result).toEqual(promo);
    });
  });

  describe('create validation', () => {
    const base = {
      name: { default: 'Sale' },
      type: PromotionType.PERCENTAGE,
      applicationMethod: PromotionApplicationMethod.COUPON,
      couponCode: 'SALE10',
      value: 10,
    };

    it('refuses a percentage above 100', async () => {
      await expect(service.create({ ...base, value: 500 })).rejects.toMatchObject({
        response: { error: { code: 'PROMOTION_PERCENT_OUT_OF_RANGE' } },
      });
      expect(prisma.promotion.create).not.toHaveBeenCalled();
    });

    it('refuses an end date before the start date', async () => {
      await expect(
        service.create({
          ...base,
          startsAt: '2026-12-01T00:00:00.000Z',
          endsAt: '2026-11-01T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ response: { error: { code: 'PROMOTION_DATES_INVALID' } } });
      expect(prisma.promotion.create).not.toHaveBeenCalled();
    });

    it('stores the coupon code trimmed and upper-cased', async () => {
      prisma.promotion.create.mockResolvedValue(makePromotion());
      await service.create({ ...base, couponCode: '  summer20 ' });
      expect(prisma.promotion.create.mock.calls[0][0].data.couponCode).toBe('SUMMER20');
    });

    it('refuses a coupon code with inner spaces or symbols', async () => {
      await expect(service.create({ ...base, couponCode: 'SAVE 10!' })).rejects.toMatchObject({
        response: { error: { code: 'PROMOTION_COUPON_CODE_INVALID' } },
      });
    });
  });

  describe('update validation', () => {
    it('refuses a percentage above 100 on a percentage promotion', async () => {
      prisma.promotion.findUnique.mockResolvedValue(makePromotion());
      await expect(service.update('promo-1', { value: 500 })).rejects.toMatchObject({
        response: { error: { code: 'PROMOTION_PERCENT_OUT_OF_RANGE' } },
      });
      expect(prisma.promotion.update).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('throws NotFoundException when promotion does not exist', async () => {
      prisma.promotion.findUnique.mockResolvedValue(null);

      await expect(service.update('bad-id', { value: 30 })).rejects.toThrow(NotFoundException);
    });

    it('updates promotion fields when found', async () => {
      prisma.promotion.findUnique.mockResolvedValue(makePromotion());
      prisma.promotion.update.mockResolvedValue(makePromotion({ value: 30 }));

      const result = await service.update('promo-1', { value: 30 });

      expect(prisma.promotion.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'promo-1' } }),
      );
      expect(result).toMatchObject({ value: 30 });
    });
  });

  describe('deactivate', () => {
    it('throws NotFoundException when promotion does not exist', async () => {
      prisma.promotion.findUnique.mockResolvedValue(null);

      await expect(service.deactivate('bad-id')).rejects.toThrow(NotFoundException);
    });

    it('sets isActive=false and deletedAt when found', async () => {
      prisma.promotion.findUnique.mockResolvedValue(makePromotion());
      prisma.promotion.update.mockResolvedValue(makePromotion({ isActive: false }));

      await service.deactivate('promo-1');

      expect(prisma.promotion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'promo-1' },
          data: expect.objectContaining({ isActive: false }),
        }),
      );
    });
  });

  describe('list', () => {
    it('returns paginated promotions ordered by priority', async () => {
      prisma.promotion.findMany.mockResolvedValue([makePromotion()]);
      prisma.promotion.count.mockResolvedValue(1);

      const result = await service.list({ page: 1, pageSize: 20 });

      expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
      expect(result.data).toHaveLength(1);
      expect(prisma.promotion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { priority: 'asc' } }),
      );
    });

    it('filters by type when provided', async () => {
      prisma.promotion.findMany.mockResolvedValue([]);
      prisma.promotion.count.mockResolvedValue(0);

      await service.list({ type: PromotionType.PERCENTAGE });

      expect(prisma.promotion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ type: PromotionType.PERCENTAGE }),
        }),
      );
    });

    it('filters by applicationMethod when provided', async () => {
      prisma.promotion.findMany.mockResolvedValue([]);
      prisma.promotion.count.mockResolvedValue(0);

      await service.list({ applicationMethod: PromotionApplicationMethod.COUPON });

      expect(prisma.promotion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            applicationMethod: PromotionApplicationMethod.COUPON,
          }),
        }),
      );
    });
  });

  describe('releaseUsageForOrder', () => {
    it('deletes the usage rows of the order', async () => {
      prisma.promotionUsage.deleteMany.mockResolvedValue({ count: 1 });

      await service.releaseUsageForOrder('order-1');

      expect(prisma.promotionUsage.deleteMany).toHaveBeenCalledWith({
        where: { orderId: 'order-1' },
      });
    });
  });

  describe('recordUsage', () => {
    let txMock: Record<string, unknown>;

    beforeEach(() => {
      txMock = {
        $queryRaw: jest
          .fn()
          .mockResolvedValue([{ id: 'promo-1', usageLimit: null, usageLimitPerUser: null }]),
        promotionUsage: {
          create: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(0),
        },
      };
      prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(txMock));
    });

    it('locks the promotion row with SELECT FOR UPDATE inside a transaction', async () => {
      await service.recordUsage('promo-1', 'order-1', 20, 'user-1');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(txMock.$queryRaw).toHaveBeenCalled();
    });

    it('creates a PromotionUsage record inside the transaction', async () => {
      await service.recordUsage('promo-1', 'order-1', 20, 'user-1');

      expect((txMock.promotionUsage as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            promotionId: 'promo-1',
            orderId: 'order-1',
            discountAmount: 20,
            userId: 'user-1',
          }),
        }),
      );
    });

    it('throws when global usage limit is reached', async () => {
      (txMock.$queryRaw as jest.Mock).mockResolvedValue([
        { id: 'promo-1', usageLimit: 5, usageLimitPerUser: null },
      ]);
      (txMock.promotionUsage as Record<string, jest.Mock>).count.mockResolvedValue(5);

      await expect(service.recordUsage('promo-1', 'order-1', 20, 'user-1')).rejects.toThrow(
        'Promotion usage limit reached',
      );
    });

    it('throws when per-user limit is reached', async () => {
      (txMock.$queryRaw as jest.Mock).mockResolvedValue([
        { id: 'promo-1', usageLimit: null, usageLimitPerUser: 1 },
      ]);
      (txMock.promotionUsage as Record<string, jest.Mock>).count.mockResolvedValue(1);

      await expect(service.recordUsage('promo-1', 'order-1', 20, 'user-1')).rejects.toThrow(
        'Per-user promotion limit reached',
      );
    });
  });
});

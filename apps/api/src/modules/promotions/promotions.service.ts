// raw-sql-approved: pessimistic-lock promotion usage enforcement via SELECT
// FOR UPDATE per merchants-engine technical spec §9.4 C3 — see
// specs/decision-records/18-raw-sql-promotions-record-usage.md. Reviewed by
// db-safety-auditor on 2026-05-15.
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PromotionApplicationMethod, PromotionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { PaginatedResult } from '@common/interceptors/api-response.interceptor';
import type { CreatePromotionAdminDto } from './dto/create-promotion.dto';
import type { UpdatePromotionAdminDto } from './dto/update-promotion.dto';
import type { ListPromotionsAdminDto } from './dto/query-promotion.dto';
import type { CartItemDto } from './dto/validate-coupon.dto';
import { CouponInvalidException } from './coupon-invalid.exception';
import { PromotionInvalidException } from './promotion-invalid.exception';
import { MoneyFormatterService } from '../currencies/money-formatter.service';

// ── Public interface types ─────────────────────────────────────────────────────

export type ValidatedCoupon = {
  promotionId: string;
  code: string;
  type: PromotionType;
  discountAmount: number;
  label: unknown; // Translatable JSON
};

export type AppliedAutomatic = {
  promotionId: string;
  type: PromotionType;
  discountAmount: number;
  label: unknown; // Translatable JSON
  priority: number;
};

export type FreeShippingProgress = {
  threshold: number | null;
  remaining: number | null;
  qualified: boolean;
  message: unknown; // Translatable JSON
};

// ── Internal tier config shapes ────────────────────────────────────────────────

type VolumeTier = { minQty: number; maxQty: number | null; discountPercent: number };
type PriceTier = { minQty: number; maxQty: number | null; unitPrice: number };

// ── Internal Prisma include shape ──────────────────────────────────────────────

type PromotionWithEligibility = {
  id: string;
  name: unknown;
  type: PromotionType;
  applicationMethod: PromotionApplicationMethod;
  couponCode: string | null;
  value: { toNumber(): number } | number;
  minimumOrderAmount: { toNumber(): number } | number | null;
  maximumDiscount: { toNumber(): number } | number | null;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  isExclusive: boolean;
  priority: number;
  buyQuantity: number | null;
  getQuantity: number | null;
  tierConfig: unknown;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  deletedAt: Date | null;
  eligibleProducts: { productId: string }[];
  eligibleCategories: { categoryId: string }[];
};

const ELIGIBILITY_INCLUDE = {
  eligibleProducts: { select: { productId: true } },
  eligibleCategories: { select: { categoryId: true } },
} as const;

// ── Service ────────────────────────────────────────────────────────────────────

const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

/** Codes are stored and looked up as trimmed upper case, so the shopper's casing never matters. */
function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

function assertPromotionShape(p: {
  type: PromotionType;
  value: number;
  startsAt: Date | null;
  endsAt: Date | null;
  couponCode: string | null;
}): void {
  if (p.type === PromotionType.PERCENTAGE && p.value > 100) {
    throw new PromotionInvalidException('PROMOTION_PERCENT_OUT_OF_RANGE');
  }
  if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) {
    throw new PromotionInvalidException('PROMOTION_DATES_INVALID');
  }
  if (p.couponCode && !COUPON_CODE_PATTERN.test(p.couponCode)) {
    throw new PromotionInvalidException('PROMOTION_COUPON_CODE_INVALID');
  }
}

@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly money: MoneyFormatterService,
  ) {}

  // ── Public: Coupon validation ──────────────────────────────────────────────

  /**
   * Validates a coupon code against a cart.
   *
   * Checks (§4.11):
   *  1. Promotion exists with matching couponCode, isActive=true, not soft-deleted.
   *  2. Date range: startsAt <= now <= endsAt (if set).
   *  3. minimumOrderAmount <= cart subtotal.
   *  4. usageLimit: current usage count < limit.
   *  5. usageLimitPerUser: per-user count < limit (when userId is provided).
   *  6. Eligibility: at least one cart item matches eligible products/categories.
   *
   * Returns a generic "Invalid coupon" error on ANY failure — never leaks the reason.
   */
  async validateCoupon(
    code: string,
    subtotal: number,
    items: CartItemDto[],
    userId?: string,
  ): Promise<ValidatedCoupon> {
    const promo = await this.prisma.promotion.findFirst({
      where: { couponCode: normalizeCouponCode(code), isActive: true, deletedAt: null },
      include: ELIGIBILITY_INCLUDE,
    });

    if (!this.isCouponValid(promo as PromotionWithEligibility | null, subtotal, items)) {
      throw new CouponInvalidException();
    }

    const p = promo as PromotionWithEligibility;

    // Per-user limit check
    if (userId && p.usageLimitPerUser) {
      const userUsages = await this.prisma.promotionUsage.count({
        where: { promotionId: p.id, userId },
      });
      if (userUsages >= p.usageLimitPerUser) {
        throw new CouponInvalidException();
      }
    }

    // Global usage limit check (optimistic — atomic lock enforced at order placement)
    if (p.usageLimit) {
      const totalUsages = await this.prisma.promotionUsage.count({
        where: { promotionId: p.id },
      });
      if (totalUsages >= p.usageLimit) {
        throw new CouponInvalidException();
      }
    }

    // H-3: Block coupon if an exclusive automatic promotion is active for this cart (§4.11)
    const now = new Date();
    const exclusiveAutoPromos =
      (await this.prisma.promotion.findMany({
        where: {
          applicationMethod: PromotionApplicationMethod.AUTOMATIC,
          isExclusive: true,
          isActive: true,
          deletedAt: null,
          OR: [{ startsAt: null }, { startsAt: { lte: now } }],
          AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
        },
        include: ELIGIBILITY_INCLUDE,
      })) ?? [];

    for (const excl of exclusiveAutoPromos as PromotionWithEligibility[]) {
      if (
        (!excl.minimumOrderAmount || subtotal >= toNum(excl.minimumOrderAmount)) &&
        this.isEligible(excl, items)
      ) {
        throw new CouponInvalidException();
      }
    }

    const discountAmount = this.calculateDiscount(p, subtotal, items);

    this.logger.log(
      `validateCoupon: code=${code} promotionId=${p.id} discountAmount=${discountAmount}`,
    );

    return {
      promotionId: p.id,
      code: p.couponCode!,
      type: p.type,
      discountAmount,
      label: p.name,
    };
  }

  // ── Public: Automatic promotions ──────────────────────────────────────────

  /**
   * Finds all applicable automatic promotions for a cart and applies stacking rules (§4.11).
   *
   * Stacking rules:
   *  - If the highest-priority applicable promotion has isExclusive=true → return only it.
   *  - Otherwise → return all non-exclusive applicable promotions.
   */
  async getApplicableAutomatic(
    subtotal: number,
    items: CartItemDto[],
    userId?: string,
  ): Promise<AppliedAutomatic[]> {
    const now = new Date();

    const candidates = await this.prisma.promotion.findMany({
      where: {
        applicationMethod: PromotionApplicationMethod.AUTOMATIC,
        isActive: true,
        deletedAt: null,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
      orderBy: { priority: 'asc' },
      include: ELIGIBILITY_INCLUDE,
    });

    const applicable: AppliedAutomatic[] = [];

    for (const promo of candidates as PromotionWithEligibility[]) {
      // Minimum order check
      if (promo.minimumOrderAmount && subtotal < toNum(promo.minimumOrderAmount)) continue;

      // Eligibility check
      if (!this.isEligible(promo, items)) continue;

      // Per-user limit check
      if (userId && promo.usageLimitPerUser) {
        const count = await this.prisma.promotionUsage.count({
          where: { promotionId: promo.id, userId },
        });
        if (count >= promo.usageLimitPerUser) continue;
      }

      const discountAmount = this.calculateDiscount(promo, subtotal, items);

      applicable.push({
        promotionId: promo.id,
        type: promo.type,
        discountAmount,
        label: promo.name,
        priority: promo.priority,
      });
    }

    if (!applicable.length) return [];

    // Stacking rules: if highest-priority is exclusive, use only it
    const topPriority = applicable[0];
    if (
      topPriority &&
      (candidates as PromotionWithEligibility[]).find((p) => p.id === topPriority.promotionId)
        ?.isExclusive
    ) {
      return [topPriority];
    }

    // Remove any exclusive promos that are lower priority (they can't stack)
    return applicable.filter((a) => {
      const promo = (candidates as PromotionWithEligibility[]).find((p) => p.id === a.promotionId);
      return !promo?.isExclusive;
    });
  }

  // ── Public: Free shipping progress helper (§4.11) ─────────────────────────

  /**
   * Returns progress toward the free-shipping threshold from the highest-priority
   * active FREE_SHIPPING AUTOMATIC promotion.
   */
  async getFreeShippingProgress(subtotal: number): Promise<FreeShippingProgress> {
    const now = new Date();

    const promo = await this.prisma.promotion.findFirst({
      where: {
        type: PromotionType.FREE_SHIPPING,
        applicationMethod: PromotionApplicationMethod.AUTOMATIC,
        isActive: true,
        deletedAt: null,
        minimumOrderAmount: { not: null },
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
      orderBy: { priority: 'asc' },
    });

    if (!promo || promo.minimumOrderAmount === null) {
      return {
        threshold: null,
        remaining: null,
        qualified: false,
        message: {
          default: 'Free shipping not available',
          en: 'Free shipping not available',
          fr: 'Livraison offerte indisponible',
        },
      };
    }

    const threshold = toNum(promo.minimumOrderAmount);
    const qualified = subtotal >= threshold;
    const remaining = qualified ? 0 : threshold - subtotal;

    return {
      threshold,
      remaining,
      qualified,
      message: qualified
        ? {
            default: 'You qualify for free shipping!',
            en: 'You qualify for free shipping!',
            fr: 'Livraison offerte',
            ar: 'الشحن مجاني لطلبك',
          }
        : {
            default: `Add ${this.money.format(remaining)} more for free shipping!`,
            en: `Add ${this.money.format(remaining)} more for free shipping!`,
            fr: `Ajoutez ${this.money.format(remaining)} pour la livraison offerte`,
            ar: `أضف ${this.money.format(remaining)} للحصول على شحن مجاني`,
          },
    };
  }

  // ── Public: Record usage (called by Orders module at placement) ────────────

  /**
   * Records promotion usage with pessimistic locking (§9.4 C3).
   *
   * Acquires a row-level lock on the Promotion via SELECT ... FOR UPDATE,
   * then re-checks usage limits inside the same transaction before inserting.
   * This closes the race window between limit check and usage recording.
   *
   * Sanctioned $queryRaw: atomic promotion usage enforcement (§9.4 C3).
   */
  async recordUsage(
    promotionId: string,
    orderId: string,
    discountAmount: number,
    userId?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Lock the promotion row — prevents concurrent limit bypass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = await (tx as any).$queryRaw`
        SELECT "id", "usageLimit", "usageLimitPerUser"
        FROM "Promotion"
        WHERE "id" = ${promotionId}
        FOR UPDATE
      `;
      if (!rows.length) return; // Promotion deleted mid-checkout — skip gracefully

      const promo = rows[0];

      // Re-check global usage limit under lock
      if (promo.usageLimit !== null) {
        const count = await tx.promotionUsage.count({ where: { promotionId } });
        if (count >= promo.usageLimit) {
          throw new BadRequestException('Promotion usage limit reached');
        }
      }

      // Re-check per-user limit under lock
      if (userId && promo.usageLimitPerUser !== null) {
        const count = await tx.promotionUsage.count({ where: { promotionId, userId } });
        if (count >= promo.usageLimitPerUser) {
          throw new BadRequestException('Per-user promotion limit reached');
        }
      }

      await tx.promotionUsage.create({
        data: {
          promotionId,
          orderId,
          discountAmount,
          ...(userId && { userId }),
        },
      });
    });
  }

  /** Frees the usage an order consumed, for example when the order is cancelled. */
  async releaseUsageForOrder(orderId: string): Promise<void> {
    await this.prisma.promotionUsage.deleteMany({ where: { orderId } });
  }

  // ── Admin: Promotions CRUD ─────────────────────────────────────────────────

  async list(query: ListPromotionsAdminDto): Promise<PaginatedResult<unknown>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where = {
      deletedAt: null,
      ...(query.type !== undefined && { type: query.type }),
      ...(query.applicationMethod !== undefined && { applicationMethod: query.applicationMethod }),
      ...(query.isActive !== undefined && { isActive: query.isActive }),
    };

    const [data, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        orderBy: { priority: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: ELIGIBILITY_INCLUDE,
      }),
      this.prisma.promotion.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total } };
  }

  async findOne(id: string): Promise<unknown> {
    const promo = await this.prisma.promotion.findFirst({
      where: { id, deletedAt: null },
      include: ELIGIBILITY_INCLUDE,
    });
    if (!promo) throw new NotFoundException(`Promotion "${id}" not found`);
    return promo;
  }

  async create(dto: CreatePromotionAdminDto): Promise<unknown> {
    const { eligibleProductIds, eligibleCategoryIds, ...rest } = dto;
    const couponCode = rest.couponCode ? normalizeCouponCode(rest.couponCode) : null;
    assertPromotionShape({
      type: rest.type,
      value: rest.value,
      startsAt: rest.startsAt ? new Date(rest.startsAt) : null,
      endsAt: rest.endsAt ? new Date(rest.endsAt) : null,
      couponCode,
    });

    return this.prisma.promotion.create({
      data: {
        name: rest.name,
        description: rest.description ?? undefined,
        type: rest.type,
        applicationMethod: rest.applicationMethod,
        couponCode,
        value: rest.value,
        minimumOrderAmount: rest.minimumOrderAmount ?? null,
        maximumDiscount: rest.maximumDiscount ?? null,
        usageLimit: rest.usageLimit ?? null,
        usageLimitPerUser: rest.usageLimitPerUser ?? null,
        isExclusive: rest.isExclusive ?? false,
        priority: rest.priority ?? 0,
        buyQuantity: rest.buyQuantity ?? null,
        getQuantity: rest.getQuantity ?? null,
        tierConfig: rest.tierConfig ?? undefined,
        startsAt: rest.startsAt ? new Date(rest.startsAt) : null,
        endsAt: rest.endsAt ? new Date(rest.endsAt) : null,
        isActive: rest.isActive ?? true,
        eligibleProducts: eligibleProductIds?.length
          ? { create: eligibleProductIds.map((productId) => ({ productId })) }
          : undefined,
        eligibleCategories: eligibleCategoryIds?.length
          ? { create: eligibleCategoryIds.map((categoryId) => ({ categoryId })) }
          : undefined,
      },
      include: ELIGIBILITY_INCLUDE,
    });
  }

  async update(id: string, dto: UpdatePromotionAdminDto): Promise<unknown> {
    const current = await this.prisma.promotion.findUnique({
      where: { id },
      select: { id: true, type: true, value: true, startsAt: true, endsAt: true },
    });
    if (!current) throw new NotFoundException(`Promotion "${id}" not found`);

    const { eligibleProductIds, eligibleCategoryIds, ...rest } = dto;
    const couponCode =
      rest.couponCode === undefined || rest.couponCode === null
        ? rest.couponCode
        : normalizeCouponCode(rest.couponCode);
    assertPromotionShape({
      type: rest.type ?? current.type,
      value: rest.value ?? Number(current.value),
      startsAt: rest.startsAt ? new Date(rest.startsAt) : (current.startsAt ?? null),
      endsAt: rest.endsAt ? new Date(rest.endsAt) : (current.endsAt ?? null),
      couponCode: couponCode ?? null,
    });

    return this.prisma.promotion.update({
      where: { id },
      data: {
        ...(rest.name !== undefined && { name: rest.name }),
        ...(rest.description !== undefined && { description: rest.description }),
        ...(rest.type !== undefined && { type: rest.type }),
        ...(rest.applicationMethod !== undefined && { applicationMethod: rest.applicationMethod }),
        ...(couponCode !== undefined && { couponCode }),
        ...(rest.value !== undefined && { value: rest.value }),
        ...(rest.minimumOrderAmount !== undefined && {
          minimumOrderAmount: rest.minimumOrderAmount,
        }),
        ...(rest.maximumDiscount !== undefined && { maximumDiscount: rest.maximumDiscount }),
        ...(rest.usageLimit !== undefined && { usageLimit: rest.usageLimit }),
        ...(rest.usageLimitPerUser !== undefined && { usageLimitPerUser: rest.usageLimitPerUser }),
        ...(rest.isExclusive !== undefined && { isExclusive: rest.isExclusive }),
        ...(rest.priority !== undefined && { priority: rest.priority }),
        ...(rest.buyQuantity !== undefined && { buyQuantity: rest.buyQuantity }),
        ...(rest.getQuantity !== undefined && { getQuantity: rest.getQuantity }),
        ...(rest.tierConfig !== undefined && {
          tierConfig:
            rest.tierConfig === null ? Prisma.DbNull : (rest.tierConfig as Prisma.InputJsonValue),
        }),
        ...(rest.startsAt !== undefined && {
          startsAt: rest.startsAt ? new Date(rest.startsAt) : null,
        }),
        ...(rest.endsAt !== undefined && { endsAt: rest.endsAt ? new Date(rest.endsAt) : null }),
        ...(rest.isActive !== undefined && { isActive: rest.isActive }),
        // Replace eligibility join records when provided
        ...(eligibleProductIds !== undefined && {
          eligibleProducts: {
            deleteMany: {},
            create: eligibleProductIds.map((productId) => ({ productId })),
          },
        }),
        ...(eligibleCategoryIds !== undefined && {
          eligibleCategories: {
            deleteMany: {},
            create: eligibleCategoryIds.map((categoryId) => ({ categoryId })),
          },
        }),
      },
      include: ELIGIBILITY_INCLUDE,
    });
  }

  /** Soft-deactivates a promotion (does not hard-delete). */
  async deactivate(id: string): Promise<void> {
    await this.ensureExists(id);

    await this.prisma.promotion.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async ensureExists(id: string): Promise<void> {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!promo) throw new NotFoundException(`Promotion "${id}" not found`);
  }

  /**
   * Synchronous coupon validity pre-checks (no DB calls).
   * Returns false on ANY failure so the caller can throw a generic error.
   */
  private isCouponValid(
    promo: PromotionWithEligibility | null,
    subtotal: number,
    items: CartItemDto[],
  ): boolean {
    if (!promo) return false;
    if (!promo.isActive || promo.deletedAt) return false;

    const now = new Date();
    if (promo.startsAt && promo.startsAt > now) return false;
    if (promo.endsAt && promo.endsAt < now) return false;

    if (promo.minimumOrderAmount && subtotal < toNum(promo.minimumOrderAmount)) return false;

    return this.isEligible(promo, items);
  }

  /**
   * Returns true when at least one cart item is eligible for the promotion.
   * An empty eligibility list means the promotion applies to all products/categories.
   */
  private isEligible(
    promotion: Pick<PromotionWithEligibility, 'eligibleProducts' | 'eligibleCategories'>,
    items: CartItemDto[],
  ): boolean {
    if (!promotion.eligibleProducts.length && !promotion.eligibleCategories.length) {
      return true;
    }
    const productIds = new Set(promotion.eligibleProducts.map((p) => p.productId));
    const categoryIds = new Set(promotion.eligibleCategories.map((c) => c.categoryId));
    return items.some((item) => productIds.has(item.productId) || categoryIds.has(item.categoryId));
  }

  /**
   * Filters cart items down to those eligible for the promotion.
   * Returns all items when no eligibility restrictions are configured.
   */
  private filterEligibleItems(
    promotion: Pick<PromotionWithEligibility, 'eligibleProducts' | 'eligibleCategories'>,
    items: CartItemDto[],
  ): CartItemDto[] {
    if (!promotion.eligibleProducts.length && !promotion.eligibleCategories.length) {
      return items;
    }
    const productIds = new Set(promotion.eligibleProducts.map((p) => p.productId));
    const categoryIds = new Set(promotion.eligibleCategories.map((c) => c.categoryId));
    return items.filter(
      (item) => productIds.has(item.productId) || categoryIds.has(item.categoryId),
    );
  }

  /**
   * Calculates the discount amount for a promotion against a cart.
   *
   * Returns 0 for FREE_SHIPPING (signal only; shipping discount applied at checkout).
   */
  private calculateDiscount(
    promo: PromotionWithEligibility,
    subtotal: number,
    items: CartItemDto[],
  ): number {
    const eligible = this.filterEligibleItems(promo, items);
    const eligibleSubtotal =
      eligible.length > 0 ? eligible.reduce((s, i) => s + i.unitPrice * i.quantity, 0) : subtotal;

    const value = toNum(promo.value);
    const maxDiscount = promo.maximumDiscount ? toNum(promo.maximumDiscount) : null;

    switch (promo.type) {
      case PromotionType.PERCENTAGE: {
        const raw = eligibleSubtotal * (value / 100);
        return maxDiscount !== null ? Math.min(raw, maxDiscount) : raw;
      }

      case PromotionType.FIXED_AMOUNT: {
        const raw = Math.min(value, subtotal);
        return maxDiscount !== null ? Math.min(raw, maxDiscount) : raw;
      }

      case PromotionType.FREE_SHIPPING:
        return 0;

      case PromotionType.BUY_X_GET_Y: {
        if (!promo.buyQuantity || !promo.getQuantity) return 0;
        let discount = 0;
        for (const item of eligible) {
          const sets = Math.floor(item.quantity / promo.buyQuantity);
          discount += sets * promo.getQuantity * item.unitPrice;
        }
        return discount;
      }

      case PromotionType.VOLUME_DISCOUNT: {
        if (!promo.tierConfig) return 0;
        const tiers = promo.tierConfig as VolumeTier[];
        let discount = 0;
        for (const item of eligible) {
          const tier = tiers.find(
            (t) => item.quantity >= t.minQty && (t.maxQty === null || item.quantity <= t.maxQty),
          );
          if (tier) {
            discount += item.unitPrice * item.quantity * (tier.discountPercent / 100);
          }
        }
        return discount;
      }

      case PromotionType.TIERED_PRICE: {
        if (!promo.tierConfig) return 0;
        const tiers = promo.tierConfig as PriceTier[];
        let discount = 0;
        for (const item of eligible) {
          const tier = tiers.find(
            (t) => item.quantity >= t.minQty && (t.maxQty === null || item.quantity <= t.maxQty),
          );
          if (tier) {
            const saving = (item.unitPrice - tier.unitPrice) * item.quantity;
            if (saving > 0) discount += saving;
          }
        }
        return discount;
      }

      default:
        return 0;
    }
  }
}

/** Safely converts a Prisma Decimal or number to a JS number. */
function toNum(value: { toNumber(): number } | number): number {
  return typeof value === 'object' ? value.toNumber() : value;
}

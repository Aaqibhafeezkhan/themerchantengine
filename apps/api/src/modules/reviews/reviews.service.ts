import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, Prisma, QuestionStatus, ReviewStatus } from '@prisma/client';
import { storeLocales } from '@common/locale';
import { PrismaService } from '../../prisma/prisma.service';
import type { PaginatedResult } from '@common/interceptors/api-response.interceptor';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { UpdateReviewDto } from './dto/update-review.dto';
import type { AdminUpdateReviewDto } from './dto/admin-update-review.dto';
import type {
  ListReviewsStorefrontDto,
  ListReviewsAdminDto,
  ListQuestionsStorefrontDto,
  ListQuestionsAdminDto,
} from './dto/query-reviews.dto';
import type { ModerateReviewDto } from './dto/moderate-review.dto';
import type { CreateQuestionDto } from './dto/create-question.dto';
import type { AnswerQuestionDto } from './dto/answer-question.dto';
import type { AnswerQuestionAdminDto } from './dto/answer-question-admin.dto';
import { ReviewVerifiedPurchaseRequiredException } from './review-eligibility.exception';
import { ReviewDuplicateException } from './review-duplicate.exception';
import { ReviewAlreadyPublishedException } from './review-already-published.exception';
import { QuestionAlreadyPublishedException } from './question-already-published.exception';
import { QuestionNotAvailableForAnswerException } from './question-not-available.exception';
import { QuestionAlreadyAnsweredException } from './question-already-answered.exception';
import { ReviewProductNotFoundException } from './review-product-not-found.exception';
import { AssetInvalidException } from './asset-invalid.exception';
import { ReviewNotOwnedException } from './review-not-owned.exception';
import { ReviewNotFoundException } from './review-not-found.exception';
import { ReviewQuestionNotFoundException } from './review-question-not-found.exception';
import {
  HELPFUL_ENTITY_TYPE,
  REVIEW_EVENTS,
  QUESTION_EVENTS,
  VALID_REVIEW_SORT_FIELDS,
  VALID_QUESTION_SORT_FIELDS,
} from './reviews.constants';

// ── Prisma include shapes ────────────────────────────────────────────────────

// Per asset-variant-serving (AV1) `Asset.url` is now the canonical
// 'detail'-intent variant URL (large 1200 px webp). Reviews surfaces small
// thumbnails — storefront migrates to `publicVariantUrl(asset, 'thumbnail')`
// at AV4 once the storefront `<picture>` primitive lands. `variants` + `status`
// included here so the resolver works without a second round-trip.
const REVIEW_INCLUDE = {
  assets: {
    include: {
      asset: {
        select: {
          id: true,
          url: true,
          mimeType: true,
          status: true,
          variants: true,
        },
      },
    },
  },
  user: { select: { id: true, firstName: true, lastName: true } },
  product: { select: { id: true, slug: true } },
} as const;

const REVIEW_LIST_SELECT = {
  id: true,
  productId: true,
  userId: true,
  title: true,
  body: true,
  locale: true,
  rating: true,
  verifiedPurchase: true,
  helpfulCount: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, firstName: true, lastName: true } },
  assets: {
    include: {
      asset: {
        select: { id: true, url: true, status: true, variants: true },
      },
    },
  },
} as const;

const QUESTION_INCLUDE = {
  asker: { select: { id: true, firstName: true, lastName: true } },
  product: { select: { id: true, slug: true } },
} as const;

/**
 * The public and customer question shape (plan J, sweep S2).
 *
 * `QUESTION_INCLUDE` is relation-only, so it hands the whole `ProductQuestion`
 * row out — including `answeredBy`, the raw user id of the staff member who
 * answered (no FK, stored as a string), and `askedById`. Both ride the
 * `@Public()` list route. Account ids are internal identifiers; publishing them
 * enables targeting and correlation.
 *
 * `asker.id` is dropped for the same reason; the display name stays, which is
 * all the storefront types.
 *
 * The admin question methods deliberately keep `QUESTION_INCLUDE`: moderators
 * need to know who answered.
 */
export const QUESTION_PUBLIC_SELECT = {
  id: true,
  productId: true,
  question: true,
  questionLocale: true,
  answer: true,
  isAdminAnswer: true,
  helpfulCount: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  asker: { select: { firstName: true, lastName: true } },
  product: { select: { id: true, slug: true } },
} as const;

/** Why a customer may not review a product. `null` when they may. */
export type ReviewIneligibilityReason = 'VERIFIED_PURCHASE_REQUIRED' | 'ALREADY_REVIEWED';

export interface ReviewEligibility {
  eligible: boolean;
  reason: ReviewIneligibilityReason | null;
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // REVIEWS — STOREFRONT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Whether `userId` may write a review for the product behind `slug`.
   *
   * Extracted so the write path and the read-only eligibility endpoint decide
   * with the same query: a form gated on one rule and a server refusing on
   * another is how a customer ends up staring at a form that always 400s.
   *
   * `ALREADY_REVIEWED` is advisory only. The write path keeps relying on the
   * `[productId, userId]` unique constraint for the race, so two concurrent
   * submissions still collapse to one review.
   */
  async getReviewEligibility(slug: string, userId: string): Promise<ReviewEligibility> {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!product) throw new ReviewProductNotFoundException(slug);

    const [qualifyingOrder, existing] = await Promise.all([
      this.prisma.order.findFirst({
        where: {
          userId,
          // COMPLETED is the legal successor of DELIVERED in the admin state
          // machine (`orders.constants.ts`). Accepting only DELIVERED meant
          // closing an order revoked the customer's right to review what they
          // had already received.
          status: { in: [OrderStatus.DELIVERED, OrderStatus.COMPLETED] },
          items: { some: { productId: product.id } },
        },
        select: { id: true },
      }),
      this.prisma.review.findUnique({
        where: { productId_userId: { productId: product.id, userId } },
        select: { id: true },
      }),
    ]);

    if (!qualifyingOrder) return { eligible: false, reason: 'VERIFIED_PURCHASE_REQUIRED' };
    if (existing) return { eligible: false, reason: 'ALREADY_REVIEWED' };
    return { eligible: true, reason: null };
  }

  /**
   * The caller's own review for a product, in ANY status, or null.
   *
   * The public list is PUBLISHED-only, so a customer who submitted a review
   * lost sight of it on the next reload: they could not read, edit or delete
   * what they had written even though both write routes accepted the calls.
   */
  async getOwnReview(slug: string, userId: string): Promise<unknown> {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!product) throw new ReviewProductNotFoundException(slug);

    return await this.prisma.review.findUnique({
      where: { productId_userId: { productId: product.id, userId } },
      include: REVIEW_INCLUDE,
    });
  }

  async createReview(
    slug: string,
    dto: CreateReviewDto,
    userId: string,
    locale: string | null = null,
  ): Promise<unknown> {
    // ── 1. Resolve product ────────────────────────────────────────────────
    const product = await this.prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!product) throw new ReviewProductNotFoundException(slug);

    // ── 2. Eligibility, shared with GET .../reviews/eligibility ───────────
    const eligibility = await this.getReviewEligibility(slug, userId);
    if (!eligibility.eligible) {
      if (eligibility.reason === 'ALREADY_REVIEWED') throw new ReviewDuplicateException();
      throw new ReviewVerifiedPurchaseRequiredException();
    }

    // ── 3. Validate asset IDs exist ───────────────────────────────────────
    if (dto.assetIds?.length) {
      const found = await this.prisma.asset.count({
        where: { id: { in: dto.assetIds } },
      });
      if (found !== dto.assetIds.length) {
        throw new AssetInvalidException();
      }
    }

    // ── 4. Persist submission locale so admin moderators see which language
    //       the body was written in. Drops 'default' (no header) to null so a
    //       missing header does not lie about a real locale.
    const persistedLocale = locale && locale !== 'default' ? locale : null;
    const wrapKey = persistedLocale ?? storeLocales.current().defaultLocale;

    // ── 5. Create (unique constraint [productId, userId] enforces one review per user per product) ─
    let review: unknown;
    try {
      review = await this.prisma.review.create({
        data: {
          product: { connect: { id: product.id } },
          user: { connect: { id: userId } },
          title: dto.title ? { default: dto.title, [wrapKey]: dto.title } : Prisma.DbNull,
          body: { default: dto.body, [wrapKey]: dto.body },
          rating: dto.rating,
          locale: persistedLocale,
          verifiedPurchase: true,
          assets: dto.assetIds?.length
            ? { create: dto.assetIds.map((assetId) => ({ asset: { connect: { id: assetId } } })) }
            : undefined,
        },
        include: REVIEW_INCLUDE,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ReviewDuplicateException();
      }
      throw err;
    }

    this.events.emit(REVIEW_EVENTS.CREATED, { productId: product.id, userId });
    this.logger.log(`createReview: productSlug=${slug} userId=${userId}`);
    return review;
  }

  async listReviews(
    slug: string,
    query: ListReviewsStorefrontDto,
  ): Promise<PaginatedResult<unknown>> {
    const product = await this.resolveProductBySlug(slug);

    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const sortBy = (VALID_REVIEW_SORT_FIELDS as readonly string[]).includes(query.sortBy ?? '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const where: Prisma.ReviewWhereInput = {
      productId: product.id,
      status: ReviewStatus.PUBLISHED,
    };
    if (query.rating) where.rating = query.rating;

    const [data, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        select: REVIEW_LIST_SELECT,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.review.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total } };
  }

  async getReviewSummary(slug: string): Promise<unknown> {
    const product = await this.resolveProductBySlug(slug);

    const where: Prisma.ReviewWhereInput = {
      productId: product.id,
      status: ReviewStatus.PUBLISHED,
    };

    const [totalReviews, ratingGroups, withPhotos, verifiedCount] = await Promise.all([
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({
        by: ['rating'],
        _count: { id: true },
        where,
      }),
      this.prisma.review.count({
        where: { ...where, assets: { some: {} } },
      }),
      this.prisma.review.count({ where: { ...where, verifiedPurchase: true } }),
    ]);

    const histogram: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let ratingSum = 0;
    for (const group of ratingGroups) {
      histogram[group.rating] = group._count.id;
      ratingSum += group.rating * group._count.id;
    }

    const averageRating = totalReviews > 0 ? Number((ratingSum / totalReviews).toFixed(2)) : 0;

    // `total` + `histogram` is the documented contract
    // (`docs/storefront-api-reference.md`), the one the storefront schema
    // parses and the SSR loader casts to. The old `totalReviews` +
    // `distribution` names arrived as undefined on every consumer, which
    // zeroed the histogram and threw the client-side refetch away.
    return {
      averageRating,
      total: totalReviews,
      histogram,
      withPhotos,
      verifiedPurchases: verifiedCount,
    };
  }

  async updateReview(
    reviewId: string,
    dto: UpdateReviewDto,
    userId: string,
    locale: string | null = null,
  ): Promise<unknown> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, userId: true, locale: true },
    });
    if (!review) throw new ReviewNotFoundException(reviewId);
    if (review.userId !== userId) throw new ReviewNotOwnedException();

    // ── Validate new asset IDs ────────────────────────────────────────────
    if (dto.assetIds?.length) {
      const found = await this.prisma.asset.count({
        where: { id: { in: dto.assetIds } },
      });
      if (found !== dto.assetIds.length) {
        throw new AssetInvalidException();
      }
    }

    // Wrap edited text using the request locale (or the row's stored locale as
    // fallback) so Translatable storage stays consistent with the original
    // submission locale provenance.
    const wrapKey =
      (locale && locale !== 'default' ? locale : null) ??
      review.locale ??
      storeLocales.current().defaultLocale;

    const updateData: Prisma.ReviewUpdateInput = {
      // Reset to PENDING on edit so moderation re-runs
      status: ReviewStatus.PENDING,
    };
    if (dto.rating !== undefined) updateData.rating = dto.rating;
    if (dto.title !== undefined) {
      updateData.title =
        dto.title === null ? Prisma.DbNull : { default: dto.title, [wrapKey]: dto.title };
    }
    if (dto.body !== undefined) {
      updateData.body = { default: dto.body, [wrapKey]: dto.body };
    }

    if (dto.assetIds !== undefined) {
      // Replace all assets: delete existing, create new
      updateData.assets = {
        deleteMany: {},
        create: dto.assetIds.map((assetId) => ({ assetId })),
      };
    }

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: updateData,
      include: REVIEW_INCLUDE,
    });

    return updated;
  }

  async deleteReview(reviewId: string, userId: string): Promise<void> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, userId: true, productId: true },
    });
    if (!review) throw new ReviewNotFoundException(reviewId);
    if (review.userId !== userId) throw new ReviewNotOwnedException();

    await this.prisma.review.delete({ where: { id: reviewId } });

    this.events.emit(REVIEW_EVENTS.DELETED, { reviewId, productId: review.productId, userId });
  }

  async toggleHelpfulReview(reviewId: string, userId: string): Promise<{ helpful: boolean }> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true },
    });
    if (!review) throw new ReviewNotFoundException(reviewId);

    return this.toggleHelpfulVote(HELPFUL_ENTITY_TYPE.REVIEW, reviewId, userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REVIEWS — ADMIN
  // ═══════════════════════════════════════════════════════════════════════════

  async listReviewsAdmin(query: ListReviewsAdminDto): Promise<PaginatedResult<unknown>> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const sortBy = (VALID_REVIEW_SORT_FIELDS as readonly string[]).includes(query.sortBy ?? '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const where: Prisma.ReviewWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.productId) where.productId = query.productId;
    if (query.userId) where.userId = query.userId;
    if (query.rating) where.rating = query.rating;

    const [data, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: REVIEW_INCLUDE,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.review.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total } };
  }

  async approveReview(reviewId: string, performedBy: string): Promise<unknown> {
    const review = await this.loadReview(reviewId);
    if (review.status === ReviewStatus.PUBLISHED) throw new ReviewAlreadyPublishedException();

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: { status: ReviewStatus.PUBLISHED },
      include: REVIEW_INCLUDE,
    });

    await this.auditLog(performedBy, 'review.approved', reviewId, {
      from: review.status,
      to: ReviewStatus.PUBLISHED,
    });

    this.events.emit(REVIEW_EVENTS.APPROVED, { reviewId, productId: review.productId });
    return updated;
  }

  async rejectReview(
    reviewId: string,
    dto: ModerateReviewDto,
    performedBy: string,
  ): Promise<unknown> {
    const review = await this.loadReview(reviewId);

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: { status: ReviewStatus.HIDDEN },
      include: REVIEW_INCLUDE,
    });

    await this.auditLog(performedBy, 'review.rejected', reviewId, {
      from: review.status,
      to: ReviewStatus.HIDDEN,
      reason: dto.reason,
    });

    this.events.emit(REVIEW_EVENTS.REJECTED, { reviewId, productId: review.productId });
    return updated;
  }

  // ── Admin: edit review content (rating / title / body / status) ─────────────
  // Admin-side edits do NOT re-pend the row. Operators may set status explicitly
  // through the same call (e.g. fix typos and publish in one shot).
  async adminUpdateReview(
    reviewId: string,
    dto: AdminUpdateReviewDto,
    performedBy: string,
    locale: string | null = null,
  ): Promise<unknown> {
    const review = await this.loadReview(reviewId);

    if (dto.assetIds?.length) {
      const found = await this.prisma.asset.count({
        where: { id: { in: dto.assetIds } },
      });
      if (found !== dto.assetIds.length) {
        throw new AssetInvalidException();
      }
    }

    // Admin edits wrap the new string into the request locale (or the row's
    // original locale as fallback). Future feature: full-Translatable editor
    // with per-locale fields, tracked in the post-E5 backlog.
    const wrapKey =
      (locale && locale !== 'default' ? locale : null) ??
      review.locale ??
      storeLocales.current().defaultLocale;

    const data: Prisma.ReviewUpdateInput = {};
    if (dto.rating !== undefined) data.rating = dto.rating;
    if (dto.title !== undefined) {
      data.title =
        dto.title === null ? Prisma.DbNull : { default: dto.title, [wrapKey]: dto.title };
    }
    if (dto.body !== undefined) {
      data.body = { default: dto.body, [wrapKey]: dto.body };
    }
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.assetIds !== undefined) {
      data.assets = {
        deleteMany: {},
        create: dto.assetIds.map((assetId) => ({ assetId })),
      };
    }

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data,
      include: REVIEW_INCLUDE,
    });

    await this.auditLog(performedBy, 'review.updated', reviewId, {
      changedFields: Object.keys(data),
      from: review.status,
      to: dto.status ?? review.status,
      reason: dto.reason,
    });

    return updated;
  }

  // ── Admin: hard delete a review ─────────────────────────────────────────────
  async adminDeleteReview(reviewId: string, performedBy: string): Promise<void> {
    const review = await this.loadReview(reviewId);

    await this.prisma.review.delete({ where: { id: reviewId } });

    await this.auditLog(performedBy, 'review.deleted', reviewId, {
      productId: review.productId,
      userId: review.userId,
      previousStatus: review.status,
    });

    this.events.emit(REVIEW_EVENTS.DELETED, {
      reviewId,
      productId: review.productId,
      userId: review.userId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUESTIONS — STOREFRONT
  // ═══════════════════════════════════════════════════════════════════════════

  async createQuestion(
    slug: string,
    dto: CreateQuestionDto,
    userId: string,
    locale: string | null = null,
  ): Promise<unknown> {
    const product = await this.resolveProductBySlug(slug);

    const persistedLocale = locale && locale !== 'default' ? locale : null;
    const wrapKey = persistedLocale ?? storeLocales.current().defaultLocale;

    const question = await this.prisma.productQuestion.create({
      data: {
        productId: product.id,
        askedById: userId,
        question: { default: dto.question, [wrapKey]: dto.question },
        questionLocale: persistedLocale,
      },
      select: QUESTION_PUBLIC_SELECT,
    });

    this.events.emit(QUESTION_EVENTS.CREATED, {
      questionId: question.id,
      productId: product.id,
      userId,
    });
    this.logger.log(`createQuestion: productSlug=${slug} userId=${userId}`);
    return question;
  }

  async listQuestions(
    slug: string,
    query: ListQuestionsStorefrontDto,
  ): Promise<PaginatedResult<unknown>> {
    const product = await this.resolveProductBySlug(slug);

    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);

    const where: Prisma.ProductQuestionWhereInput = {
      productId: product.id,
      status: QuestionStatus.PUBLISHED,
    };

    const [data, total] = await Promise.all([
      this.prisma.productQuestion.findMany({
        where,
        select: QUESTION_PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.productQuestion.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total } };
  }

  async answerQuestion(
    questionId: string,
    dto: AnswerQuestionDto,
    userId: string,
    locale: string | null = null,
  ): Promise<unknown> {
    const question = await this.prisma.productQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, status: true, productId: true, questionLocale: true, answer: true },
    });
    if (!question) throw new ReviewQuestionNotFoundException(questionId);
    if (question.status === QuestionStatus.HIDDEN) {
      throw new QuestionNotAvailableForAnswerException();
    }
    // First answer wins. This column holds one answer, so without the guard a
    // customer could erase the store's official reply through the public
    // route. Moderators still overwrite through the admin route.
    if (question.answer !== null && question.answer !== undefined) {
      throw new QuestionAlreadyAnsweredException();
    }

    // Wrap the answer into the request locale (or fall back to the question's
    // original locale, then 'en' as the canonical default).
    const wrapKey =
      (locale && locale !== 'default' ? locale : null) ??
      question.questionLocale ??
      storeLocales.current().defaultLocale;

    // Storefront callers may never set the admin marker; literal false defends
    // against hand-crafted payloads bypassing the validation layer.
    const updated = await this.prisma.productQuestion.update({
      where: { id: questionId },
      data: {
        answer: { default: dto.answer, [wrapKey]: dto.answer },
        answeredBy: userId,
        isAdminAnswer: false,
      },
      select: QUESTION_PUBLIC_SELECT,
    });

    this.events.emit(QUESTION_EVENTS.ANSWERED, {
      questionId,
      productId: question.productId,
      userId,
    });
    return updated;
  }

  async answerQuestionAdmin(
    questionId: string,
    dto: AnswerQuestionAdminDto,
    userId: string,
    locale: string | null = null,
  ): Promise<unknown> {
    const question = await this.prisma.productQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, status: true, productId: true, questionLocale: true },
    });
    if (!question) throw new ReviewQuestionNotFoundException(questionId);
    if (question.status === QuestionStatus.HIDDEN) {
      throw new QuestionNotAvailableForAnswerException();
    }

    const isAdminAnswer = dto.isAdminAnswer ?? true;

    // Admin answers wrap into the request locale (or fall back to the
    // question's original locale, then 'en').
    const wrapKey =
      (locale && locale !== 'default' ? locale : null) ??
      question.questionLocale ??
      storeLocales.current().defaultLocale;

    const updated = await this.prisma.productQuestion.update({
      where: { id: questionId },
      data: {
        answer: { default: dto.answer, [wrapKey]: dto.answer },
        answeredBy: userId,
        isAdminAnswer,
      },
      include: QUESTION_INCLUDE,
    });

    await this.auditLog(userId, 'question.answered', questionId, { isAdminAnswer });

    this.events.emit(QUESTION_EVENTS.ANSWERED, {
      questionId,
      productId: question.productId,
      userId,
    });
    return updated;
  }

  async toggleHelpfulQuestion(questionId: string, userId: string): Promise<{ helpful: boolean }> {
    const question = await this.prisma.productQuestion.findUnique({
      where: { id: questionId },
      select: { id: true },
    });
    if (!question) throw new ReviewQuestionNotFoundException(questionId);

    return this.toggleHelpfulVote(HELPFUL_ENTITY_TYPE.QUESTION, questionId, userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUESTIONS — ADMIN
  // ═══════════════════════════════════════════════════════════════════════════

  async listQuestionsAdmin(query: ListQuestionsAdminDto): Promise<PaginatedResult<unknown>> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const sortBy = (VALID_QUESTION_SORT_FIELDS as readonly string[]).includes(query.sortBy ?? '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const where: Prisma.ProductQuestionWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.productId) where.productId = query.productId;
    if (query.search) {
      // Search across both the `default` key and the per-locale keys via Prisma
      // JSONB string_contains (case-insensitive substring match on each key).
      where.OR = ['default', ...storeLocales.current().supportedLocales].map((key) => ({
        question: { path: [key], string_contains: query.search },
      }));
    }

    const [data, total] = await Promise.all([
      this.prisma.productQuestion.findMany({
        where,
        include: QUESTION_INCLUDE,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.productQuestion.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total } };
  }

  async approveQuestion(questionId: string, performedBy: string): Promise<unknown> {
    const question = await this.loadQuestion(questionId);
    if (question.status === QuestionStatus.PUBLISHED) throw new QuestionAlreadyPublishedException();

    const updated = await this.prisma.productQuestion.update({
      where: { id: questionId },
      data: { status: QuestionStatus.PUBLISHED },
      include: QUESTION_INCLUDE,
    });

    await this.auditLog(performedBy, 'question.approved', questionId, {
      from: question.status,
      to: QuestionStatus.PUBLISHED,
    });

    this.events.emit(QUESTION_EVENTS.APPROVED, { questionId, productId: question.productId });
    return updated;
  }

  async rejectQuestion(
    questionId: string,
    dto: ModerateReviewDto,
    performedBy: string,
  ): Promise<unknown> {
    const question = await this.loadQuestion(questionId);

    const updated = await this.prisma.productQuestion.update({
      where: { id: questionId },
      data: { status: QuestionStatus.HIDDEN },
      include: QUESTION_INCLUDE,
    });

    await this.auditLog(performedBy, 'question.rejected', questionId, {
      from: question.status,
      to: QuestionStatus.HIDDEN,
      reason: dto.reason,
    });

    this.events.emit(QUESTION_EVENTS.REJECTED, { questionId, productId: question.productId });
    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEO — AggregateRating markup (§4.10)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns schema.org AggregateRating data for use by the SEO module.
   * Called externally — productId is accepted directly.
   */
  async getAggregateRating(productId: string): Promise<{
    ratingValue: number;
    reviewCount: number;
  } | null> {
    const where: Prisma.ReviewWhereInput = {
      productId,
      status: ReviewStatus.PUBLISHED,
    };

    const [count, groups] = await Promise.all([
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({ by: ['rating'], _count: { id: true }, where }),
    ]);

    if (count === 0) return null;

    const ratingSum = groups.reduce((sum, g) => sum + g.rating * g._count.id, 0);
    return {
      ratingValue: Number((ratingSum / count).toFixed(2)),
      reviewCount: count,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Toggles a helpful vote for a review or question.
   * Atomically increments / decrements the materialized helpfulCount (§9.1 S4).
   */
  private async toggleHelpfulVote(
    entityType: string,
    entityId: string,
    userId: string,
  ): Promise<{ helpful: boolean }> {
    const existing = await this.prisma.helpfulVote.findUnique({
      where: { userId_entityType_entityId: { userId, entityType, entityId } },
      select: { id: true },
    });

    if (existing) {
      // Remove vote — decrement count atomically
      await this.prisma.$transaction(async (tx) => {
        await tx.helpfulVote.delete({ where: { id: existing.id } });
        if (entityType === HELPFUL_ENTITY_TYPE.REVIEW) {
          await tx.review.update({
            where: { id: entityId },
            data: { helpfulCount: { decrement: 1 } },
          });
        } else {
          await tx.productQuestion.update({
            where: { id: entityId },
            data: { helpfulCount: { decrement: 1 } },
          });
        }
      });
      return { helpful: false };
    }

    // Add vote — increment count atomically
    await this.prisma.$transaction(async (tx) => {
      await tx.helpfulVote.create({ data: { userId, entityType, entityId } });
      if (entityType === HELPFUL_ENTITY_TYPE.REVIEW) {
        await tx.review.update({
          where: { id: entityId },
          data: { helpfulCount: { increment: 1 } },
        });
      } else {
        await tx.productQuestion.update({
          where: { id: entityId },
          data: { helpfulCount: { increment: 1 } },
        });
      }
    });
    return { helpful: true };
  }

  private async resolveProductBySlug(slug: string): Promise<{ id: string }> {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!product) throw new ReviewProductNotFoundException(slug);
    return product;
  }

  private async loadReview(reviewId: string) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, status: true, productId: true, userId: true, locale: true },
    });
    if (!review) throw new ReviewNotFoundException(reviewId);
    return review;
  }

  private async loadQuestion(questionId: string) {
    const question = await this.prisma.productQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, status: true, productId: true },
    });
    if (!question) throw new ReviewQuestionNotFoundException(questionId);
    return question;
  }

  private async auditLog(
    userId: string,
    action: string,
    entityId: string,
    changes: unknown,
  ): Promise<void> {
    try {
      await this.prisma.auditLogEntry.create({
        data: {
          userId,
          action,
          entityType: 'Review',
          entityId,
          changes: changes as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(`Audit log failed: ${(err as Error).message}`);
    }
  }

  // ── Asset references (S18 — DR-07) ────────────────────────────────────────
  /**
   * Returns reviews that have the given asset attached. Used by
   * `AssetsService.getReferences()` to support the DR-07 hard-delete guard.
   * Modular-isolation gate per constitution §3.1.
   */
  async findByAssetId(
    assetId: string,
  ): Promise<Array<{ id: string; productSlug: string; customerName: string }>> {
    const rows = await this.prisma.review.findMany({
      where: { assets: { some: { assetId } } },
      select: {
        id: true,
        product: { select: { slug: true } },
        user: { select: { firstName: true, lastName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      productSlug: r.product?.slug ?? '',
      customerName: [r.user?.firstName, r.user?.lastName].filter(Boolean).join(' ').trim(),
    }));
  }
}

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, QuestionStatus, ReviewStatus } from '@prisma/client';
import { NEUTRAL_LOCALE_SET, storeLocales } from '@common/locale';
import { PrismaService } from '../../prisma/prisma.service';
import { ReviewsService } from './reviews.service';
import { REVIEW_EVENTS, QUESTION_EVENTS } from './reviews.constants';
import { ReviewAlreadyPublishedException } from './review-already-published.exception';
import { QuestionAlreadyPublishedException } from './question-already-published.exception';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeProduct(overrides: Record<string, unknown> = {}) {
  return { id: 'product-1', slug: 'widget-pro', ...overrides };
}

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-1',
    productId: 'product-1',
    userId: 'user-1',
    title: 'Great product',
    body: 'Really loved it',
    locale: null,
    rating: 5,
    verifiedPurchase: true,
    helpfulCount: 0,
    status: ReviewStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    assets: [],
    user: { id: 'user-1', firstName: 'Jane', lastName: 'Doe' },
    product: { id: 'product-1', slug: 'widget-pro' },
    ...overrides,
  };
}

function makeQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'question-1',
    productId: 'product-1',
    question: 'Does it come in blue?',
    questionLocale: null,
    askedById: 'user-1',
    answer: null,
    answeredBy: null,
    isAdminAnswer: false,
    helpfulCount: 0,
    status: QuestionStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    asker: { id: 'user-1', firstName: 'Jane', lastName: 'Doe' },
    product: { id: 'product-1', slug: 'widget-pro' },
    ...overrides,
  };
}

function makeHelpfulVote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vote-1',
    userId: 'user-1',
    entityType: 'review',
    entityId: 'review-1',
    createdAt: new Date(),
    ...overrides,
  };
}

function makePrisma() {
  return {
    product: { findUnique: jest.fn() },
    order: { findFirst: jest.fn() },
    asset: { count: jest.fn() },
    review: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    productQuestion: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    helpfulVote: {
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    auditLogEntry: { create: jest.fn() },
    $transaction: jest.fn(),
  };
}

function makeEvents() {
  return { emit: jest.fn() };
}

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe('ReviewsService', () => {
  // The locale a body is wrapped under when the request states none is the
  // store default (DR-31). These fixtures were written for an English one.
  beforeAll(() =>
    storeLocales.set({
      supportedLocales: ['fr', 'en'],
      defaultLocale: 'en',
      rtlLocales: [],
      timezone: 'UTC',
    }),
  );
  afterAll(() => storeLocales.set(NEUTRAL_LOCALE_SET));

  let service: ReviewsService;
  let prisma: ReturnType<typeof makePrisma>;
  let events: ReturnType<typeof makeEvents>;

  beforeEach(async () => {
    prisma = makePrisma();
    events = makeEvents();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // createReview
  // ═════════════════════════════════════════════════════════════════════════

  describe('createReview', () => {
    const dto = { rating: 5, body: 'Excellent', assetIds: [] };

    it('creates a review for a verified purchase', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1' });
      prisma.asset.count.mockResolvedValue(0);
      prisma.review.create.mockResolvedValue(makeReview());

      const result = await service.createReview('widget-pro', dto, 'user-1');

      expect(prisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rating: 5,
            body: { default: 'Excellent', en: 'Excellent' },
            verifiedPurchase: true,
          }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(REVIEW_EVENTS.CREATED, expect.any(Object));
      expect(result).toBeDefined();
    });

    it('throws REVIEW_PRODUCT_NOT_FOUND when product does not exist', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(service.createReview('no-product', dto, 'user-1')).rejects.toMatchObject({
        response: { error: { code: 'REVIEW_PRODUCT_NOT_FOUND' } },
      });
    });

    it('throws BadRequestException when no verified purchase', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(service.createReview('widget-pro', dto, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws ConflictException on duplicate review (P2002)', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1' });
      prisma.asset.count.mockResolvedValue(0);

      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '7.0.0',
        meta: {},
      });
      prisma.review.create.mockRejectedValue(p2002);

      await expect(service.createReview('widget-pro', dto, 'user-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ASSET_INVALID when asset IDs do not resolve', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1' });
      prisma.asset.count.mockResolvedValue(0); // only 0 of 1 found

      await expect(
        service.createReview('widget-pro', { ...dto, assetIds: ['bad-uuid'] }, 'user-1'),
      ).rejects.toMatchObject({
        response: { error: { code: 'ASSET_INVALID' } },
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // listReviews
  // ═════════════════════════════════════════════════════════════════════════

  describe('listReviews', () => {
    it('returns paginated published reviews', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.review.findMany.mockResolvedValue([makeReview({ status: ReviewStatus.PUBLISHED })]);
      prisma.review.count.mockResolvedValue(1);

      const result = await service.listReviews('widget-pro', { page: 1, pageSize: 20 });

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: ReviewStatus.PUBLISHED }),
        }),
      );
      expect(result).toEqual({
        data: expect.any(Array),
        meta: { page: 1, pageSize: 20, total: 1 },
      });
    });

    it('throws REVIEW_PRODUCT_NOT_FOUND for unknown product', async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.listReviews('no-product', {})).rejects.toMatchObject({
        response: { error: { code: 'REVIEW_PRODUCT_NOT_FOUND' } },
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // getReviewSummary
  // ═════════════════════════════════════════════════════════════════════════

  describe('getReviewSummary', () => {
    it('returns aggregated summary with the documented total and histogram keys', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.review.count
        .mockResolvedValueOnce(3) // total
        .mockResolvedValueOnce(2) // withPhotos
        .mockResolvedValueOnce(3); // verified
      prisma.review.groupBy.mockResolvedValue([
        { rating: 5, _count: { id: 2 } },
        { rating: 4, _count: { id: 1 } },
      ]);

      const result = (await service.getReviewSummary('widget-pro')) as Record<string, unknown>;

      // The storefront schema, `docs/storefront-api-reference.md` and the SSR
      // loader all read `total` + `histogram`; the service used to emit
      // `totalReviews` + `distribution`, which parsed as undefined downstream.
      expect(result.total).toBe(3);
      expect(result).not.toHaveProperty('totalReviews');
      expect(result).not.toHaveProperty('distribution');
      expect(result.averageRating).toBeCloseTo(4.67, 1);
      expect((result.histogram as Record<number, number>)[5]).toBe(2);
      expect((result.histogram as Record<number, number>)[4]).toBe(1);
      expect((result.histogram as Record<number, number>)[3]).toBe(0);
    });

    it('returns zero averageRating when no reviews', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.review.count.mockResolvedValue(0);
      prisma.review.groupBy.mockResolvedValue([]);

      const result = (await service.getReviewSummary('widget-pro')) as Record<string, unknown>;
      expect(result.averageRating).toBe(0);
      expect(result.total).toBe(0);
      expect((result.histogram as Record<number, number>)[5]).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // getOwnReview
  // ═════════════════════════════════════════════════════════════════════════

  describe('getOwnReview', () => {
    it('returns the caller review whatever its status', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.review.findUnique.mockResolvedValue(makeReview({ status: ReviewStatus.PENDING }));

      const result = await service.getOwnReview('widget-pro', 'user-1');

      expect(prisma.review.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { productId_userId: { productId: 'product-1', userId: 'user-1' } },
        }),
      );
      expect((result as { id: string } | null)?.id).toBe('review-1');
    });

    it('returns null when the caller has no review on the product', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(service.getOwnReview('widget-pro', 'user-1')).resolves.toBeNull();
    });

    it('throws when the product does not exist', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(service.getOwnReview('ghost', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // review eligibility (shared by createReview and the eligibility endpoint)
  // ═════════════════════════════════════════════════════════════════════════

  describe('getReviewEligibility', () => {
    it('is eligible when a qualifying order exists and no review was written', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1' });
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(service.getReviewEligibility('widget-pro', 'user-1')).resolves.toEqual({
        eligible: true,
        reason: null,
      });
    });

    it('reports VERIFIED_PURCHASE_REQUIRED with no qualifying order', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue(null);
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(service.getReviewEligibility('widget-pro', 'user-1')).resolves.toEqual({
        eligible: false,
        reason: 'VERIFIED_PURCHASE_REQUIRED',
      });
    });

    it('accepts a COMPLETED order, not only a DELIVERED one', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1' });
      prisma.review.findUnique.mockResolvedValue(null);

      await service.getReviewEligibility('widget-pro', 'user-1');

      // Marking a delivered order COMPLETED in the admin is a legal
      // transition; it used to revoke the customer's right to review what
      // they had already received.
      const where = prisma.order.findFirst.mock.calls.at(-1)?.[0] as {
        where: { status: { in: string[] } };
      };
      expect(where.where.status.in).toEqual(expect.arrayContaining(['DELIVERED', 'COMPLETED']));
    });

    it('reports ALREADY_REVIEWED when the caller already reviewed the product', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1' });
      prisma.review.findUnique.mockResolvedValue(makeReview());

      await expect(service.getReviewEligibility('widget-pro', 'user-1')).resolves.toEqual({
        eligible: false,
        reason: 'ALREADY_REVIEWED',
      });
    });

    it('createReview decides on the same eligibility method, so the two cannot drift', async () => {
      const spy = jest.spyOn(service, 'getReviewEligibility');
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.order.findFirst.mockResolvedValue(null);
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(
        service.createReview('widget-pro', { rating: 5, body: 'Excellent' }, 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(spy).toHaveBeenCalledWith('widget-pro', 'user-1');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // updateReview
  // ═════════════════════════════════════════════════════════════════════════

  describe('updateReview', () => {
    it('updates own review and resets status to PENDING', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'review-1', userId: 'user-1' });
      prisma.asset.count.mockResolvedValue(0);
      prisma.review.update.mockResolvedValue(makeReview({ body: 'Updated body' }));

      const result = await service.updateReview('review-1', { body: 'Updated body' }, 'user-1');

      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: ReviewStatus.PENDING }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('throws REVIEW_NOT_OWNED when updating another user review', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'review-1', userId: 'other-user' });

      await expect(
        service.updateReview('review-1', { body: 'nope' }, 'user-1'),
      ).rejects.toMatchObject({ response: { error: { code: 'REVIEW_NOT_OWNED' } } });
    });

    it('throws NotFoundException for unknown review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(service.updateReview('bad-id', {}, 'user-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // deleteReview
  // ═════════════════════════════════════════════════════════════════════════

  describe('deleteReview', () => {
    it('deletes own review', async () => {
      prisma.review.findUnique.mockResolvedValue({
        id: 'review-1',
        userId: 'user-1',
        productId: 'product-1',
      });
      prisma.review.delete.mockResolvedValue({});

      await service.deleteReview('review-1', 'user-1');

      expect(prisma.review.delete).toHaveBeenCalledWith({ where: { id: 'review-1' } });
      expect(events.emit).toHaveBeenCalledWith(REVIEW_EVENTS.DELETED, expect.any(Object));
    });

    it('throws REVIEW_NOT_OWNED for another user review', async () => {
      prisma.review.findUnique.mockResolvedValue({
        id: 'review-1',
        userId: 'other-user',
        productId: 'product-1',
      });

      await expect(service.deleteReview('review-1', 'user-1')).rejects.toMatchObject({
        response: { error: { code: 'REVIEW_NOT_OWNED' } },
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // toggleHelpfulReview
  // ═════════════════════════════════════════════════════════════════════════

  describe('toggleHelpfulReview', () => {
    it('adds a helpful vote and returns helpful=true', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'review-1' });
      prisma.helpfulVote.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
        fn(prisma),
      );
      prisma.helpfulVote.create.mockResolvedValue(makeHelpfulVote());
      prisma.review.update.mockResolvedValue({});

      const result = await service.toggleHelpfulReview('review-1', 'user-1');
      expect(result).toEqual({ helpful: true });
    });

    it('removes a helpful vote and returns helpful=false', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: 'review-1' });
      prisma.helpfulVote.findUnique.mockResolvedValue(makeHelpfulVote());
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
        fn(prisma),
      );
      prisma.helpfulVote.delete.mockResolvedValue({});
      prisma.review.update.mockResolvedValue({});

      const result = await service.toggleHelpfulReview('review-1', 'user-1');
      expect(result).toEqual({ helpful: false });
    });

    it('throws NotFoundException for unknown review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(service.toggleHelpfulReview('bad-id', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // approveReview / rejectReview (admin)
  // ═════════════════════════════════════════════════════════════════════════

  describe('approveReview', () => {
    it('sets status to PUBLISHED', async () => {
      prisma.review.findUnique.mockResolvedValue(makeReview());
      prisma.review.update.mockResolvedValue(makeReview({ status: ReviewStatus.PUBLISHED }));
      prisma.auditLogEntry.create.mockResolvedValue({});

      const result = await service.approveReview('review-1', 'admin-1');

      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: ReviewStatus.PUBLISHED } }),
      );
      expect(events.emit).toHaveBeenCalledWith(REVIEW_EVENTS.APPROVED, expect.any(Object));
      expect(result).toBeDefined();
    });

    it('throws NotFoundException for unknown review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(service.approveReview('bad-id', 'admin-1')).rejects.toThrow(NotFoundException);
    });

    it('refuses an already published review without writing, auditing or emitting', async () => {
      prisma.review.findUnique.mockResolvedValue(makeReview({ status: ReviewStatus.PUBLISHED }));

      await expect(service.approveReview('review-1', 'admin-1')).rejects.toBeInstanceOf(
        ReviewAlreadyPublishedException,
      );
      expect(prisma.review.update).not.toHaveBeenCalled();
      expect(prisma.auditLogEntry.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('rejectReview', () => {
    it('sets status to HIDDEN', async () => {
      prisma.review.findUnique.mockResolvedValue(makeReview());
      prisma.review.update.mockResolvedValue(makeReview({ status: ReviewStatus.HIDDEN }));
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.rejectReview('review-1', { reason: 'Spam' }, 'admin-1');

      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: ReviewStatus.HIDDEN } }),
      );
      expect(events.emit).toHaveBeenCalledWith(REVIEW_EVENTS.REJECTED, expect.any(Object));
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // adminUpdateReview / adminDeleteReview
  // ═════════════════════════════════════════════════════════════════════════

  describe('adminUpdateReview', () => {
    it('writes the supplied fields and audit-logs them', async () => {
      prisma.review.findUnique.mockResolvedValue(makeReview());
      prisma.review.update.mockResolvedValue(
        makeReview({
          rating: 5,
          title: 'Curated copy',
          body: 'Edited body',
          status: ReviewStatus.PUBLISHED,
        }),
      );
      prisma.auditLogEntry.create.mockResolvedValue({});

      const updated = await service.adminUpdateReview(
        'review-1',
        {
          rating: 5,
          title: 'Curated copy',
          body: 'Edited body',
          status: ReviewStatus.PUBLISHED,
          reason: 'editorial polish',
        },
        'admin-1',
      );

      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'review-1' },
          data: expect.objectContaining({
            rating: 5,
            title: { default: 'Curated copy', en: 'Curated copy' },
            body: { default: 'Edited body', en: 'Edited body' },
            status: ReviewStatus.PUBLISHED,
          }),
        }),
      );
      expect(prisma.auditLogEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'review.updated',
            entityId: 'review-1',
            entityType: 'Review',
          }),
        }),
      );
      expect(updated).toBeDefined();
    });

    it('replaces assets when assetIds is provided', async () => {
      prisma.review.findUnique.mockResolvedValue(makeReview());
      prisma.asset.count.mockResolvedValue(2);
      prisma.review.update.mockResolvedValue(makeReview());
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.adminUpdateReview(
        'review-1',
        {
          assetIds: [
            '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000002',
          ],
        },
        'admin-1',
      );

      expect(prisma.asset.count).toHaveBeenCalled();
      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assets: expect.objectContaining({ deleteMany: {}, create: expect.any(Array) }),
          }),
        }),
      );
    });

    it('throws ASSET_INVALID when an asset id is invalid', async () => {
      prisma.review.findUnique.mockResolvedValue(makeReview());
      prisma.asset.count.mockResolvedValue(0);

      await expect(
        service.adminUpdateReview(
          'review-1',
          { assetIds: ['00000000-0000-0000-0000-000000000001'] },
          'admin-1',
        ),
      ).rejects.toMatchObject({ response: { error: { code: 'ASSET_INVALID' } } });
    });

    it('throws NotFoundException for unknown review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(service.adminUpdateReview('bad-id', { body: 'x' }, 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('adminDeleteReview', () => {
    it('hard-deletes the review, emits DELETED, and audit-logs the action', async () => {
      prisma.review.findUnique.mockResolvedValue(makeReview());
      prisma.review.delete.mockResolvedValue(makeReview());
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.adminDeleteReview('review-1', 'admin-1');

      expect(prisma.review.delete).toHaveBeenCalledWith({ where: { id: 'review-1' } });
      expect(prisma.auditLogEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'review.deleted',
            entityId: 'review-1',
            entityType: 'Review',
          }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        REVIEW_EVENTS.DELETED,
        expect.objectContaining({ reviewId: 'review-1' }),
      );
    });

    it('throws NotFoundException for unknown review', async () => {
      prisma.review.findUnique.mockResolvedValue(null);
      await expect(service.adminDeleteReview('bad-id', 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // createQuestion
  // ═════════════════════════════════════════════════════════════════════════

  describe('createQuestion', () => {
    it('creates a question for a known product', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.productQuestion.create.mockResolvedValue(makeQuestion());

      const result = await service.createQuestion(
        'widget-pro',
        { question: 'Does it come in blue?' },
        'user-1',
      );

      expect(prisma.productQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            question: { default: 'Does it come in blue?', en: 'Does it come in blue?' },
          }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(QUESTION_EVENTS.CREATED, expect.any(Object));
      expect(result).toBeDefined();
    });

    it('returns the public shape — the created row does not echo askedById', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.productQuestion.create.mockResolvedValue(makeQuestion());

      await service.createQuestion('widget-pro', { question: 'Blue?' }, 'user-1');

      const args = prisma.productQuestion.create.mock.calls.at(-1)?.[0] as {
        select?: Record<string, unknown>;
        include?: unknown;
      };
      expect(args.include).toBeUndefined();
      expect(args.select).not.toHaveProperty('askedById');
      expect(args.select).not.toHaveProperty('answeredBy');
    });

    it('throws REVIEW_PRODUCT_NOT_FOUND for unknown product', async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(
        service.createQuestion('no-product', { question: 'Hello?' }, 'user-1'),
      ).rejects.toMatchObject({ response: { error: { code: 'REVIEW_PRODUCT_NOT_FOUND' } } });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // listQuestions
  // ═════════════════════════════════════════════════════════════════════════

  describe('listQuestions', () => {
    it('returns paginated published questions', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.productQuestion.findMany.mockResolvedValue([
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      ]);
      prisma.productQuestion.count.mockResolvedValue(1);

      const result = await service.listQuestions('widget-pro', {});

      expect(prisma.productQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: QuestionStatus.PUBLISHED }),
        }),
      );
      expect(result.meta.total).toBe(1);
    });

    // The route is @Public(). `QUESTION_INCLUDE` is relation-only, so it used to
    // hand out the whole row: `answeredBy` (a staff user id) and `askedById`
    // (plan J, sweep S2).
    it('queries with the public select, never the admin include', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProduct());
      prisma.productQuestion.findMany.mockResolvedValue([]);
      prisma.productQuestion.count.mockResolvedValue(0);

      await service.listQuestions('widget-pro', {});

      const args = prisma.productQuestion.findMany.mock.calls.at(-1)?.[0] as {
        select?: Record<string, unknown>;
        include?: unknown;
      };
      expect(args.include).toBeUndefined();
      expect(args.select).not.toHaveProperty('answeredBy');
      expect(args.select).not.toHaveProperty('askedById');
      expect(args.select).toHaveProperty('answer', true);
      expect(args.select?.['asker']).toEqual({ select: { firstName: true, lastName: true } });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // answerQuestion (storefront)
  // ═════════════════════════════════════════════════════════════════════════

  describe('answerQuestion', () => {
    it('adds an answer to a published question and forces isAdminAnswer to false', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      );
      prisma.productQuestion.update.mockResolvedValue(
        makeQuestion({ answer: 'Yes, it does!', answeredBy: 'user-2' }),
      );

      const result = await service.answerQuestion(
        'question-1',
        { answer: 'Yes, it does!' },
        'user-2',
      );

      expect(prisma.productQuestion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            answer: { default: 'Yes, it does!', en: 'Yes, it does!' },
            answeredBy: 'user-2',
            isAdminAnswer: false,
          }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(QUESTION_EVENTS.ANSWERED, expect.any(Object));
      expect(result).toBeDefined();
    });

    it('returns the public shape — the answer it just wrote does not echo answeredBy', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      );
      prisma.productQuestion.update.mockResolvedValue(makeQuestion());

      await service.answerQuestion('question-1', { answer: 'Yes' }, 'user-2');

      const args = prisma.productQuestion.update.mock.calls.at(-1)?.[0] as {
        select?: Record<string, unknown>;
        include?: unknown;
      };
      expect(args.include).toBeUndefined();
      expect(args.select).not.toHaveProperty('answeredBy');
      expect(args.select).not.toHaveProperty('askedById');
    });

    it('keeps the admin question list on the full include (moderators need answeredBy)', async () => {
      prisma.productQuestion.findMany.mockResolvedValue([]);
      prisma.productQuestion.count.mockResolvedValue(0);

      await service.listQuestionsAdmin({});

      const args = prisma.productQuestion.findMany.mock.calls.at(-1)?.[0] as {
        select?: unknown;
        include?: Record<string, unknown>;
      };
      expect(args.select).toBeUndefined();
      expect(args.include).toHaveProperty('asker');
    });

    it('refuses to overwrite an existing answer, whoever wrote it', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({
          status: QuestionStatus.PUBLISHED,
          answer: { default: 'Yes, ships worldwide.' },
          isAdminAnswer: true,
        }),
      );

      await expect(
        service.answerQuestion('question-1', { answer: 'no it does not' }, 'user-9'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.productQuestion.update).not.toHaveBeenCalled();
    });

    it('reads the stored answer before deciding, so the guard cannot be skipped', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      );
      prisma.productQuestion.update.mockResolvedValue(makeQuestion({ answer: 'ok' }));

      await service.answerQuestion('question-1', { answer: 'ok' }, 'user-2');

      const args = prisma.productQuestion.findUnique.mock.calls.at(-1)?.[0] as {
        select?: Record<string, unknown>;
      };
      expect(args.select).toHaveProperty('answer', true);
    });

    it('throws BadRequestException for a HIDDEN question', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.HIDDEN }),
      );

      await expect(
        service.answerQuestion('question-1', { answer: 'Hi' }, 'user-2'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for unknown question', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(null);
      await expect(service.answerQuestion('bad-id', { answer: 'Hi' }, 'user-2')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // answerQuestionAdmin
  // ═════════════════════════════════════════════════════════════════════════

  describe('answerQuestionAdmin', () => {
    it('persists isAdminAnswer:true when DTO sends true', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      );
      prisma.productQuestion.update.mockResolvedValue(
        makeQuestion({ answer: 'Admin says yes', isAdminAnswer: true }),
      );

      await service.answerQuestionAdmin(
        'question-1',
        { answer: 'Admin says yes', isAdminAnswer: true },
        'admin-1',
      );

      expect(prisma.productQuestion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            answer: { default: 'Admin says yes', en: 'Admin says yes' },
            answeredBy: 'admin-1',
            isAdminAnswer: true,
          }),
        }),
      );
    });

    it('defaults isAdminAnswer to true when DTO omits the field', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      );
      prisma.productQuestion.update.mockResolvedValue(makeQuestion({ isAdminAnswer: true }));

      await service.answerQuestionAdmin('question-1', { answer: 'Default admin' }, 'admin-1');

      expect(prisma.productQuestion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isAdminAnswer: true }),
        }),
      );
    });

    it('persists isAdminAnswer:false when DTO sends false explicitly', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      );
      prisma.productQuestion.update.mockResolvedValue(makeQuestion({ isAdminAnswer: false }));

      await service.answerQuestionAdmin(
        'question-1',
        { answer: 'Admin off the record', isAdminAnswer: false },
        'admin-1',
      );

      expect(prisma.productQuestion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isAdminAnswer: false }),
        }),
      );
    });

    it('throws BadRequestException for a HIDDEN question', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.HIDDEN }),
      );

      await expect(
        service.answerQuestionAdmin('question-1', { answer: 'Hi' }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for unknown question', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(null);
      await expect(
        service.answerQuestionAdmin('bad-id', { answer: 'Hi' }, 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // approveQuestion / rejectQuestion (admin)
  // ═════════════════════════════════════════════════════════════════════════

  describe('approveQuestion', () => {
    it('sets status to PUBLISHED', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(makeQuestion());
      prisma.productQuestion.update.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      );
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.approveQuestion('question-1', 'admin-1');

      expect(prisma.productQuestion.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: QuestionStatus.PUBLISHED } }),
      );
      expect(events.emit).toHaveBeenCalledWith(QUESTION_EVENTS.APPROVED, expect.any(Object));
    });

    it('refuses an already published question without writing, auditing or emitting', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.PUBLISHED }),
      );

      await expect(service.approveQuestion('question-1', 'admin-1')).rejects.toBeInstanceOf(
        QuestionAlreadyPublishedException,
      );
      expect(prisma.productQuestion.update).not.toHaveBeenCalled();
      expect(prisma.auditLogEntry.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('rejectQuestion', () => {
    it('sets status to HIDDEN with reason', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(makeQuestion());
      prisma.productQuestion.update.mockResolvedValue(
        makeQuestion({ status: QuestionStatus.HIDDEN }),
      );
      prisma.auditLogEntry.create.mockResolvedValue({});

      await service.rejectQuestion('question-1', { reason: 'Off-topic' }, 'admin-1');

      expect(prisma.productQuestion.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: QuestionStatus.HIDDEN } }),
      );
      expect(events.emit).toHaveBeenCalledWith(QUESTION_EVENTS.REJECTED, expect.any(Object));
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // getAggregateRating
  // ═════════════════════════════════════════════════════════════════════════

  describe('getAggregateRating', () => {
    it('returns null when no published reviews', async () => {
      prisma.review.count.mockResolvedValue(0);
      prisma.review.groupBy.mockResolvedValue([]);

      const result = await service.getAggregateRating('product-1');
      expect(result).toBeNull();
    });

    it('returns ratingValue and reviewCount', async () => {
      prisma.review.count.mockResolvedValue(2);
      prisma.review.groupBy.mockResolvedValue([
        { rating: 5, _count: { id: 1 } },
        { rating: 3, _count: { id: 1 } },
      ]);

      const result = await service.getAggregateRating('product-1');
      expect(result?.reviewCount).toBe(2);
      expect(result?.ratingValue).toBe(4);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // toggleHelpfulQuestion
  // ═════════════════════════════════════════════════════════════════════════

  describe('toggleHelpfulQuestion', () => {
    it('adds a helpful vote on a question', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue({ id: 'question-1' });
      prisma.helpfulVote.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
        fn(prisma),
      );
      prisma.helpfulVote.create.mockResolvedValue({});
      prisma.productQuestion.update.mockResolvedValue({});

      const result = await service.toggleHelpfulQuestion('question-1', 'user-1');
      expect(result).toEqual({ helpful: true });
    });

    it('throws NotFoundException for unknown question', async () => {
      prisma.productQuestion.findUnique.mockResolvedValue(null);
      await expect(service.toggleHelpfulQuestion('bad-id', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── findByAssetId (S18 — DR-07) ─────────────────────────────────────────────

  describe('findByAssetId', () => {
    it('returns reviews carrying the asset with composed customer name', async () => {
      prisma.review.findMany.mockResolvedValueOnce([
        {
          id: 'rev-1',
          product: { slug: 'classic-tee' },
          user: { firstName: 'Layla', lastName: 'Saab' },
        },
      ]);

      const result = await service.findByAssetId('asset-9');

      expect(result).toEqual([
        { id: 'rev-1', productSlug: 'classic-tee', customerName: 'Layla Saab' },
      ]);
      expect(prisma.review.findMany).toHaveBeenCalledWith({
        where: { assets: { some: { assetId: 'asset-9' } } },
        select: {
          id: true,
          product: { select: { slug: true } },
          user: { select: { firstName: true, lastName: true } },
        },
      });
    });

    it('handles missing names without throwing', async () => {
      prisma.review.findMany.mockResolvedValueOnce([
        { id: 'rev-2', product: { slug: 'mug' }, user: { firstName: null, lastName: null } },
      ]);
      const result = await service.findByAssetId('asset-1');
      expect(result).toEqual([{ id: 'rev-2', productSlug: 'mug', customerName: '' }]);
    });

    it('returns empty when no reviews reference the asset', async () => {
      prisma.review.findMany.mockResolvedValueOnce([]);
      const result = await service.findByAssetId('asset-none');
      expect(result).toEqual([]);
    });
  });
});

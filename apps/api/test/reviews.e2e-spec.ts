import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  api,
  createTestPrisma,
  signUpCustomer,
  loginAs,
  ADMIN,
  STORE_ADDRESS,
} from '../../../test/e2e/helpers';

// ── Constants ────────────────────────────────────────────────────────────────

const TEST_SUFFIX = '@e2e-reviews.test';
const TEST_PASSWORD = 'StrongPass1!';

const SHIPPING_ADDRESS = { ...STORE_ADDRESS, fullName: 'Test User' };

// ── Helpers ──────────────────────────────────────────────────────────────────

function idemKey(): string {
  // X-Idempotency-Key must be UUID v4 per spec §3.6
  return randomUUID();
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Reviews (e2e)', () => {
  let prisma: PrismaClient;

  let customerCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  let productSlug: string;
  let variantId: string;
  let locationId: string;

  // ── Setup ──────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    prisma = createTestPrisma();

    // ── Admin (seeded SUPER_ADMIN bypasses permission checks per §3.3) ───
    adminCookie = await loginAs(ADMIN.email, ADMIN.password);

    // ── Create customers ─────────────────────────────────────────────────
    customerCookie = await signUpCustomer(prisma, `customer${TEST_SUFFIX}`, TEST_PASSWORD, {
      firstName: 'Jane',
      lastName: 'Doe',
    });
    otherCookie = await signUpCustomer(prisma, `other${TEST_SUFFIX}`, TEST_PASSWORD, {
      firstName: 'Other',
      lastName: 'User',
    });

    // ── Resolve inventory location via Prisma (reviews spec tests reviews,
    //    not inventory CRUD — using Prisma avoids a permission dependency on
    //    inventory:create that is irrelevant to this suite's coverage goal).
    const loc = await prisma.inventoryLocation.upsert({
      where: { code: 'E2E-REV-WH' },
      create: { name: 'E2E Reviews Warehouse', code: 'E2E-REV-WH' },
      update: {},
    });
    locationId = loc.id;

    // ── Create product ────────────────────────────────────────────────────
    const productSlugBase = `review-test-product-${Date.now()}`;
    const catRes = await api()
      .post('/v1/admin/categories')
      .set('Cookie', adminCookie)
      .send({ name: { default: 'Reviews Test Category' }, slug: `rev-cat-${Date.now()}` });

    const productRes = await api()
      .post('/v1/admin/products')
      .set('Cookie', adminCookie)
      .send({
        name: { default: 'Review Test Product' },
        slug: productSlugBase,
        description: { default: 'For review E2E tests' },
        status: 'ACTIVE',
        categoryIds: catRes.body.data?.id ? [catRes.body.data.id] : undefined,
        variants: [{ sku: `REV-SKU-${Date.now()}`, price: 100 }],
      });
    if (productRes.status >= 300) {
      throw new Error(
        `reviews beforeAll: product creation failed ${productRes.status}: ${JSON.stringify(productRes.body)}`,
      );
    }
    productSlug = productRes.body.data?.slug;
    variantId = productRes.body.data?.variants?.[0]?.id;

    // ── Stock variant ────────────────────────────────────────────────────
    // X-Idempotency-Key is required by the adjust endpoint (spec §3.6).
    const adjustRes = await api()
      .patch('/v1/admin/inventory/adjust')
      .set('Cookie', adminCookie)
      .set('X-Idempotency-Key', randomUUID())
      .send({ variantId, locationId, quantity: 50, reason: 'RECEIVED' });
    if (adjustRes.status >= 300) {
      throw new Error(
        `reviews beforeAll: inventory adjust failed ${adjustRes.status}: ${JSON.stringify(adjustRes.body)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.helpfulVote.deleteMany({ where: { entityId: { contains: 'review' } } });
    await prisma.review.deleteMany({ where: { product: { slug: productSlug } } });
    await prisma.productQuestion.deleteMany({ where: { product: { slug: productSlug } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: TEST_SUFFIX } } });
    await prisma.$disconnect();
  });

  // ── Helper: place and deliver an order ─────────────────────────────────
  async function deliverOrder(cookie: string): Promise<void> {
    const cartRes = await api()
      .post('/v1/cart/items')
      .set('Cookie', cookie)
      .send({ variantId, quantity: 1 });
    if (cartRes.status >= 300) {
      throw new Error(
        `deliverOrder: cart add failed ${cartRes.status}: ${JSON.stringify(cartRes.body)}`,
      );
    }

    const orderRes = await api()
      .post('/v1/orders')
      .set('Cookie', cookie)
      .set('X-Idempotency-Key', idemKey())
      .send({ shippingAddress: SHIPPING_ADDRESS, billingAddress: SHIPPING_ADDRESS });
    if (orderRes.status >= 300) {
      throw new Error(
        `deliverOrder: order place failed ${orderRes.status}: ${JSON.stringify(orderRes.body)}`,
      );
    }
    const orderId: string = orderRes.body.data?.id;

    for (const status of ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED']) {
      const statusRes = await api()
        .patch(`/v1/admin/orders/${orderId}/status`)
        .set('Cookie', adminCookie)
        .send({ status });
      if (statusRes.status >= 300) {
        throw new Error(
          `deliverOrder: status ${status} failed ${statusRes.status}: ${JSON.stringify(statusRes.body)}`,
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Suite 1 — Review full lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  describe('Review lifecycle', () => {
    let reviewId: string;

    it('POST /v1/products/:slug/reviews — requires verified purchase and emits a stable error code', async () => {
      const res = await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', otherCookie)
        .send({ rating: 5, body: 'Trying to review without purchase' });

      expect(res.status).toBe(400);
      // Stable code lets the storefront map this rejection to a localized
      // message in both EN + AR (see
      // `specs/features/storefront-e2e-hardening/plan.md` §5 B1).
      expect(res.body.error?.code).toBe('REVIEW_VERIFIED_PURCHASE_REQUIRED');
    });

    it('POST /v1/products/:slug/reviews — creates review after delivered order', async () => {
      await deliverOrder(customerCookie);

      const res = await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', customerCookie)
        .send({ rating: 4, title: 'Solid product', body: 'Works as expected.' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ rating: 4, status: 'PENDING', verifiedPurchase: true });
      reviewId = res.body.data.id;
    });

    it('POST /v1/products/:slug/reviews — rejects duplicate review (409) with REVIEW_DUPLICATE code', async () => {
      const res = await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', customerCookie)
        .send({ rating: 3, body: 'Second review attempt' });

      expect(res.status).toBe(409);
      // Stable code lets the storefront map this conflict to a localized
      // message in both EN + AR (see
      // `specs/features/full-stack-audit-2026-05-14/plan.md` §1.1 row #1).
      expect(res.body.error?.code).toBe('REVIEW_DUPLICATE');
    });

    it('POST /v1/products/:slug/reviews — a COMPLETED order still confers review rights', async () => {
      // A fresh customer, so the one-review-per-product constraint does not
      // decide the outcome.
      const completedCookie = await signUpCustomer(
        prisma,
        `completed${TEST_SUFFIX}`,
        TEST_PASSWORD,
        { firstName: 'Completed', lastName: 'Buyer' },
      );
      await deliverOrder(completedCookie);

      const order = await prisma.order.findFirst({
        where: { user: { email: `completed${TEST_SUFFIX}` }, status: 'DELIVERED' },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      expect(order).not.toBeNull();

      await api()
        .patch(`/v1/admin/orders/${order!.id}/status`)
        .set('Cookie', adminCookie)
        .send({ status: 'COMPLETED' })
        .expect(200);

      const res = await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', completedCookie)
        .send({ rating: 5, body: 'Reviewed after the order was closed.' });

      expect(res.status).toBe(201);
    });

    it('GET /v1/products/:slug/reviews/mine — requires a session (401 anonymous)', async () => {
      const res = await api().get(`/v1/products/${productSlug}/reviews/mine`);

      expect(res.status).toBe(401);
    });

    it('GET /v1/products/:slug/reviews/mine — returns the caller PENDING review the public list hides', async () => {
      const mine = await api()
        .get(`/v1/products/${productSlug}/reviews/mine`)
        .set('Cookie', customerCookie)
        .expect(200);

      expect(mine.body.data).toMatchObject({ id: reviewId, status: 'PENDING' });

      const publicList = await api().get(`/v1/products/${productSlug}/reviews`).expect(200);
      expect((publicList.body.data as Array<{ id: string }>).some((r) => r.id === reviewId)).toBe(
        false,
      );
    });

    it('GET /v1/products/:slug/reviews/mine — null for a customer with no review', async () => {
      const res = await api()
        .get(`/v1/products/${productSlug}/reviews/mine`)
        .set('Cookie', otherCookie)
        .expect(200);

      expect(res.body.data).toBeNull();
    });

    it('GET /v1/products/:slug/reviews/eligibility — mirrors the write-path decision', async () => {
      // The form used to be offered to everyone and gated only by the 400 the
      // server answered after they had written a review.
      const anonymous = await api().get(`/v1/products/${productSlug}/reviews/eligibility`);
      expect(anonymous.status).toBe(401);

      const ineligible = await api()
        .get(`/v1/products/${productSlug}/reviews/eligibility`)
        .set('Cookie', otherCookie)
        .expect(200);
      expect(ineligible.body.data).toEqual({
        eligible: false,
        reason: 'VERIFIED_PURCHASE_REQUIRED',
      });

      // ...and the write path refuses the same customer, with the same reason.
      const rejected = await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', otherCookie)
        .send({ rating: 5, body: 'Trying to review without purchase' });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error?.code).toBe('REVIEW_VERIFIED_PURCHASE_REQUIRED');

      const alreadyReviewed = await api()
        .get(`/v1/products/${productSlug}/reviews/eligibility`)
        .set('Cookie', customerCookie)
        .expect(200);
      expect(alreadyReviewed.body.data).toEqual({ eligible: false, reason: 'ALREADY_REVIEWED' });
    });

    it('GET /v1/products/:slug/reviews — returns empty before approval', async () => {
      const res = await api().get(`/v1/products/${productSlug}/reviews`).expect(200);

      const data = res.body.data as unknown[];
      expect(data.length).toBe(0);
    });

    it('PATCH /v1/admin/reviews/:id/approve — approves review', async () => {
      const res = await api()
        .patch(`/v1/admin/reviews/${reviewId}/approve`)
        .set('Cookie', adminCookie)
        .expect(200);

      expect(res.body.data.status).toBe('PUBLISHED');
    });

    it('PATCH /v1/admin/reviews/:id/approve — 409 REVIEW_ALREADY_PUBLISHED on a second approve', async () => {
      const res = await api()
        .patch(`/v1/admin/reviews/${reviewId}/approve`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REVIEW_ALREADY_PUBLISHED');
    });

    it('GET /v1/products/:slug/reviews — shows approved review', async () => {
      const res = await api().get(`/v1/products/${productSlug}/reviews`).expect(200);

      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect((res.body.data as Array<{ id: string }>).some((r) => r.id === reviewId)).toBe(true);
    });

    it('GET /v1/products/:slug/reviews/summary — returns aggregated stats', async () => {
      const res = await api().get(`/v1/products/${productSlug}/reviews/summary`).expect(200);

      expect(res.body.data).toMatchObject({
        total: expect.any(Number),
        averageRating: expect.any(Number),
        histogram: expect.any(Object),
        withPhotos: expect.any(Number),
        verifiedPurchases: expect.any(Number),
      });
      expect(res.body.data).not.toHaveProperty('totalReviews');
      expect(res.body.data).not.toHaveProperty('distribution');
    });

    it('POST /v1/reviews/:id/helpful — toggles helpful vote on', async () => {
      const res = await api()
        .post(`/v1/reviews/${reviewId}/helpful`)
        .set('Cookie', otherCookie)
        .expect(201);

      expect(res.body.data.helpful).toBe(true);
    });

    it('POST /v1/reviews/:id/helpful — toggles helpful vote off', async () => {
      const res = await api()
        .post(`/v1/reviews/${reviewId}/helpful`)
        .set('Cookie', otherCookie)
        .expect(201);

      expect(res.body.data.helpful).toBe(false);
    });

    it('PATCH /v1/reviews/:id — customer updates own review', async () => {
      const res = await api()
        .patch(`/v1/reviews/${reviewId}`)
        .set('Cookie', customerCookie)
        .send({ body: 'Updated — even better than I thought.' })
        .expect(200);

      expect(res.body.data.status).toBe('PENDING');
    });

    it('PATCH /v1/reviews/:id — rejects update by another user (403) with REVIEW_NOT_OWNED', async () => {
      const res = await api()
        .patch(`/v1/reviews/${reviewId}`)
        .set('Cookie', otherCookie)
        .send({ body: 'Hacked' });

      expect(res.status).toBe(403);
      // Stable code lets the storefront map this forbidden response to a
      // localized "you can only edit your own review" copy in both EN + AR
      // (see `specs/features/full-stack-audit-2026-05-14/plan.md` §1.1 row #15).
      expect(res.body.error?.code).toBe('REVIEW_NOT_OWNED');
    });

    it('PATCH /v1/reviews/:id — rejects invalid asset IDs (400) with ASSET_INVALID', async () => {
      // Use a valid v4 UUID that does not exist in the DB so the request passes
      // DTO validation (@IsUUID('4')) and the service throws ASSET_INVALID.
      const res = await api()
        .patch(`/v1/reviews/${reviewId}`)
        .set('Cookie', customerCookie)
        .send({ assetIds: ['a0000000-0000-4000-8000-000000000001'] });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('ASSET_INVALID');
    });

    it('DELETE /v1/reviews/:id — rejects deletion by another user (403) with REVIEW_NOT_OWNED', async () => {
      const res = await api().delete(`/v1/reviews/${reviewId}`).set('Cookie', otherCookie);

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('REVIEW_NOT_OWNED');
    });

    it('DELETE /v1/reviews/:id — customer deletes own review', async () => {
      await api().delete(`/v1/reviews/${reviewId}`).set('Cookie', customerCookie).expect(204);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Suite 1b — Storefront error codes (B2 WARN tier — rows #13, #14)
  // Covers REVIEW_PRODUCT_NOT_FOUND on review-create + question-create, and
  // ASSET_INVALID on review-create. (REVIEW_NOT_OWNED on PATCH + DELETE is
  // covered inline above where the reviewId is mid-lifecycle.)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Storefront error codes — REVIEW_PRODUCT_NOT_FOUND + ASSET_INVALID', () => {
    it('POST /v1/products/:slug/reviews — 404 + REVIEW_PRODUCT_NOT_FOUND on unknown slug', async () => {
      const res = await api()
        .post('/v1/products/does-not-exist-slug-zzz/reviews')
        .set('Cookie', customerCookie)
        .send({ rating: 4, body: 'For a product that does not exist.' });

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('REVIEW_PRODUCT_NOT_FOUND');
    });

    it('POST /v1/products/:slug/questions — 404 + REVIEW_PRODUCT_NOT_FOUND on unknown slug', async () => {
      const res = await api()
        .post('/v1/products/does-not-exist-slug-zzz/questions')
        .set('Cookie', customerCookie)
        .send({ question: 'Will this product ever exist?' });

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('REVIEW_PRODUCT_NOT_FOUND');
    });

    it('POST /v1/products/:slug/reviews — 400 + ASSET_INVALID on unknown asset id', async () => {
      // Deliver another order so the customer is verified-purchase eligible
      // for a fresh review attempt after the lifecycle suite deleted its row.
      await deliverOrder(customerCookie);

      // Use a valid v4 UUID that does not exist in the DB so the request passes
      // DTO validation (@IsUUID('4')) and the service throws ASSET_INVALID.
      const res = await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', customerCookie)
        .send({
          rating: 4,
          body: 'Review with a phantom asset attached.',
          assetIds: ['a0000000-0000-4000-8000-000000000001'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('ASSET_INVALID');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Suite 2 — Admin moderation + full CRUD (edit + hard delete)
  //
  // The same review id flows through reject → admin-edit → admin-delete so
  // the Review.@@unique([productId, userId]) constraint does not trip — the
  // customer can only have one review per product at any time.
  // ═══════════════════════════════════════════════════════════════════════

  describe('Admin moderation + CRUD', () => {
    let reviewId: string;

    beforeAll(async () => {
      // Customer already has a delivered order from Suite 1; create another review.
      const res = await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', customerCookie)
        .send({ rating: 2, body: 'Actually not great.' });
      reviewId = res.body.data?.id;
    });

    it('PATCH /v1/admin/reviews/:id/reject — hides review with reason', async () => {
      const res = await api()
        .patch(`/v1/admin/reviews/${reviewId}/reject`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Contains offensive language' })
        .expect(200);

      expect(res.body.data.status).toBe('HIDDEN');
    });

    it('GET /v1/admin/reviews — filters by status', async () => {
      const res = await api()
        .get('/v1/admin/reviews?status=HIDDEN')
        .set('Cookie', adminCookie)
        .expect(200);

      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    });

    it('PATCH /v1/admin/reviews/:id — admin edits content + status in one call', async () => {
      const res = await api()
        .patch(`/v1/admin/reviews/${reviewId}`)
        .set('Cookie', adminCookie)
        .send({
          rating: 5,
          title: 'Curated by editorial',
          body: 'Admin-rewritten copy that tightens tone for the storefront.',
          status: 'PUBLISHED',
          reason: 'Light copy edit',
        })
        .expect(200);

      expect(res.body.data).toMatchObject({
        rating: 5,
        title: 'Curated by editorial',
        status: 'PUBLISHED',
      });
      expect(res.body.data.body).toContain('tightens tone');
    });

    it('PATCH /v1/admin/reviews/:id — rejects rating out of range (400)', async () => {
      await api()
        .patch(`/v1/admin/reviews/${reviewId}`)
        .set('Cookie', adminCookie)
        .send({ rating: 99 })
        .expect(400);
    });

    it('PATCH /v1/admin/reviews/:id — requires reviews:update (403 for customer)', async () => {
      await api()
        .patch(`/v1/admin/reviews/${reviewId}`)
        .set('Cookie', customerCookie)
        .send({ rating: 4 })
        .expect(403);
    });

    it('PATCH /v1/admin/reviews/:id — 404 for unknown id', async () => {
      await api()
        .patch(`/v1/admin/reviews/00000000-0000-0000-0000-000000000000`)
        .set('Cookie', adminCookie)
        .send({ body: 'noop' })
        .expect(404);
    });

    it('DELETE /v1/admin/reviews/:id — requires reviews:delete (403 for customer)', async () => {
      await api().delete(`/v1/admin/reviews/${reviewId}`).set('Cookie', customerCookie).expect(403);
    });

    it('DELETE /v1/admin/reviews/:id — admin hard-deletes the review', async () => {
      await api().delete(`/v1/admin/reviews/${reviewId}`).set('Cookie', adminCookie).expect(204);

      // Subsequent admin update returns 404 confirming the row is gone.
      await api()
        .patch(`/v1/admin/reviews/${reviewId}`)
        .set('Cookie', adminCookie)
        .send({ body: 'should fail' })
        .expect(404);
    });

    it('DELETE /v1/admin/reviews/:id — 404 for already-deleted row', async () => {
      await api().delete(`/v1/admin/reviews/${reviewId}`).set('Cookie', adminCookie).expect(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Suite 3 — Q&A lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  describe('Q&A lifecycle', () => {
    let questionId: string;

    it('POST /v1/products/:slug/questions — requires auth (401 without token)', async () => {
      await api()
        .post(`/v1/products/${productSlug}/questions`)
        .send({ question: 'Does it come in blue?' })
        .expect(401);
    });

    it('POST /v1/products/:slug/questions — creates a question', async () => {
      const res = await api()
        .post(`/v1/products/${productSlug}/questions`)
        .set('Cookie', customerCookie)
        .send({ question: 'Does it come in blue?' })
        .expect(201);

      expect(res.body.data.question).toBe('Does it come in blue?');
      expect(res.body.data.status).toBe('PENDING');
      questionId = res.body.data.id;
    });

    it('GET /v1/products/:slug/questions — returns empty before approval', async () => {
      const res = await api().get(`/v1/products/${productSlug}/questions`).expect(200);

      expect((res.body.data as unknown[]).length).toBe(0);
    });

    it('PATCH /v1/admin/questions/:id/approve — publishes question', async () => {
      const res = await api()
        .patch(`/v1/admin/questions/${questionId}/approve`)
        .set('Cookie', adminCookie)
        .expect(200);

      expect(res.body.data.status).toBe('PUBLISHED');
    });

    it('GET /v1/products/:slug/questions — shows published question', async () => {
      const res = await api().get(`/v1/products/${productSlug}/questions`).expect(200);

      expect((res.body.data as Array<{ id: string }>).some((q) => q.id === questionId)).toBe(true);
    });

    it('POST /v1/admin/questions/:id/answer — admin answers the question', async () => {
      // Storefront /v1/questions/:id/answer hard-codes isAdminAnswer=false
      // (see reviews.service.ts) — admin write goes through the admin route
      // so the moderator-supplied flag survives.
      const res = await api()
        .post(`/v1/admin/questions/${questionId}/answer`)
        .set('Cookie', adminCookie)
        .send({ answer: 'Yes, it comes in blue!', isAdminAnswer: true })
        .expect(201);

      expect(res.body.data.answer).toBe('Yes, it comes in blue!');
      expect(res.body.data.isAdminAnswer).toBe(true);
    });

    it('POST /v1/questions/:id/helpful — toggles helpful on a question', async () => {
      const res = await api()
        .post(`/v1/questions/${questionId}/helpful`)
        .set('Cookie', customerCookie)
        .expect(201);

      expect(res.body.data.helpful).toBe(true);
    });

    it('POST /v1/questions/:id/answer — rejects HIDDEN question (400) with QUESTION_NOT_AVAILABLE_FOR_ANSWER code', async () => {
      // Moderator transitions the question to HIDDEN (see
      // `reviews.service.ts:rejectQuestion` — sets `QuestionStatus.HIDDEN`).
      // Subsequent storefront answers must be rejected with the stable
      // code so the storefront can map it to a localized message in both
      // EN + AR (Full-Stack Audit plan §1.1 row #2).
      await api()
        .patch(`/v1/admin/questions/${questionId}/reject`)
        .set('Cookie', adminCookie)
        .send({ reason: 'closed for new answers' })
        .expect(200);

      const res = await api()
        .post(`/v1/questions/${questionId}/answer`)
        .set('Cookie', otherCookie)
        .send({ answer: 'Trying to answer a hidden question' });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('QUESTION_NOT_AVAILABLE_FOR_ANSWER');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Suite 4 — Validation guards
  // ═══════════════════════════════════════════════════════════════════════

  describe('Validation guards', () => {
    it('POST /v1/products/:slug/reviews — rejects rating out of range', async () => {
      await deliverOrder(otherCookie);

      await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', otherCookie)
        .send({ rating: 6, body: 'Too high rating' })
        .expect(400);
    });

    it('POST /v1/products/:slug/reviews — rejects missing body', async () => {
      await api()
        .post(`/v1/products/${productSlug}/reviews`)
        .set('Cookie', otherCookie)
        .send({ rating: 4 })
        .expect(400);
    });

    it('POST /v1/products/:slug/questions — rejects empty question', async () => {
      await api()
        .post(`/v1/products/${productSlug}/questions`)
        .set('Cookie', customerCookie)
        .send({ question: '' })
        .expect(400);
    });

    it('GET /v1/products/nonexistent/reviews — returns 404', async () => {
      await api().get('/v1/products/nonexistent-slug-xyz/reviews').expect(404);
    });

    it('PATCH /v1/admin/reviews/:id/approve — requires reviews:update permission', async () => {
      await api()
        .patch('/v1/admin/reviews/some-id/approve')
        .set('Cookie', customerCookie)
        .expect(403);
    });
  });
});

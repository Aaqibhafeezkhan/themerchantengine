/**
 * Provider-agnostic card checkout with the fake redirect provider (issue #45, P5).
 *
 * The order exists before the payment. A redirect provider answers with a
 * redirect action that points at the storefront confirmation page. When the
 * shopper comes back, the confirm call asks the provider for the live status
 * and the order turns paid. The API boots with PAYMENT_FAKE_PROVIDERS=true in
 * this harness; the fakes are test doubles and never exist in production.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { api, createTestPrisma, signUpCustomer, STORE_ADDRESS } from '../../../test/e2e/helpers';

const TEST_SUFFIX = '@e2e-fake-redirect.test';
const TEST_PASSWORD = 'StrongPass1!';
const METHOD_CODE = 'e2e_fake_redirect';
const SLUG_PREFIX = 'e2e-fakeredirect-';
const SHIPPING_ADDRESS = { ...STORE_ADDRESS, fullName: 'Test User' };

describe('Fake redirect payments (e2e)', () => {
  let prisma: PrismaClient;
  let customerCookie: string;
  let variantId: string;

  async function cleanup() {
    const ownOrders = { order: { user: { email: { endsWith: TEST_SUFFIX } } } };
    await prisma.inventoryMovement.deleteMany({
      where: { variant: { product: { slug: { startsWith: SLUG_PREFIX } } } },
    });
    await prisma.orderItem.deleteMany({ where: ownOrders });
    await prisma.invoice.deleteMany({ where: ownOrders });
    await prisma.shipment.deleteMany({ where: ownOrders });
    await prisma.orderStatusHistory.deleteMany({ where: ownOrders });
    const orderIds = (
      await prisma.order.findMany({
        where: { user: { email: { endsWith: TEST_SUFFIX } } },
        select: { id: true },
      })
    ).map((o) => o.id);
    await prisma.auditLogEntry.deleteMany({
      where: { entityType: 'Order', entityId: { in: orderIds } },
    });
    await prisma.order.deleteMany({ where: { user: { email: { endsWith: TEST_SUFFIX } } } });
    await prisma.cartItem.deleteMany({
      where: { cart: { user: { email: { endsWith: TEST_SUFFIX } } } },
    });
    await prisma.cart.deleteMany({ where: { user: { email: { endsWith: TEST_SUFFIX } } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: TEST_SUFFIX } } });
    await prisma.paymentMethod.deleteMany({ where: { code: METHOD_CODE } });
  }

  async function placeOrder() {
    const cart = await api()
      .post('/v1/cart/items')
      .set('Cookie', customerCookie)
      .send({ variantId, quantity: 1 });
    expect(cart.status).toBe(200);

    const res = await api()
      .post('/v1/orders')
      .set('Cookie', customerCookie)
      .set('X-Idempotency-Key', randomUUID())
      .send({
        shippingAddress: SHIPPING_ADDRESS,
        billingAddress: SHIPPING_ADDRESS,
        paymentMethodCode: METHOD_CODE,
      });
    expect(res.status).toBe(201);
    return res.body.data as {
      id: string;
      orderNumber: string;
      paymentStatus: string;
      paymentAction: { type: string; url?: string };
    };
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await cleanup();

    await prisma.paymentMethod.create({
      data: {
        code: METHOD_CODE,
        name: { default: 'Fake redirect' },
        provider: 'fake_redirect',
        isActive: true,
        sortOrder: 0,
      },
    });

    let location = await prisma.inventoryLocation.findFirst({ where: { isActive: true } });
    if (!location) {
      location = await prisma.inventoryLocation.create({
        data: { name: 'Default', code: 'DEF-FAKE', isActive: true },
      });
    }

    const timestamp = Date.now();
    const product = await prisma.product.create({
      data: {
        name: { default: 'E2E Fake Redirect Widget', fr: 'E2E Fake Redirect Widget', en: 'E2E Fake Redirect Widget' },
        slug: `${SLUG_PREFIX}${timestamp}`,
        description: { default: 'Fake redirect E2E product', fr: 'Fake redirect E2E product', en: 'Fake redirect E2E product' },
        status: 'ACTIVE',
      },
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `E2E-FAKE-${timestamp}`,
        price: 100,
        weight: 0.5,
        isActive: true,
      },
    });
    variantId = variant.id;
    await prisma.stockLevel.create({
      data: { variantId, locationId: location.id, onHand: 100, reserved: 0 },
    });

    customerCookie = await signUpCustomer(prisma, `payer${TEST_SUFFIX}`, TEST_PASSWORD, {
      firstName: 'Fay',
      lastName: 'Redirect',
    });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('places the order first and answers with a redirect to the confirmation page', async () => {
    const order = await placeOrder();
    expect(order.paymentStatus).toBe('PENDING');
    expect(order.paymentAction.type).toBe('redirect');
    expect(order.paymentAction.url).toContain(`/order-confirmation/${order.orderNumber}`);

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { paymentReference: true, paymentStatus: true },
    });
    expect(row.paymentReference).toBe(`fake_redirect_${order.id}`);
    expect(row.paymentStatus).toBe('PENDING');
  });

  it('turns the order paid when the shopper returns and the page confirms', async () => {
    const order = await placeOrder();

    const confirm = await api()
      .post(`/v1/orders/${order.id}/payment/confirm`)
      .set('Cookie', customerCookie)
      .set('X-Idempotency-Key', randomUUID());
    expect(confirm.status).toBe(200);

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { paymentStatus: true },
    });
    expect(row.paymentStatus).toBe('CAPTURED');
  });

  it('hands out a fresh redirect when the shopper retries an unpaid order', async () => {
    const order = await placeOrder();

    const retry = await api()
      .post(`/v1/orders/${order.id}/payment`)
      .set('Cookie', customerCookie)
      .set('X-Idempotency-Key', randomUUID());
    expect(retry.status).toBe(200);
    expect(retry.body.data.paymentAction.type).toBe('redirect');
    expect(retry.body.data.paymentAction.url).toContain(`/order-confirmation/${order.orderNumber}`);
  });

  it('keeps a confirm replay safe once the order is paid', async () => {
    const order = await placeOrder();
    for (let i = 0; i < 2; i += 1) {
      const res = await api()
        .post(`/v1/orders/${order.id}/payment/confirm`)
        .set('Cookie', customerCookie)
        .set('X-Idempotency-Key', randomUUID());
      expect(res.status).toBe(200);
    }
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { paymentStatus: true },
    });
    expect(row.paymentStatus).toBe('CAPTURED');
  });
});

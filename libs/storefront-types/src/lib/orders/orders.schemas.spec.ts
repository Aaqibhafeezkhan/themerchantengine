import { describe, expect, it } from 'vitest';
import {
  createOrderRequestSchema,
  invoiceResponseSchema,
  listOrdersQuerySchema,
  orderAddressInputSchema,
  orderSchema,
  paymentActionSchema,
  placedOrderSchema,
  trackOrderRequestSchema,
  trackingResponseSchema,
} from './orders.schemas';

describe('orderAddressInputSchema', () => {
  it('accepts a valid address', () => {
    expect(() =>
      orderAddressInputSchema.parse({
        fullName: 'Jane',
        phone: '+97412345678',
        addressLine1: '1 Main',
        city: 'Lyon',
        country: 'QA',
      }),
    ).not.toThrow();
  });

  it('rejects lowercase country', () => {
    expect(() =>
      orderAddressInputSchema.parse({
        fullName: 'Jane',
        phone: '+97412345678',
        addressLine1: '1 Main',
        city: 'Lyon',
        country: 'qa',
      }),
    ).toThrow();
  });
});

describe('createOrderRequestSchema', () => {
  it('accepts shipping address by id', () => {
    expect(() => createOrderRequestSchema.parse({ shippingAddressId: 'addr1' })).not.toThrow();
  });

  it('accepts inline shipping address', () => {
    expect(() =>
      createOrderRequestSchema.parse({
        shippingAddress: {
          fullName: 'Jane',
          phone: '+97412345678',
          addressLine1: '1 Main',
          city: 'Lyon',
          country: 'QA',
        },
      }),
    ).not.toThrow();
  });

  it('rejects when neither shipping address provided', () => {
    expect(() => createOrderRequestSchema.parse({ couponCode: 'SAVE10' })).toThrow();
  });

  it('rejects invalid gift card code', () => {
    expect(() =>
      createOrderRequestSchema.parse({
        shippingAddressId: 'addr1',
        giftCardCode: 'too-short',
      }),
    ).toThrow();
  });
});

/**
 * Plan F phases F5 and F6. This schema strips unknown keys, so a field the page
 * assembles but the schema does not declare is dropped silently on the way to
 * the wire. That is exactly how a guest order reached the API with no contact
 * address and came back `ORDER_GUEST_EMAIL_REQUIRED`.
 */
describe('createOrderRequestSchema guest and tender fields', () => {
  it('carries guestEmail and paymentMethodCode through the parse', () => {
    const parsed = createOrderRequestSchema.parse({
      guestEmail: 'buyer@example.test',
      shippingAddress: {
        fullName: 'Guest Buyer',
        phone: '+21620123456',
        addressLine1: '12 rue de la Republique',
        city: 'Springfield',
        country: 'TN',
      },
      shippingMethodId: 'sm-1',
      paymentMethodCode: 'cod',
    });
    expect(parsed.guestEmail).toBe('buyer@example.test');
    expect(parsed.paymentMethodCode).toBe('cod');
    expect(parsed.shippingMethodId).toBe('sm-1');
  });

  it('rejects a malformed guest email rather than sending it', () => {
    expect(() =>
      createOrderRequestSchema.parse({ shippingAddressId: 'addr1', guestEmail: 'nope' }),
    ).toThrow();
  });
});

describe('listOrdersQuerySchema', () => {
  it('accepts pagination', () => {
    expect(() => listOrdersQuerySchema.parse({ page: 1, pageSize: 20 })).not.toThrow();
  });

  it('rejects negative page', () => {
    expect(() => listOrdersQuerySchema.parse({ page: 0 })).toThrow();
  });

  it('accepts a valid status filter', () => {
    expect(() =>
      listOrdersQuerySchema.parse({ page: 1, pageSize: 20, status: 'SHIPPED' }),
    ).not.toThrow();
  });

  it('rejects an unknown status value', () => {
    expect(() => listOrdersQuerySchema.parse({ status: 'NEW' })).toThrow();
  });
});

/**
 * The track lookup became `POST /v1/orders/track` with a body at plan M phase
 * M3, so the request schema carries both halves of the challenge (finding K10).
 */
describe('trackOrderRequestSchema', () => {
  const VALID = { orderNumber: 'ORD-2026-000005', email: 'a@b.co' };

  it('accepts an order number and email pair', () => {
    expect(trackOrderRequestSchema.parse(VALID)).toEqual(VALID);
  });

  it('rejects a missing email', () => {
    expect(() => trackOrderRequestSchema.parse({ orderNumber: 'ORD-2026-000005' })).toThrow();
  });

  it('rejects a missing order number', () => {
    expect(() => trackOrderRequestSchema.parse({ email: 'a@b.co' })).toThrow();
  });

  it('rejects an order number the API would refuse, before the request leaves', () => {
    for (const orderNumber of ['ord-2026-000005', 'ORD 2026', 'O'.repeat(33), '']) {
      expect(() => trackOrderRequestSchema.parse({ ...VALID, orderNumber })).toThrow();
    }
  });
});

describe('trackingResponseSchema', () => {
  it('parses the shape the API actually sends', () => {
    const parsed = trackingResponseSchema.parse({
      orderNumber: 'ORD-2026-000005',
      status: 'SHIPPED',
      createdAt: '2026-08-30T10:00:00.000Z',
      shipments: [
        {
          id: 's1',
          carrier: 'Aramex',
          trackingNumber: 'TRK-1',
          status: 'SHIPPED',
          shippedAt: '2026-08-30T11:00:00.000Z',
          deliveredAt: null,
        },
      ],
      timeline: [
        { status: 'PENDING', at: '2026-08-30T10:00:00.000Z' },
        { status: 'SHIPPED', at: '2026-08-30T11:00:00.000Z' },
      ],
    });
    expect(parsed.timeline).toHaveLength(2);
    expect(parsed.shipments[0].carrier).toBe('Aramex');
  });

  it('defaults both lists so a consumer never maps over undefined', () => {
    const parsed = trackingResponseSchema.parse({ orderNumber: 'ORD-1', status: 'PENDING' });
    expect(parsed.shipments).toEqual([]);
    expect(parsed.timeline).toEqual([]);
  });

  /**
   * The old schema declared top-level `carrier`, `trackingNumber` and
   * `estimatedDelivery` that the API has never sent. A field that is always
   * undefined is a field a page can render nothing from while looking like it
   * renders something, so they are gone; the real values live on `shipments`.
   */
  it('does not declare the phantom top-level tracking fields', () => {
    const shape = Object.keys(trackingResponseSchema.shape).sort();
    expect(shape).toEqual([
      'createdAt',
      'orderNumber',
      'paymentRetryable',
      'paymentStatus',
      'shipments',
      'status',
      'timeline',
    ]);
  });

  it('defaults paymentRetryable to false and keeps paymentStatus optional', () => {
    const parsed = trackingResponseSchema.parse({ orderNumber: 'ORD-1', status: 'PENDING' });
    expect(parsed.paymentRetryable).toBe(false);
    expect(parsed.paymentStatus).toBeUndefined();
  });

  it('carries the payment fields the API sends', () => {
    const parsed = trackingResponseSchema.parse({
      orderNumber: 'ORD-1',
      status: 'PENDING',
      paymentStatus: 'FAILED',
      paymentRetryable: true,
    });
    expect(parsed.paymentStatus).toBe('FAILED');
    expect(parsed.paymentRetryable).toBe(true);
  });
});

describe('orderSchema', () => {
  it('parses a real-shape order', () => {
    expect(() =>
      orderSchema.parse({
        id: 'ord1',
        orderNumber: 'AKL-0001',
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        items: [
          {
            id: 'oi1',
            productId: 'p1',
            variantId: 'v1',
            productSlug: 'headphones',
            productName: 'Headphones',
            quantity: 1,
            unitPrice: 199,
            lineTotal: 199,
          },
        ],
        subtotal: 199,
        total: 199,
        currency: 'EUR',
        createdAt: '2026-04-25T10:00:00Z',
      }),
    ).not.toThrow();
  });

  // Regression: the storefront `GET /v1/orders` (list) endpoint uses a
  // lightweight `ORDER_LIST_SELECT` projection that excludes the items
  // relation — only counts are returned via `_count`. The schema must
  // accept the items-less shape so the orders list page renders.
  it('parses the list-projection shape (no items) and defaults items to []', () => {
    const parsed = orderSchema.parse({
      id: 'cmoixfbmt0005isqs4yqxkdkn',
      orderNumber: 'ORD-2026-000164',
      userId: 'cmoivre1f0000hcqsndaazzie',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      subtotal: '2999',
      discountAmount: '0',
      shippingAmount: '15',
      taxAmount: '0',
      total: '3014',
      currency: 'EUR',
      couponCode: null,
      createdAt: '2026-04-28T17:55:19.589Z',
      updatedAt: '2026-04-28T17:55:19.589Z',
      _count: { items: 1, shipments: 0 },
    });
    expect(parsed.items).toEqual([]);
  });

  // Regression: the live `POST /v1/orders` response emits the raw Prisma
  // OrderItem shape — no `productSlug` and `total` rather than `lineTotal`.
  // The schema must accept this shape and the transform must surface
  // `lineTotal` so existing UI bindings keep working.
  it('parses the live API shape (total, no productSlug) and exposes lineTotal', () => {
    const parsed = orderSchema.parse({
      id: 'cmoixfbmt0005isqs4yqxkdkn',
      orderNumber: 'ORD-2026-000164',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      items: [
        {
          id: 'cmoixfbn40006isqsc5716hmk',
          orderId: 'cmoixfbmt0005isqs4yqxkdkn',
          variantId: 'cmoeui1tl0008cwqsbykwdw13',
          productId: 'cmoeui1td0007cwqs0279hicm',
          productName: 'Probe Pro 14 Plus Laptop',
          variantLabel: null,
          sku: 'KH-LAP-PRO14-PLS',
          unitPrice: '2999',
          quantity: 1,
          discountAmount: '0',
          taxAmount: '0',
          total: '2999',
        },
      ],
      subtotal: '2999',
      total: '3014',
      currency: 'EUR',
      createdAt: '2026-04-28T17:55:19.589Z',
    });
    expect(parsed.items[0].lineTotal).toBe('2999');
    expect(parsed.items[0].productSlug).toBeUndefined();
  });

  it('rejects unknown status', () => {
    expect(() =>
      orderSchema.parse({
        id: 'ord1',
        orderNumber: 'AKL-0001',
        status: 'NEW',
        paymentStatus: 'PENDING',
        items: [],
        subtotal: 0,
        total: 0,
        currency: 'EUR',
        createdAt: '2026-04-25T10:00:00Z',
      }),
    ).toThrow();
  });
});

describe('trackingResponseSchema', () => {
  it('parses a tracking response', () => {
    expect(() =>
      trackingResponseSchema.parse({
        orderNumber: 'AKL-0001',
        status: 'SHIPPED',
        carrier: 'ExampleExpress',
        trackingNumber: 'AKE-12345',
        timeline: [{ status: 'CONFIRMED', at: '2026-04-25T10:00:00Z' }],
      }),
    ).not.toThrow();
  });

  /**
   * Finding N3. `GET /v1/orders/:orderNumber/track` sends `createdAt` and a
   * `shipments` array and no `timeline` at all. Both survived only through
   * `.passthrough()`, untyped, so the page could not read them and rendered a
   * status badge and nothing else.
   */
  it('types the shipments rows the API actually sends', () => {
    const parsed = trackingResponseSchema.parse({
      orderNumber: 'DTN-0001',
      status: 'SHIPPED',
      createdAt: '2026-04-25T10:00:00Z',
      shipments: [
        {
          id: 'shp_1',
          carrier: 'Aramex',
          trackingNumber: 'ARX-9',
          status: 'SHIPPED',
          shippedAt: '2026-04-26T08:00:00Z',
          deliveredAt: null,
        },
      ],
    });
    expect(parsed.createdAt).toBe('2026-04-25T10:00:00Z');
    expect(parsed.shipments).toHaveLength(1);
    expect(parsed.shipments[0].carrier).toBe('Aramex');
    expect(parsed.shipments[0].trackingNumber).toBe('ARX-9');
    expect(parsed.shipments[0].deliveredAt).toBeNull();
  });

  it('defaults shipments to an empty array when the API omits it', () => {
    const parsed = trackingResponseSchema.parse({
      orderNumber: 'DTN-0002',
      status: 'PENDING',
    });
    expect(parsed.shipments).toEqual([]);
    expect(parsed.timeline).toEqual([]);
  });

  it('tolerates a shipment row carrying only an id', () => {
    const parsed = trackingResponseSchema.parse({
      orderNumber: 'DTN-0003',
      status: 'PROCESSING',
      shipments: [{ id: 'shp_2' }],
    });
    expect(parsed.shipments[0].id).toBe('shp_2');
    expect(parsed.shipments[0].carrier ?? null).toBeNull();
  });

  it('rejects a shipments value that is not a list of identified rows', () => {
    expect(() =>
      trackingResponseSchema.parse({
        orderNumber: 'DTN-0004',
        status: 'SHIPPED',
        shipments: 'ARX-9',
      }),
    ).toThrow();

    expect(() =>
      trackingResponseSchema.parse({
        orderNumber: 'DTN-0005',
        status: 'SHIPPED',
        shipments: [{ carrier: 'Aramex' }],
      }),
    ).toThrow();
  });
});

describe('invoiceResponseSchema', () => {
  it('parses a valid invoice payload', () => {
    expect(() =>
      invoiceResponseSchema.parse({
        orderNumber: 'AKL-0001',
        issuedAt: '2026-04-25T10:00:00Z',
        total: 215,
        currency: 'EUR',
      }),
    ).not.toThrow();
  });

  it('accepts a string-form decimal total', () => {
    expect(() =>
      invoiceResponseSchema.parse({
        orderNumber: 'AKL-0002',
        issuedAt: '2026-04-25T10:00:00Z',
        total: '215.00',
        currency: 'EUR',
      }),
    ).not.toThrow();
  });

  it('rejects a payload missing orderNumber', () => {
    expect(() =>
      invoiceResponseSchema.parse({
        issuedAt: '2026-04-25T10:00:00Z',
        total: 215,
        currency: 'EUR',
      }),
    ).toThrow();
  });

  it('rejects a payload missing issuedAt', () => {
    expect(() =>
      invoiceResponseSchema.parse({
        orderNumber: 'AKL-0001',
        total: 215,
        currency: 'EUR',
      }),
    ).toThrow();
  });

  it('rejects a non-three-letter currency', () => {
    expect(() =>
      invoiceResponseSchema.parse({
        orderNumber: 'AKL-0001',
        issuedAt: '2026-04-25T10:00:00Z',
        total: 215,
        currency: 'QA',
      }),
    ).toThrow();
  });
});

describe('createOrderRequestSchema giftCardCode range', () => {
  // Codes are issued 8 to 20 uppercase alphanumerics: `CreateGiftCardDto` says
  // so and the cart's `applyGiftCardRequestSchema` already agrees. This
  // demanded exactly 16, the length the generator happens to produce but not
  // the range an operator can issue, so a short card applied on the cart and
  // was then refused client-side at checkout with a rule the server does not
  // have.
  const base = {
    shippingAddressId: 'addr-1',
  };

  it.each(['ABCD1234', 'FXGIFTWELCOME100', 'A1B2C3D4E5F6G7H8I9J0'])(
    'accepts an operator-issuable code: %s',
    (giftCardCode) => {
      expect(() => createOrderRequestSchema.parse({ ...base, giftCardCode })).not.toThrow();
    },
  );

  it.each(['ABCD123', 'A1B2C3D4E5F6G7H8I9J0K', 'abcd1234efgh', 'GIFT-TEST-1234'])(
    'rejects %s',
    (giftCardCode) => {
      expect(() => createOrderRequestSchema.parse({ ...base, giftCardCode })).toThrow();
    },
  );
});

describe('paymentActionSchema', () => {
  it.each([
    { type: 'none' },
    { type: 'redirect', url: 'https://pay.example.com/s/1' },
    { type: 'form_post', url: 'https://pay.example.com/post', fields: { a: 'b' } },
    { type: 'embedded', clientToken: 'tok', publicConfig: { publishableKey: 'pk_test_x' } },
    { type: 'embedded', clientToken: 'tok' },
  ])('accepts %j', (action) => {
    expect(paymentActionSchema.parse(action)).toMatchObject(action);
  });

  it('rejects an action type the storefront does not know', () => {
    expect(() => paymentActionSchema.parse({ type: 'qr_code', url: 'x' })).toThrow();
  });

  it('rejects a redirect without a url', () => {
    expect(() => paymentActionSchema.parse({ type: 'redirect' })).toThrow();
  });

  it('rejects a redirect to a non-http(s) url', () => {
    expect(() =>
      paymentActionSchema.parse({ type: 'redirect', url: 'javascript:alert(1)' }),
    ).toThrow();
  });
});

describe('placedOrderSchema', () => {
  const order = {
    id: '3f1c1c7e-5b0e-4a53-9c43-0c5d8f0a1111',
    orderNumber: 'ORD-1',
    status: 'PENDING',
    paymentStatus: 'PENDING',
    subtotal: '10.00',
    total: '10.00',
    currency: 'USD',
    createdAt: '2026-11-04T10:00:00.000Z',
  };

  it('defaults a missing paymentAction to none', () => {
    expect(placedOrderSchema.parse(order).paymentAction).toEqual({ type: 'none' });
  });

  it('carries the paymentAction the API sends', () => {
    const parsed = placedOrderSchema.parse({
      ...order,
      paymentAction: { type: 'redirect', url: 'https://pay.example.com/s/1' },
    });
    expect(parsed.paymentAction).toEqual({ type: 'redirect', url: 'https://pay.example.com/s/1' });
  });
});

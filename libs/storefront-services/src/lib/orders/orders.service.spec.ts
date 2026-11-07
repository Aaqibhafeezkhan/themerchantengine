import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../shared/api-client.token';
import { OrdersService } from './orders.service';

const fakeOrder = {
  id: 'ord1',
  orderNumber: 'AKL-0001',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  items: [],
  subtotal: 0,
  total: 0,
  currency: 'EUR',
  createdAt: '2026-04-25T10:00:00Z',
};

function mockClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    get: vi.fn(async () => ({ data: fakeOrder })),
    post: vi.fn(async () => ({ data: fakeOrder })),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe('OrdersService.create', () => {
  it('threads X-Idempotency-Key through the api-client option', async () => {
    const post = vi.fn(async () => ({ data: fakeOrder })) as ApiClient['post'];
    const svc = new OrdersService(mockClient({ post }));
    await svc.create({ shippingAddressId: 'addr1' }, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(post).toHaveBeenCalledWith(
      '/v1/orders',
      expect.objectContaining({ shippingAddressId: 'addr1' }),
      expect.objectContaining({ idempotencyKey: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }), // gitleaks:allow
    );
  });

  it('rejects when neither shipping address provided', async () => {
    const svc = new OrdersService(mockClient({}));
    await expect(svc.create({}, 'idem-key')).rejects.toThrow();
  });

  it('rejects empty idempotency key', async () => {
    const svc = new OrdersService(mockClient({}));
    await expect(svc.create({ shippingAddressId: 'addr1' }, '')).rejects.toThrow();
  });

  it('propagates API rejection from post()', async () => {
    const post = vi.fn(async () => {
      throw new Error('409 Conflict');
    }) as ApiClient['post'];
    const svc = new OrdersService(mockClient({ post }));
    await expect(
      svc.create({ shippingAddressId: 'addr1' }, 'f47ac10b-58cc-4372-a567-0e02b2c3d479'),
    ).rejects.toThrow('409 Conflict');
  });
});

describe('OrdersService payment step', () => {
  const KEY = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'; // gitleaks:allow

  it('create returns the paymentAction the API sent', async () => {
    const post = vi.fn(async () => ({
      data: { ...fakeOrder, paymentAction: { type: 'redirect', url: 'https://pay.example/x' } },
    })) as ApiClient['post'];
    const svc = new OrdersService(mockClient({ post }));
    const placed = await svc.create({ shippingAddressId: 'addr1' }, KEY);
    expect(placed.paymentAction).toEqual({ type: 'redirect', url: 'https://pay.example/x' });
  });

  it('create defaults to no payment step when the API sends none', async () => {
    const svc = new OrdersService(mockClient({}));
    const placed = await svc.create({ shippingAddressId: 'addr1' }, KEY);
    expect(placed.paymentAction).toEqual({ type: 'none' });
  });

  it('retryPayment posts to the order payment route with the key and returns the action', async () => {
    const post = vi.fn(async () => ({
      data: { paymentAction: { type: 'embedded', clientToken: 'tok' } },
    })) as ApiClient['post'];
    const svc = new OrdersService(mockClient({ post }));
    const action = await svc.retryPayment('ord1', KEY);
    expect(action).toEqual({ type: 'embedded', clientToken: 'tok' });
    expect(post).toHaveBeenCalledWith(
      '/v1/orders/ord1/payment',
      undefined,
      expect.objectContaining({ idempotencyKey: KEY }),
    );
  });

  it('confirmPayment posts to the confirm route and returns the payment status', async () => {
    const post = vi.fn(async () => ({
      data: { paymentStatus: 'AUTHORIZED' },
    })) as ApiClient['post'];
    const svc = new OrdersService(mockClient({ post }));
    const status = await svc.confirmPayment('ord1', KEY);
    expect(status).toBe('AUTHORIZED');
    expect(post).toHaveBeenCalledWith(
      '/v1/orders/ord1/payment/confirm',
      undefined,
      expect.objectContaining({ idempotencyKey: KEY }),
    );
  });

  it('retryTrackedPayment posts the order number and email with the key', async () => {
    const post = vi.fn(async () => ({
      data: { paymentAction: { type: 'embedded', clientToken: 'tok' } },
    })) as ApiClient['post'];
    const svc = new OrdersService(mockClient({ post }));
    const body = { orderNumber: 'ORD-2026-000005', email: 'a@b.co' };
    const action = await svc.retryTrackedPayment(body, KEY);
    expect(action).toEqual({ type: 'embedded', clientToken: 'tok' });
    expect(post).toHaveBeenCalledWith(
      '/v1/orders/track/payment',
      body,
      expect.objectContaining({ idempotencyKey: KEY }),
    );
    await expect(svc.retryTrackedPayment(body, 'nope')).rejects.toThrow();
  });

  it('retryPayment and confirmPayment reject a non-UUID key', async () => {
    const svc = new OrdersService(mockClient({}));
    await expect(svc.retryPayment('ord1', 'nope')).rejects.toThrow();
    await expect(svc.confirmPayment('ord1', 'nope')).rejects.toThrow();
  });
});

describe('OrdersService.list', () => {
  it('returns paginated orders', async () => {
    const get = vi.fn(async () => ({
      data: [fakeOrder],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    })) as ApiClient['get'];
    const svc = new OrdersService(mockClient({ get }));
    const result = await svc.list({ page: 1, pageSize: 20 });
    expect(result.data).toHaveLength(1);
  });
});

describe('OrdersService.track', () => {
  const BODY = { orderNumber: 'ORD-2026-000005', email: 'a@b.co' };

  function trackClient() {
    const post = vi.fn(async () => ({
      data: { orderNumber: 'ORD-2026-000005', status: 'SHIPPED', shipments: [], timeline: [] },
    })) as ApiClient['post'];
    return { post, svc: new OrdersService(mockClient({ post })) };
  }

  it('POSTs the lookup to the collection-level track path', async () => {
    const { post, svc } = trackClient();
    await svc.track(BODY);
    expect(post).toHaveBeenCalledWith('/v1/orders/track', BODY);
  });

  /**
   * Finding K10. The email address is the shared secret that authorises this
   * read, so it must never reach a URL: a query string lands in the access log,
   * the `Referer` header and the browser history.
   */
  it('puts the email in the body and never in the URL', async () => {
    const { post, svc } = trackClient();
    await svc.track(BODY);
    const [url] = (post as unknown as { mock: { calls: [string, unknown][] } }).mock.calls[0];
    expect(url).not.toContain('a@b.co');
    expect(url).not.toContain('email');
    expect(url).not.toContain('?');
  });

  it('rejects an empty order number before issuing a request', async () => {
    const { post, svc } = trackClient();
    await expect(svc.track({ orderNumber: '', email: 'a@b.co' })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects a malformed email before issuing a request', async () => {
    const { post, svc } = trackClient();
    await expect(svc.track({ orderNumber: 'ORD-1', email: 'not-an-email' })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it('returns the parsed tracking payload', async () => {
    const { svc } = trackClient();
    const result = await svc.track(BODY);
    expect(result.orderNumber).toBe('ORD-2026-000005');
    expect(result.timeline).toEqual([]);
  });
});

describe('OrdersService.cancel + invoice + getById', () => {
  it('cancel POSTs to the per-order cancel path', async () => {
    const post = vi.fn(async () => ({
      data: { ...fakeOrder, status: 'CANCELLED' },
    })) as ApiClient['post'];
    const svc = new OrdersService(mockClient({ post }));
    const result = await svc.cancel('ord1');
    expect(post).toHaveBeenCalledWith('/v1/orders/ord1/cancel');
    expect(result.status).toBe('CANCELLED');
  });

  it('invoice GETs invoice path', async () => {
    const get = vi.fn(async () => ({
      data: { orderNumber: 'AKL-0001', issuedAt: '2026', total: 0, currency: 'EUR' },
    })) as ApiClient['get'];
    const svc = new OrdersService(mockClient({ get }));
    await svc.invoice('ord1');
    expect(get).toHaveBeenCalledWith('/v1/orders/ord1/invoice');
  });

  it('getById GETs the order', async () => {
    const get = vi.fn(async () => ({ data: fakeOrder })) as ApiClient['get'];
    const svc = new OrdersService(mockClient({ get }));
    await svc.getById('ord1');
    expect(get).toHaveBeenCalledWith('/v1/orders/ord1');
  });
});

import { provideHttpClient, withFetch } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ADMIN_API_BASE_URL } from '../shared';
import { OrdersService } from './orders.service';
import type { UpdateShipmentRequest } from './orders.schemas';

const ORDER_ID = '34f5c9a4-1a1a-4a4a-8a8a-333333333333';
const SHIPMENT_ID = '44f5c9a4-1a1a-4a4a-8a8a-444444444444';
const ORDER_ITEM_ID = '54f5c9a4-1a1a-4a4a-8a8a-555555555555';
const VARIANT_ID = '04f5c9a4-1a1a-4a4a-8a8a-000000000000';

const orderFixture = {
  id: ORDER_ID,
  status: 'PENDING',
  paymentStatus: 'CAPTURED',
  createdAt: '2026-04-15T12:00:00.000Z',
  updatedAt: '2026-04-15T12:00:00.000Z',
};

describe('OrdersService', () => {
  let service: OrdersService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withFetch()),
        provideHttpClientTesting(),
        { provide: ADMIN_API_BASE_URL, useValue: '/api' },
        OrdersService,
      ],
    });
    service = TestBed.inject(OrdersService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('list() applies status filter', (done) => {
    service.list({ status: 'SHIPPED', page: 1 }).subscribe(() => done());
    const req = http.expectOne((r) => r.url === '/api/v1/admin/orders');
    expect(req.request.params.get('status')).toBe('SHIPPED');
    req.flush({ data: [orderFixture], meta: { page: 1, pageSize: 20, total: 1 } });
  });

  it('create() POSTs an admin manual order with a UUID v4 idempotency key', (done) => {
    service
      .create({
        items: [{ variantId: VARIANT_ID, quantity: 2 }],
        shippingAddress: {
          fullName: 'Aisha',
          phone: '+97455551234',
          addressLine1: 'Building 12',
          city: 'Lyon',
          country: 'QA',
        },
      })
      .subscribe((order) => {
        expect(order.id).toBe(ORDER_ID);
        done();
      });
    const req = http.expectOne('/api/v1/admin/orders');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.items[0].variantId).toBe(VARIANT_ID);
    expect(req.request.headers.get('X-Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    req.flush({ data: orderFixture });
  });

  it('stats() GETs /orders/stats', (done) => {
    service.stats().subscribe((payload) => {
      expect(payload).toEqual({ totalOrders: 12 });
      done();
    });
    const req = http.expectOne('/api/v1/admin/orders/stats');
    expect(req.request.method).toBe('GET');
    req.flush({ data: { totalOrders: 12 } });
  });

  it('exportCsv() requests a Blob response', (done) => {
    service.exportCsv({ status: 'DELIVERED' }).subscribe((blob) => {
      expect(blob instanceof Blob).toBe(true);
      done();
    });
    const req = http.expectOne((r) => r.url === '/api/v1/admin/orders/export');
    expect(req.request.responseType).toBe('blob');
    expect(req.request.params.get('status')).toBe('DELIVERED');
    req.flush(new Blob(['order,id\n1'], { type: 'text/csv' }));
  });

  it('exportCsv() forwards dateFrom / dateTo filters to the query string', (done) => {
    service.exportCsv({ dateFrom: '2026-01-01', dateTo: '2026-02-01' }).subscribe(() => done());
    const req = http.expectOne((r) => r.url === '/api/v1/admin/orders/export');
    expect(req.request.params.get('dateFrom')).toBe('2026-01-01');
    expect(req.request.params.get('dateTo')).toBe('2026-02-01');
    req.flush(new Blob(['id\n'], { type: 'text/csv' }));
  });

  it('get() keeps the billingAddress and invoice the API already returns', (done) => {
    service.get(ORDER_ID).subscribe((order) => {
      expect(order.billingAddress?.city).toBe('Lyon');
      expect(order.invoice?.invoiceNumber).toBe('INV-2026-0007');
      expect(order.shippingAddress?.city).toBe('Al Wakrah');
      done();
    });
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}`);
    req.flush({
      data: {
        ...orderFixture,
        currency: 'EUR',
        shippingAddress: {
          fullName: 'Sara Hassan',
          phone: '+97455551234',
          addressLine1: 'Building 12',
          city: 'Al Wakrah',
          country: 'QA',
        },
        billingAddress: {
          fullName: 'Sara Hassan',
          phone: '+97455551234',
          addressLine1: 'Building 12',
          city: 'Lyon',
          country: 'QA',
        },
        invoice: {
          id: '64f5c9a4-1a1a-4a4a-8a8a-666666666666',
          invoiceNumber: 'INV-2026-0007',
          issuedAt: '2026-04-15T12:00:00.000Z',
        },
      },
    });
  });

  it('getInvoice() GETs /invoice and unwraps the envelope', (done) => {
    service.getInvoice(ORDER_ID).subscribe((payload) => {
      expect(payload).toEqual({ invoiceNumber: 'INV-1' });
      done();
    });
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/invoice`);
    req.flush({ data: { invoiceNumber: 'INV-1' } });
  });

  it('updateStatus() validates against the OrderStatus enum', () => {
    expect(() =>
      service.updateStatus(ORDER_ID, { status: 'NOT_A_STATUS' as never }).subscribe(),
    ).toThrow();
    http.expectNone(`/api/v1/admin/orders/${ORDER_ID}/status`);
  });

  it('updateStatus() PATCHes on the happy path', (done) => {
    service.updateStatus(ORDER_ID, { status: 'CONFIRMED' }).subscribe((order) => {
      expect(order.status).toBe('CONFIRMED');
      done();
    });
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/status`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ status: 'CONFIRMED' });
    req.flush({ data: { ...orderFixture, status: 'CONFIRMED' } });
  });

  it('updateStatus() surfaces 409 on a wrong-state transition', (done) => {
    service.updateStatus(ORDER_ID, { status: 'DELIVERED' }).subscribe({
      next: () => done(new Error('should not succeed')),
      error: (err: HttpErrorResponse) => {
        expect(err.status).toBe(409);
        done();
      },
    });
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/status`);
    req.flush(
      { error: { code: 'CONFLICT', message: 'Invalid status transition' } },
      { status: 409, statusText: 'Conflict' },
    );
  });

  it('edit() accepts add/remove items + discount', (done) => {
    service
      .edit(ORDER_ID, {
        addItems: [{ variantId: VARIANT_ID, quantity: 1 }],
        manualDiscount: 10,
      })
      .subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}`);
    expect(req.request.method).toBe('PATCH');
    req.flush({ data: orderFixture });
  });

  it('edit() accepts removeItems-only branch', (done) => {
    service
      .edit(ORDER_ID, { removeItems: [{ orderItemId: ORDER_ITEM_ID }] })
      .subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}`);
    expect(req.request.body).toEqual({ removeItems: [{ orderItemId: ORDER_ITEM_ID }] });
    req.flush({ data: orderFixture });
  });

  it('edit() accepts internalNotes-only branch', (done) => {
    service.edit(ORDER_ID, { internalNotes: 'VIP customer' }).subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}`);
    expect(req.request.body).toEqual({ internalNotes: 'VIP customer' });
    req.flush({ data: orderFixture });
  });

  it('edit() accepts manualDiscount === 0 (boundary)', (done) => {
    service.edit(ORDER_ID, { manualDiscount: 0 }).subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}`);
    expect(req.request.body).toEqual({ manualDiscount: 0 });
    req.flush({ data: orderFixture });
  });

  it('edit() accepts shippingAddress happy-path', (done) => {
    service
      .edit(ORDER_ID, {
        shippingAddress: {
          fullName: 'Ali',
          phone: '+974123456',
          addressLine1: 'Street',
          city: 'Lyon',
          country: 'QA',
        },
      })
      .subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}`);
    expect(req.request.body.shippingAddress.country).toBe('QA');
    req.flush({ data: orderFixture });
  });

  it('edit() rejects non-ISO country on shippingAddress', () => {
    expect(() =>
      service
        .edit(ORDER_ID, {
          shippingAddress: {
            fullName: 'Ali',
            phone: '+974...',
            addressLine1: 'Street',
            city: 'Lyon',
            country: 'qat',
          },
        })
        .subscribe(),
    ).toThrow();
    http.expectNone(`/api/v1/admin/orders/${ORDER_ID}`);
  });

  it('createShipment() POSTs to /shipments with items', (done) => {
    service
      .createShipment(ORDER_ID, {
        items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1 }],
        carrier: 'DHL',
        trackingNumber: 'DHL1234',
      })
      .subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/shipments`);
    expect(req.request.method).toBe('POST');
    req.flush({ data: { id: SHIPMENT_ID } });
  });

  it('createShipment() rejects an empty items array', () => {
    expect(() =>
      service
        .createShipment(ORDER_ID, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          items: [] as any,
          carrier: 'DHL',
        })
        .subscribe(),
    ).toThrow();
    http.expectNone(`/api/v1/admin/orders/${ORDER_ID}/shipments`);
  });

  it('createShipment() rejects quantity < 1', () => {
    expect(() =>
      service
        .createShipment(ORDER_ID, {
          items: [{ orderItemId: ORDER_ITEM_ID, quantity: 0 }],
        })
        .subscribe(),
    ).toThrow();
    http.expectNone(`/api/v1/admin/orders/${ORDER_ID}/shipments`);
  });

  it('updateShipment() patches carrier only', (done) => {
    service.updateShipment(ORDER_ID, SHIPMENT_ID, { carrier: 'FedEx' }).subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/shipments/${SHIPMENT_ID}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ carrier: 'FedEx' });
    req.flush({ data: { id: SHIPMENT_ID, carrier: 'FedEx' } });
  });

  it('updateShipment() patches trackingNumber only', (done) => {
    service
      .updateShipment(ORDER_ID, SHIPMENT_ID, { trackingNumber: 'TRK-2' })
      .subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/shipments/${SHIPMENT_ID}`);
    expect(req.request.body).toEqual({ trackingNumber: 'TRK-2' });
    req.flush({ data: { id: SHIPMENT_ID, trackingNumber: 'TRK-2' } });
  });

  it('updateShipment() patches status only', (done) => {
    service.updateShipment(ORDER_ID, SHIPMENT_ID, { status: 'SHIPPED' }).subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/shipments/${SHIPMENT_ID}`);
    expect(req.request.body).toEqual({ status: 'SHIPPED' });
    req.flush({ data: { id: SHIPMENT_ID, status: 'SHIPPED' } });
  });

  // == Plan M phase M1: CANCELLED is readable, never writable (finding AD4) ==

  it('get() parses an order whose shipment the cancel cascade left CANCELLED', (done) => {
    // The cascade writes this value, and `orderSchema` embeds the shipment
    // rows, so a response enum that does not know it turns the whole order
    // detail into "Could not load" (the Translatable schema-drift bug class).
    service.get(ORDER_ID).subscribe({
      next: (order) => {
        expect(order.shipments?.[0]?.status).toBe('CANCELLED');
        done();
      },
      error: (err) => done(err),
    });
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}`);
    req.flush({
      data: {
        ...orderFixture,
        status: 'CANCELLED',
        shipments: [
          { id: SHIPMENT_ID, carrier: 'DHL', trackingNumber: 'TRK-1', status: 'CANCELLED' },
        ],
      },
    });
  });

  it('refuses to send CANCELLED as a shipment status', () => {
    // Only the cascade may set it, and the API answers 409 on any attempt to
    // move a row out of it, so the request schema must not accept it at all.
    expect(() =>
      service.updateShipment(ORDER_ID, SHIPMENT_ID, {
        status: 'CANCELLED',
      } as unknown as UpdateShipmentRequest),
    ).toThrow();
    http.expectNone(`/api/v1/admin/orders/${ORDER_ID}/shipments/${SHIPMENT_ID}`);
  });

  it.each([
    ['capturePayment', 'capture'],
    ['refundPayment', 'refund'],
    ['cancelPayment', 'cancel'],
  ] as const)('%s() POSTs /payment/%s with a UUID v4 idempotency key', (method, segment) => {
    let result: unknown;
    service[method](ORDER_ID).subscribe((order) => (result = order));
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/payment/${segment}`);
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.headers.get('X-Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    req.flush({ data: { ...orderFixture, paymentStatus: 'REFUNDED' } });
    expect(result).toMatchObject({ id: ORDER_ID, paymentStatus: 'REFUNDED' });
  });

  it('capturePayment() reuses a caller key so a retry replays the same action', () => {
    service.capturePayment(ORDER_ID, 'key-1').subscribe();
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/payment/capture`);
    expect(req.request.headers.get('X-Idempotency-Key')).toBe('key-1');
    req.flush({ data: orderFixture });
  });

  it('refundPayment() surfaces 409 on a disallowed payment transition', () => {
    let status = 0;
    service.refundPayment(ORDER_ID).subscribe({
      error: (e: HttpErrorResponse) => (status = e.status),
    });
    http
      .expectOne(`/api/v1/admin/orders/${ORDER_ID}/payment/refund`)
      .flush(
        { error: { code: 'PAYMENT_TRANSITION_NOT_ALLOWED' } },
        { status: 409, statusText: 'Conflict' },
      );
    expect(status).toBe(409);
  });

  it('addNote() POSTs the note body', (done) => {
    service.addNote(ORDER_ID, { note: 'follow up' }).subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/orders/${ORDER_ID}/notes`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ note: 'follow up' });
    req.flush({ data: { id: 'note-1' } });
  });
});

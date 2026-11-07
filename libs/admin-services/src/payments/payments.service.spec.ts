import { HttpErrorResponse, provideHttpClient, withFetch } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ADMIN_API_BASE_URL } from '../shared';
import { PaymentMethodsService } from './payments.service';

const methodFixture = {
  id: 'pm-1',
  code: 'stripe_live',
  name: { default: 'Stripe', en: 'Stripe' },
  provider: 'stripe',
  isActive: true,
  isTestMode: false,
  sortOrder: 0,
  config: { apiKey: '***', publishableKey: 'pk_live_xxx' },
};

describe('PaymentMethodsService', () => {
  let service: PaymentMethodsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withFetch()),
        provideHttpClientTesting(),
        { provide: ADMIN_API_BASE_URL, useValue: '/api' },
        PaymentMethodsService,
      ],
    });
    service = TestBed.inject(PaymentMethodsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('list() forwards provider + isActive filters', (done) => {
    service.list({ provider: 'stripe', isActive: true }).subscribe(() => done());
    const req = http.expectOne((r) => r.url === '/api/v1/admin/payment-methods');
    expect(req.request.params.get('provider')).toBe('stripe');
    expect(req.request.params.get('isActive')).toBe('true');
    req.flush({ data: [methodFixture], meta: { page: 1, pageSize: 20, total: 1 } });
  });

  it('get() fetches a single method', (done) => {
    service.get(methodFixture.id).subscribe((m) => {
      expect(m.id).toBe(methodFixture.id);
      done();
    });
    const req = http.expectOne(`/api/v1/admin/payment-methods/${methodFixture.id}`);
    req.flush({ data: methodFixture });
  });

  it('create() rejects an uppercase code via Zod', () => {
    expect(() =>
      service
        .create({
          code: 'STRIPE',
          name: { default: 'Stripe' },
          provider: 'stripe',
        })
        .subscribe(),
    ).toThrow();
    http.expectNone('/api/v1/admin/payment-methods');
  });

  it('create() POSTs a valid body', (done) => {
    service
      .create({ code: 'stripe_live', name: { default: 'Stripe' }, provider: 'stripe' })
      .subscribe((m) => {
        expect(m.code).toBe('stripe_live');
        done();
      });
    const req = http.expectOne('/api/v1/admin/payment-methods');
    expect(req.request.method).toBe('POST');
    req.flush({ data: methodFixture });
  });

  it('update() PATCHes with config merge', (done) => {
    service
      .update(methodFixture.id, { isActive: false, config: { apiKey: '***', flag: true } })
      .subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/payment-methods/${methodFixture.id}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body.config).toEqual({ apiKey: '***', flag: true });
    req.flush({ data: { ...methodFixture, isActive: false } });
  });

  it('delete() hits DELETE', (done) => {
    service.delete(methodFixture.id).subscribe(() => done());
    const req = http.expectOne(`/api/v1/admin/payment-methods/${methodFixture.id}`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('reorder() rejects empty ids via Zod', () => {
    expect(() => service.reorder({ ids: [] }).subscribe()).toThrow();
    http.expectNone('/api/v1/admin/payment-methods/reorder');
  });

  it('reorder() POSTs the ids to the reorder route', (done) => {
    service.reorder({ ids: ['b', 'a'] }).subscribe(() => done());
    const req = http.expectOne('/api/v1/admin/payment-methods/reorder');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.ids).toEqual(['b', 'a']);
    req.flush(null);
  });

  it('list() serialises page + pageSize into query params', (done) => {
    service.list({ page: 2, pageSize: 50 }).subscribe((res) => {
      expect(res.meta.page).toBe(2);
      done();
    });
    const req = http.expectOne((r) => r.url === '/api/v1/admin/payment-methods');
    expect(req.request.params.get('page')).toBe('2');
    expect(req.request.params.get('pageSize')).toBe('50');
    req.flush({ data: [], meta: { page: 2, pageSize: 50, total: 0 } });
  });

  it('list() Zod-rejects pageSize 0', () => {
    expect(() => service.list({ pageSize: 0 }).subscribe()).toThrow();
    http.expectNone('/api/v1/admin/payment-methods');
  });

  it('list() Zod-rejects pageSize > 100', () => {
    expect(() => service.list({ pageSize: 101 }).subscribe()).toThrow();
    http.expectNone('/api/v1/admin/payment-methods');
  });

  it('update() Zod-rejects negative sortOrder', () => {
    expect(() => service.update(methodFixture.id, { sortOrder: -1 }).subscribe()).toThrow();
    http.expectNone(`/api/v1/admin/payment-methods/${methodFixture.id}`);
  });

  it('create() propagates a 409 Conflict as an HTTP error', (done) => {
    service.create({ code: 'taken', name: { default: 'x' }, provider: 'stripe' }).subscribe({
      next: () => done.fail('should have errored'),
      error: (err: HttpErrorResponse) => {
        expect(err.status).toBe(409);
        done();
      },
    });
    const req = http.expectOne('/api/v1/admin/payment-methods');
    req.flush(
      { error: { code: 'CONFLICT', message: 'code in use' } },
      { status: 409, statusText: 'Conflict' },
    );
  });

  it('get() propagates a 404 Not Found', (done) => {
    service.get('missing-id').subscribe({
      next: () => done.fail('should have errored'),
      error: (err: HttpErrorResponse) => {
        expect(err.status).toBe(404);
        done();
      },
    });
    const req = http.expectOne('/api/v1/admin/payment-methods/missing-id');
    req.flush(
      { error: { code: 'NOT_FOUND', message: 'missing' } },
      { status: 404, statusText: 'Not Found' },
    );
  });

  it('update() propagates a 403 Forbidden', (done) => {
    service.update(methodFixture.id, { isActive: false }).subscribe({
      next: () => done.fail('should have errored'),
      error: (err: HttpErrorResponse) => {
        expect(err.status).toBe(403);
        done();
      },
    });
    const req = http.expectOne(`/api/v1/admin/payment-methods/${methodFixture.id}`);
    req.flush(
      { error: { code: 'FORBIDDEN', message: 'nope' } },
      { status: 403, statusText: 'Forbidden' },
    );
  });

  it('delete() propagates a 404 Not Found', (done) => {
    service.delete('missing-id').subscribe({
      next: () => done.fail('should have errored'),
      error: (err: HttpErrorResponse) => {
        expect(err.status).toBe(404);
        done();
      },
    });
    const req = http.expectOne('/api/v1/admin/payment-methods/missing-id');
    req.flush(
      { error: { code: 'NOT_FOUND', message: 'missing' } },
      { status: 404, statusText: 'Not Found' },
    );
  });

  it('reorder() propagates a 400 duplicate-ids from the backend', (done) => {
    service.reorder({ ids: ['a', 'a'] }).subscribe({
      next: () => done.fail('should have errored'),
      error: (err: HttpErrorResponse) => {
        expect(err.status).toBe(400);
        done();
      },
    });
    const req = http.expectOne('/api/v1/admin/payment-methods/reorder');
    req.flush(
      { error: { code: 'BAD_REQUEST', message: 'duplicate ids' } },
      { status: 400, statusText: 'Bad Request' },
    );
  });

  describe('providers()', () => {
    const canary = {
      id: 'canary_pay',
      label: 'Canary Pay',
      actionTypes: ['redirect'],
      secretFields: ['merchantPassword'],
      configJsonSchema: {
        type: 'object',
        properties: { merchantId: { type: 'string' }, merchantPassword: { type: 'string' } },
        required: ['merchantId'],
      },
    };

    it('fetches the provider catalogue', (done) => {
      service.providers().subscribe((entries) => {
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('canary_pay');
        expect(entries[0].secretFields).toEqual(['merchantPassword']);
        done();
      });
      http.expectOne('/api/v1/admin/payment-providers').flush({ data: [canary] });
    });

    it('accepts a provider id the admin has never heard of in a method', (done) => {
      service.get('pm-9').subscribe((m) => {
        expect(m.provider).toBe('canary_pay');
        done();
      });
      http
        .expectOne('/api/v1/admin/payment-methods/pm-9')
        .flush({ data: { ...methodFixture, id: 'pm-9', provider: 'canary_pay' } });
    });

    it('accepts an unknown provider id on create', () => {
      service
        .create({ code: 'canary', name: { default: 'Canary' }, provider: 'canary_pay' })
        .subscribe();
      http.expectOne('/api/v1/admin/payment-methods').flush({
        data: { ...methodFixture, provider: 'canary_pay' },
      });
    });
  });

  it('reorder() propagates a 404 when ids are unknown', (done) => {
    service.reorder({ ids: ['xxx'] }).subscribe({
      next: () => done.fail('should have errored'),
      error: (err: HttpErrorResponse) => {
        expect(err.status).toBe(404);
        done();
      },
    });
    const req = http.expectOne('/api/v1/admin/payment-methods/reorder');
    req.flush(
      { error: { code: 'NOT_FOUND', message: 'unknown id' } },
      { status: 404, statusText: 'Not Found' },
    );
  });
});

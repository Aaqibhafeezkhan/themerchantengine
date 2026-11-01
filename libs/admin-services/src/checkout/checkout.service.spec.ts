import { provideHttpClient, withFetch } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ZodError } from 'zod';
import { ADMIN_API_BASE_URL } from '../shared';
import { CheckoutSettingsService } from './checkout.service';

const settingsFixture = {
  guestCheckoutEnabled: true,
  requiredFields: ['email', 'phone'],
  termsOfServiceUrl: 'https://example.com/tos',
  postPurchaseRedirectUrl: null,
  checkoutMessage: null,
};

describe('CheckoutSettingsService', () => {
  let service: CheckoutSettingsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withFetch()),
        provideHttpClientTesting(),
        { provide: ADMIN_API_BASE_URL, useValue: '/api' },
        CheckoutSettingsService,
      ],
    });
    service = TestBed.inject(CheckoutSettingsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('get() fetches the settings envelope', (done) => {
    service.get().subscribe((s) => {
      expect(s.guestCheckoutEnabled).toBe(true);
      expect(s.requiredFields).toEqual(['email', 'phone']);
      done();
    });
    const req = http.expectOne('/api/v1/admin/checkout/settings');
    expect(req.request.method).toBe('GET');
    req.flush({ data: settingsFixture });
  });

  it('update() rejects an invalid URL via Zod', () => {
    const next = jest.fn();
    const error = jest.fn();
    expect(() =>
      service.update({ termsOfServiceUrl: 'not-a-url' }).subscribe({ next, error }),
    ).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(ZodError));
    http.expectNone('/api/v1/admin/checkout/settings');
  });

  it('update() PATCHes only the supplied keys', (done) => {
    service.update({ guestCheckoutEnabled: false }).subscribe(() => done());
    const req = http.expectOne('/api/v1/admin/checkout/settings');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ guestCheckoutEnabled: false });
    req.flush({ data: { ...settingsFixture, guestCheckoutEnabled: false } });
  });
});

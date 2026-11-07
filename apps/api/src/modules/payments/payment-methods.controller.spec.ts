import { ADMIN_API_ROUTES } from '@admin-routes';
import { PaymentMethodsController } from './payment-methods.controller';
import type { PaymentMethodsService } from './payment-methods.service';

describe('PaymentMethodsController providers catalogue', () => {
  it('serves the registry catalogue through the service', () => {
    const entries = [
      {
        id: 'canary_pay',
        label: 'Canary Pay',
        actionTypes: ['redirect'],
        secretFields: ['merchantPassword'],
        configJsonSchema: { type: 'object' },
      },
    ];
    const service = { providerCatalogue: jest.fn().mockReturnValue(entries) };
    const controller = new PaymentMethodsController(service as unknown as PaymentMethodsService);

    expect(controller.providers()).toBe(entries);
  });

  it('keeps the route constant the admin client reads', () => {
    expect(ADMIN_API_ROUTES.paymentMethods.providers).toBe('payment-providers');
  });

  it('guards the route with the payment methods view permission', () => {
    const permissions = Reflect.getMetadata(
      'permissions',
      PaymentMethodsController.prototype.providers,
    );
    expect(permissions).toEqual(['payment_methods:view']);
  });
});

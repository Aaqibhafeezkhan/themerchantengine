import { ApiConflictError, ApiForbiddenError } from '@admin-types';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OrdersService, type Order } from '@admin-services';
import * as adminUi from '@admin-ui';
import { axe, toHaveNoViolations } from 'jest-axe';
import { of, throwError } from 'rxjs';
import { OrderPaymentActionsComponent } from './order-payment-actions.component';

expect.extend(toHaveNoViolations);

@Component({
  standalone: true,
  imports: [OrderPaymentActionsComponent],
  template: `
    <app-order-payment-actions
      [order]="order()"
      [canManage]="canManage()"
      (orderChanged)="lastChange = $event"
    />
  `,
})
class Host {
  readonly order = signal<Order>({
    id: 'order-1',
    orderNumber: 'ORD-2026-000001',
    status: 'CONFIRMED',
    paymentStatus: 'AUTHORIZED',
    total: 100,
    currency: 'USD',
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
  });
  readonly canManage = signal(true);
  lastChange: Order | null = null;
}

describe('OrderPaymentActionsComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let capture: jest.Mock;
  let refund: jest.Mock;
  let cancel: jest.Mock;
  let confirmSpy: jest.SpyInstance;

  const q = (id: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid=${id}]`);

  function configure(paymentStatus: Order['paymentStatus'] = 'AUTHORIZED') {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: OrdersService,
          useValue: { capturePayment: capture, refundPayment: refund, cancelPayment: cancel },
        },
      ],
    });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    host.order.update((o) => ({ ...o, paymentStatus }));
    fixture.detectChanges();
  }

  async function click(id: string): Promise<void> {
    (q(id)?.querySelector('button') ?? (q(id) as HTMLElement)).click();
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  }

  beforeEach(() => {
    capture = jest.fn(() => of({ id: 'order-1', paymentStatus: 'CAPTURED' }));
    refund = jest.fn(() => of({ id: 'order-1', paymentStatus: 'REFUNDED' }));
    cancel = jest.fn(() => of({ id: 'order-1', paymentStatus: 'CANCELLED' }));
    confirmSpy = jest.spyOn(adminUi, 'openConfirmDialog').mockResolvedValue(true);
  });

  afterEach(() => confirmSpy.mockRestore());

  it('renders nothing without payments:manage', () => {
    configure('AUTHORIZED');
    host.canManage.set(false);
    fixture.detectChanges();
    expect(q('order-payment-actions')).toBeNull();
  });

  it('renders nothing when the payment status offers no action', () => {
    configure('REFUNDED');
    expect(q('order-payment-actions')).toBeNull();
  });

  it.each([
    ['AUTHORIZED', ['capture', 'void']],
    ['CAPTURED', ['refund']],
    ['PENDING', ['void']],
  ] as const)('%s offers %j', (status, ids) => {
    configure(status);
    for (const id of ['capture', 'refund', 'void']) {
      expect(q(`order-payment-${id}`) !== null).toBe((ids as readonly string[]).includes(id));
    }
  });

  it('captures after confirmation and emits the returned order', async () => {
    configure('AUTHORIZED');
    await click('order-payment-capture');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('order-1');
    expect(host.lastChange).toMatchObject({ paymentStatus: 'CAPTURED' });
  });

  it('refunds with a destructive confirmation', async () => {
    configure('CAPTURED');
    await click('order-payment-refund');
    expect(confirmSpy.mock.calls[0][1]).toMatchObject({ tone: 'destructive' });
    expect(refund).toHaveBeenCalledWith('order-1');
    expect(host.lastChange).toMatchObject({ paymentStatus: 'REFUNDED' });
  });

  it('voids the payment', async () => {
    configure('PENDING');
    await click('order-payment-void');
    expect(cancel).toHaveBeenCalledWith('order-1');
  });

  it('does nothing when the confirmation is dismissed', async () => {
    confirmSpy.mockResolvedValue(false);
    configure('AUTHORIZED');
    await click('order-payment-capture');
    expect(capture).not.toHaveBeenCalled();
    expect(host.lastChange).toBeNull();
  });

  it('shows the API reason on a 409 and keeps the order unchanged', async () => {
    capture.mockReturnValue(
      throwError(
        () =>
          new ApiConflictError({
            code: 'PAYMENT_TRANSITION_NOT_ALLOWED',
            message: 'Cannot capture a payment that is CAPTURED.',
          }),
      ),
    );
    configure('AUTHORIZED');
    await click('order-payment-capture');
    expect(q('order-payment-error')?.textContent).toContain('Cannot capture');
    expect(host.lastChange).toBeNull();
  });

  it('maps a 403 to a permission message', async () => {
    refund.mockReturnValue(
      throwError(() => new ApiForbiddenError({ code: 'FORBIDDEN', message: 'nope' })),
    );
    configure('CAPTURED');
    await click('order-payment-refund');
    expect(q('order-payment-error')?.textContent).toContain('permission');
  });

  it('falls back to a generic message for an unknown failure', async () => {
    cancel.mockReturnValue(throwError(() => new Error('boom')));
    configure('PENDING');
    await click('order-payment-void');
    expect(q('order-payment-error')?.textContent).toContain('Could not void');
  });

  it('has no axe violations', async () => {
    configure('AUTHORIZED');
    expect(await axe(fixture.nativeElement)).toHaveNoViolations();
  });
});

import {
  EDITABLE_ORDER_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  canCancelOrder,
  canEditOrder,
  formatMoney,
  legalNextStatuses,
  manualStatusOptions,
  orderStatusTone,
  paymentActionsFor,
  paymentStatusTone,
  shipmentStatusLabel,
} from './orders.utils';

describe('orders.utils', () => {
  // Mirror pin: this literal is copied from
  // apps/api/src/modules/orders/orders.constants.ts STATUS_TRANSITIONS.
  // When this test fails, update apps/api/src/modules/orders/orders.constants.ts
  // and this mirror together — one of them has drifted.
  describe('ORDER_STATUS_TRANSITIONS', () => {
    it('matches the backend state machine exactly', () => {
      expect(ORDER_STATUS_TRANSITIONS).toEqual({
        PENDING: ['CONFIRMED', 'CANCELLED'],
        CONFIRMED: ['PROCESSING', 'CANCELLED'],
        PROCESSING: ['ON_HOLD', 'SHIPPED', 'CANCELLED'],
        ON_HOLD: ['PROCESSING'],
        SHIPPED: ['DELIVERED'],
        DELIVERED: ['COMPLETED', 'RETURNED'],
        COMPLETED: [],
        CANCELLED: [],
        RETURN_REQUESTED: [],
        RETURNED: [],
      });
    });

    it('mirrors EDITABLE_STATUSES from the same backend file', () => {
      expect(EDITABLE_ORDER_STATUSES).toEqual(['PENDING', 'CONFIRMED', 'PROCESSING', 'ON_HOLD']);
    });
  });

  describe('legalNextStatuses', () => {
    it('returns the backend-allowed transitions', () => {
      expect(legalNextStatuses('PENDING')).toEqual(['CONFIRMED', 'CANCELLED']);
      expect(legalNextStatuses('DELIVERED')).toEqual(['COMPLETED', 'RETURNED']);
    });

    it('treats terminal and unknown statuses as dead ends', () => {
      expect(legalNextStatuses('COMPLETED')).toEqual([]);
      expect(legalNextStatuses('REFUNDED')).toEqual([]);
      expect(legalNextStatuses(null)).toEqual([]);
    });
  });

  describe('canCancelOrder', () => {
    it('is true only where the backend accepts a move to CANCELLED', () => {
      expect(canCancelOrder('PENDING')).toBe(true);
      expect(canCancelOrder('CONFIRMED')).toBe(true);
      expect(canCancelOrder('PROCESSING')).toBe(true);
    });

    it('is false for post-shipment and terminal statuses (QA C3)', () => {
      for (const status of ['SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'RETURNED']) {
        expect(canCancelOrder(status)).toBe(false);
      }
    });
  });

  describe('canEditOrder', () => {
    it('mirrors the backend ORDER_UNEDITABLE_STATUS guard', () => {
      expect(canEditOrder('CONFIRMED')).toBe(true);
      expect(canEditOrder('ON_HOLD')).toBe(true);
      expect(canEditOrder('DELIVERED')).toBe(false);
      expect(canEditOrder('SHIPPED')).toBe(false);
      expect(canEditOrder(null)).toBe(false);
    });
  });

  describe('manualStatusOptions', () => {
    it('offers the current status plus the legal next ones', () => {
      expect(manualStatusOptions('PENDING')).toEqual(['PENDING', 'CONFIRMED']);
      expect(manualStatusOptions('SHIPPED')).toEqual(['SHIPPED', 'DELIVERED']);
      expect(manualStatusOptions('DELIVERED')).toEqual(['DELIVERED', 'COMPLETED']);
    });

    it('leaves CANCELLED to the cancel button and RETURNED to the returns flow', () => {
      expect(manualStatusOptions('PROCESSING')).toEqual(['PROCESSING', 'ON_HOLD', 'SHIPPED']);
      expect(manualStatusOptions('DELIVERED')).not.toContain('RETURNED');
    });

    it('offers nothing but the current status in a terminal state', () => {
      expect(manualStatusOptions('COMPLETED')).toEqual(['COMPLETED']);
      expect(manualStatusOptions('CANCELLED')).toEqual(['CANCELLED']);
    });
  });
  describe('shipmentStatusLabel', () => {
    it('humanizes the ShipmentStatus enum', () => {
      expect(shipmentStatusLabel('PROCESSING')).toBe('Processing');
      expect(shipmentStatusLabel('SHIPPED')).toBe('Shipped');
      expect(shipmentStatusLabel('DELIVERED')).toBe('Delivered');
    });

    it('returns the em-dash placeholder for nullish statuses', () => {
      expect(shipmentStatusLabel(null)).toBe('—');
      expect(shipmentStatusLabel(undefined)).toBe('—');
    });
  });

  describe('orderStatusTone', () => {
    it('maps terminal success + failure statuses to the correct tones', () => {
      expect(orderStatusTone('DELIVERED')).toBe('success');
      expect(orderStatusTone('CANCELLED')).toBe('error');
      expect(orderStatusTone('REFUNDED')).toBe('error');
    });

    it('maps in-flight statuses to info/warning', () => {
      expect(orderStatusTone('PENDING')).toBe('warning');
      expect(orderStatusTone('CONFIRMED')).toBe('info');
      expect(orderStatusTone('SHIPPED')).toBe('info');
    });

    it('falls back to neutral for unknown statuses', () => {
      expect(orderStatusTone('UNKNOWN')).toBe('neutral');
    });
  });

  describe('paymentStatusTone', () => {
    it('treats CAPTURED as success and all negative states as error', () => {
      expect(paymentStatusTone('CAPTURED')).toBe('success');
      expect(paymentStatusTone('FAILED')).toBe('error');
      expect(paymentStatusTone('CANCELLED')).toBe('error');
      expect(paymentStatusTone('PARTIALLY_REFUNDED')).toBe('error');
    });

    it('handles undefined with the neutral fallback', () => {
      expect(paymentStatusTone(undefined)).toBe('neutral');
    });
  });

  describe('formatMoney', () => {
    it('formats a number with the given currency', () => {
      expect(formatMoney(1234.5, 'USD')).toBe('USD 1,234.50');
    });

    it('coerces string input (Prisma.Decimal wire shape)', () => {
      expect(formatMoney('289', 'EUR')).toBe('EUR 289.00');
    });

    it('returns the em-dash placeholder for nullish values', () => {
      expect(formatMoney(null, 'USD')).toBe('—');
      expect(formatMoney(undefined, 'USD')).toBe('—');
      expect(formatMoney(Number.NaN, 'USD')).toBe('—');
    });

    it('falls back to a raw string when Intl cannot format the ISO code', () => {
      expect(formatMoney(10, 'ZZZ')).toMatch(/10/);
    });
  });
});

describe('paymentActionsFor', () => {
  it.each([
    ['PENDING', ['cancel']],
    ['AUTHORIZED', ['capture', 'cancel']],
    ['CAPTURED', ['refund']],
    ['PARTIALLY_REFUNDED', []],
    ['REFUNDED', []],
    ['FAILED', []],
    ['CANCELLED', []],
    [undefined, []],
  ])('%s offers %j', (status, expected) => {
    expect(paymentActionsFor(status)).toEqual(expected);
  });
});

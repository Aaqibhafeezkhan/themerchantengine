import type { BadgeTone } from '@admin-ui';
import type { OrderStatus, OrderUser } from '@admin-services';
import { humanizeCode } from '../../shared/format/enum-label';
import { formatMoney as sharedFormatMoney } from '../../shared/format/money';

/**
 * Client mirror of the backend order state machine.
 *
 * Source of truth: `apps/api/src/modules/orders/orders.constants.ts`
 * (`STATUS_TRANSITIONS` and `EDITABLE_STATUSES`). Change one, change the other:
 * `orders.utils.spec.ts` pins this literal and fails naming both files.
 *
 * Without it the admin offered transitions the API rejects (cancel on a
 * DELIVERED order) and hid ones it accepts (PROCESSING to ON_HOLD), so the
 * operator only learned the rules by clicking through a destructive confirm.
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<Record<string, readonly OrderStatus[]>> = {
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
};

/** Statuses the backend still lets an operator edit (`ORDER_UNEDITABLE_STATUS`). */
export const EDITABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'ON_HOLD',
];

export function legalNextStatuses(status: string | null | undefined): readonly OrderStatus[] {
  return status ? (ORDER_STATUS_TRANSITIONS[status] ?? []) : [];
}

export function canCancelOrder(status: string | null | undefined): boolean {
  return legalNextStatuses(status).includes('CANCELLED');
}

export function canEditOrder(status: string | null | undefined): boolean {
  return !!status && EDITABLE_ORDER_STATUSES.includes(status as OrderStatus);
}

/**
 * What the status dropdown may offer: the current status plus the legal next
 * ones. CANCELLED is left to the dedicated cancel button (one path per action)
 * and RETURNED to the returns flow, which owns closing a return; offering it
 * manually would let the order status and the return record diverge.
 */
export function manualStatusOptions(status: string | null | undefined): readonly OrderStatus[] {
  const current = status ? [status as OrderStatus] : [];
  const next = legalNextStatuses(status).filter((s) => s !== 'CANCELLED' && s !== 'RETURNED');
  return [...current, ...next];
}

/** Friendly label for the `OrderStatus` enum (e.g. SHIPPED → "Shipped"). */
export function orderStatusLabel(status: string | null | undefined): string {
  return humanizeCode(status);
}

/** Friendly label for the `PaymentStatus` enum (e.g. PARTIALLY_REFUNDED → "Partially Refunded"). */
export function paymentStatusLabel(status: string | null | undefined): string {
  return humanizeCode(status);
}

/** Friendly label for the `ShipmentStatus` enum (e.g. PROCESSING → "Processing"). */
export function shipmentStatusLabel(status: string | null | undefined): string {
  return humanizeCode(status);
}

/**
 * Readable customer label from the joined order `user` ({ firstName, lastName,
 * email }) — never the raw `userId` UUID. Returns "Guest" for guest orders that
 * carry no user.
 */
export function customerLabel(user: OrderUser | null | undefined): string {
  if (!user) return 'Guest';
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.email || 'Guest';
}

/** Maps `OrderStatus` + `PaymentStatus` enums to brand-approved badge tones. */
export function orderStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'DELIVERED':
      return 'success';
    case 'SHIPPED':
    case 'PROCESSING':
      return 'info';
    case 'CONFIRMED':
      return 'info';
    case 'PENDING':
      return 'warning';
    case 'CANCELLED':
    case 'REFUNDED':
      return 'error';
    default:
      return 'neutral';
  }
}

export function paymentStatusTone(status: string | undefined): BadgeTone {
  switch (status) {
    case 'CAPTURED':
      return 'success';
    case 'AUTHORIZED':
      return 'info';
    case 'PENDING':
      return 'warning';
    case 'FAILED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
    case 'CANCELLED':
      return 'error';
    default:
      return 'neutral';
  }
}

/**
 * Money in the currency recorded on the row. Delegates to the one shared
 * formatter (`shared/format/money`); the local Intl copy this replaced carried
 * its own dollar default, which is how a euro store rendered dollars.
 */
export function formatMoney(
  value: number | string | null | undefined,
  currency: string | null | undefined,
): string {
  return sharedFormatMoney(value, currency);
}

export type PaymentAction = 'capture' | 'refund' | 'cancel';

/**
 * Payment actions an admin may start from the order's payment status. Mirrors
 * the API transition rules; the API stays the authority and answers 409 on
 * anything else (offline methods and orders with no payment session included).
 * Refund is full only, so a partial refund offers nothing further.
 */
export function paymentActionsFor(status: string | undefined): readonly PaymentAction[] {
  switch (status) {
    case 'PENDING':
      return ['cancel'];
    case 'AUTHORIZED':
      return ['capture', 'cancel'];
    case 'CAPTURED':
      return ['refund'];
    default:
      return [];
  }
}

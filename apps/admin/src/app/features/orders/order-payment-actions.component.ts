import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ButtonComponent, openConfirmDialog } from '@admin-ui';
import { OrdersService, type Order } from '@admin-services';
import { ApiConflictError, ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { paymentActionsFor, type PaymentAction } from './orders.utils';

interface ActionCopy {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly tone: 'neutral' | 'destructive';
  readonly fallback: string;
}

const COPY: Record<PaymentAction, ActionCopy> = {
  capture: {
    title: 'Capture this payment?',
    body: 'The authorized amount will be charged to the customer.',
    confirmLabel: 'Capture payment',
    tone: 'neutral',
    fallback: 'Could not capture the payment.',
  },
  refund: {
    title: 'Refund this payment in full?',
    body: 'The whole amount goes back to the customer. A pending order is cancelled too. This cannot be undone.',
    confirmLabel: 'Refund payment',
    tone: 'destructive',
    fallback: 'Could not refund the payment.',
  },
  cancel: {
    title: 'Void this payment?',
    body: 'The payment is released and the customer is not charged.',
    confirmLabel: 'Void payment',
    tone: 'destructive',
    fallback: 'Could not void the payment.',
  },
};

/**
 * Card payment actions on the order detail Payment card: capture, full
 * refund and void. Needs `payments:manage` (the parent passes `canManage`).
 * Only the actions the API accepts for the current payment status are
 * shown; the API still answers 409 on a stale view.
 */
@Component({
  selector: 'app-order-payment-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent],
  template: `
    @if (visible()) {
      <div class="border-t border-line pt-4 space-y-3" data-testid="order-payment-actions">
        <div class="flex flex-wrap gap-2">
          @if (actions().includes('capture')) {
            <app-button
              size="sm"
              [disabled]="busy()"
              [loading]="running() === 'capture'"
              (clicked)="run('capture')"
              data-testid="order-payment-capture"
            >
              Capture payment
            </app-button>
          }
          @if (actions().includes('refund')) {
            <app-button
              variant="destructive"
              size="sm"
              [disabled]="busy()"
              [loading]="running() === 'refund'"
              (clicked)="run('refund')"
              data-testid="order-payment-refund"
            >
              Refund in full
            </app-button>
          }
          @if (actions().includes('cancel')) {
            <app-button
              variant="destructive"
              size="sm"
              [disabled]="busy()"
              [loading]="running() === 'cancel'"
              (clicked)="run('cancel')"
              data-testid="order-payment-void"
            >
              Void payment
            </app-button>
          }
        </div>
        <p class="text-sm text-danger" role="alert" data-testid="order-payment-error">
          @if (error(); as message) {
            {{ message }}
          }
        </p>
      </div>
    }
  `,
})
export class OrderPaymentActionsComponent {
  private readonly ordersService = inject(OrdersService);
  private readonly dialog = inject(Dialog);

  readonly order = input.required<Order>();
  readonly canManage = input<boolean>(false);
  readonly orderChanged = output<Order>();

  readonly running = signal<PaymentAction | null>(null);
  readonly error = signal<string | null>(null);

  readonly busy = computed(() => this.running() !== null);
  readonly actions = computed(() => paymentActionsFor(this.order().paymentStatus));
  readonly visible = computed(() => this.canManage() && this.actions().length > 0);

  async run(action: PaymentAction): Promise<void> {
    if (this.busy()) return;
    const copy = COPY[action];
    const ok = await openConfirmDialog(this.dialog, {
      title: copy.title,
      body: copy.body,
      confirmLabel: copy.confirmLabel,
      tone: copy.tone,
    });
    if (!ok) return;

    this.running.set(action);
    this.error.set(null);
    const id = this.order().id;
    const call$ =
      action === 'capture'
        ? this.ordersService.capturePayment(id)
        : action === 'refund'
          ? this.ordersService.refundPayment(id)
          : this.ordersService.cancelPayment(id);
    call$.subscribe({
      next: (updated) => {
        this.running.set(null);
        this.orderChanged.emit(updated);
      },
      error: (err: unknown) => {
        this.running.set(null);
        this.error.set(this.formatError(err, copy.fallback));
      },
    });
  }

  private formatError(err: unknown, fallback: string): string {
    if (err instanceof ApiForbiddenError) return 'You do not have permission to manage payments.';
    if (err instanceof ApiNotFoundError) return 'Order not found.';
    if (err instanceof ApiConflictError && !err.message)
      return 'The payment cannot move from its current state.';
    if (err instanceof ApiError && err.message) return err.message;
    return fallback;
  }
}

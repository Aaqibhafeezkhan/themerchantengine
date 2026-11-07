import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  inject,
  input,
  Output,
} from '@angular/core';

import type { Address } from '@storefront-types';

import { LocaleService } from '../../locale.service';

@Component({
  selector: 'app-address-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article
      class="card"
      [class.is-default]="isDefault()"
      [attr.data-testid]="'address-card-' + address().id"
      data-testid-shared="address-card"
    >
      <header class="header">
        <h3 class="name">
          {{ address().fullName }}
          @if (isDefault()) {
            <span class="badge" data-testid="address-card-default-badge">
              {{ strings().account.addresses.card.defaultBadge }}
            </span>
          }
        </h3>
      </header>
      <p class="line">{{ formatLine() }}</p>
      <p class="line">
        <bdi dir="ltr">{{ address().phone }}</bdi>
      </p>

      <div class="actions">
        <button
          type="button"
          class="btn"
          [attr.data-testid]="'address-card-edit-' + address().id"
          (click)="edit.emit(address())"
        >
          {{ strings().account.addresses.card.editCta }}
        </button>
        <button
          type="button"
          class="btn"
          [attr.data-testid]="'address-card-delete-' + address().id"
          (click)="remove.emit(address())"
          [disabled]="busy()"
        >
          {{ strings().account.addresses.card.deleteCta }}
        </button>
        @if (!isDefault()) {
          <button
            type="button"
            class="btn"
            [attr.data-testid]="'address-card-set-default-' + address().id"
            (click)="setDefault.emit(address())"
            [disabled]="busy()"
          >
            {{ strings().account.addresses.card.setDefaultCta }}
          </button>
        }
      </div>
    </article>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        padding-block: 1rem;
        padding-inline: 1rem;
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
        background-color: var(--brand-surface);
      }
      .card.is-default {
        border-color: var(--brand-primary);
      }
      .header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .name {
        margin: 0;
        font-family: var(--brand-font-display); /* agent_docs/storefront/brand-tokens.md subtitle */
        font-size: var(--brand-text-product);
        font-weight: 500;
        color: var(--brand-text);
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
      }
      .badge {
        font-size: var(--brand-text-micro);
        font-weight: 600;
        padding-block: 0.125rem;
        padding-inline: 0.5rem;
        color: var(--brand-primary);
        border: 1px solid currentColor;
        border-radius: var(--brand-radius-sm);
      }
      .line {
        margin: 0;
        color: var(--brand-text-muted);
        font-size: var(--brand-text-body);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-block-start: 0.5rem;
      }
      .btn {
        background: transparent;
        border: 1px solid var(--brand-border);
        color: var(--brand-text);
        padding-block: 0.375rem;
        padding-inline: 0.75rem;
        border-radius: var(--brand-radius-sm);
        font: inherit;
        font-size: var(--brand-text-micro);
        cursor: pointer;
        min-block-size: 36px;
      }
      .btn:hover:not(:disabled) {
        border-color: var(--brand-primary);
        color: var(--brand-primary);
      }
      .btn:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    `,
  ],
})
export class AddressCardComponent {
  readonly address = input.required<Address>();
  readonly busy = input<boolean>(false);

  @Output() readonly edit = new EventEmitter<Address>();
  @Output() readonly remove = new EventEmitter<Address>();
  @Output() readonly setDefault = new EventEmitter<Address>();

  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;

  protected isDefault(): boolean {
    return this.address().isDefaultShipping === true;
  }

  protected formatLine(): string {
    const a = this.address();
    return [
      a.addressLine1,
      a.addressLine2 ?? null,
      a.city,
      a.state ?? null,
      a.postalCode ?? null,
      a.country,
    ]
      .filter((p): p is string => !!p && p.length > 0)
      .join(', ');
  }
}

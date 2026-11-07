import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  inject,
  input,
  OnChanges,
  Output,
  signal,
  SimpleChanges,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';

import {
  updateNotificationPreferencesRequestSchema,
  type NotificationPreferences,
  type UpdateNotificationPreferencesRequest,
} from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { ButtonComponent } from '../../ui/button.component';

@Component({
  selector: 'app-preferences-form',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="form"
      [formGroup]="form"
      (ngSubmit)="onSubmit()"
      (change)="onEdit()"
      novalidate
      data-testid="account-preferences-form"
    >
      <fieldset class="group">
        <legend class="sr-only">{{ t().heading }}</legend>

        <label class="row" [attr.data-testid]="'pref-row-LIFECYCLE'">
          <input
            type="checkbox"
            formControlName="lifecycleEmail"
            data-testid="pref-toggle-LIFECYCLE"
          />
          <span class="copy">
            <span class="label">{{ t().categories.LIFECYCLE.label }}</span>
            <span class="desc">{{ t().categories.LIFECYCLE.description }}</span>
          </span>
        </label>

        <label class="row" [attr.data-testid]="'pref-row-MARKETING'">
          <input
            type="checkbox"
            formControlName="marketingEmail"
            data-testid="pref-toggle-MARKETING"
          />
          <span class="copy">
            <span class="label">{{ t().categories.MARKETING.label }}</span>
            <span class="desc">{{ t().categories.MARKETING.description }}</span>
          </span>
        </label>
      </fieldset>

      <div class="always-on" data-testid="account-preferences-alwayson">
        <span class="label">{{ t().alwaysOnLabel }}</span>
        <span class="desc">{{ t().alwaysOnHint }}</span>
      </div>

      @if (formError()) {
        <p class="form-error" role="alert" data-testid="account-preferences-form-error">
          {{ formError() }}
        </p>
      }

      <div class="actions">
        <app-button
          type="submit"
          variant="primary"
          [loading]="saving()"
          testId="account-preferences-form-submit"
        >
          {{ saving() ? t().saving : t().save }}
        </app-button>
      </div>
    </form>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .group {
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-sm);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin: 0;
        padding: 1rem;
      }
      .row {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        cursor: pointer;
      }
      .row input {
        margin-block-start: 0.2rem;
        inline-size: 1.1rem;
        block-size: 1.1rem;
        flex: none;
      }
      .row input:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .copy {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      .label {
        color: var(--brand-text);
        font-size: var(--brand-text-body);
      }
      .desc {
        color: var(--brand-text-muted);
        font-size: var(--brand-text-micro);
      }
      .always-on {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        padding: 0.75rem 1rem;
        background-color: var(--brand-surface-strong);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-sm);
      }
      .form-error {
        margin: 0;
        color: var(--brand-error);
      }
      .actions {
        display: flex;
      }
      .sr-only {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class PreferencesFormComponent implements OnChanges {
  readonly preferences = input<NotificationPreferences | null>(null);
  readonly saving = input<boolean>(false);
  readonly externalError = input<string | null>(null);

  @Output() readonly submit = new EventEmitter<UpdateNotificationPreferencesRequest>();
  @Output() readonly edited = new EventEmitter<void>();

  private readonly fb = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  protected readonly t = () => this.locale.strings().account.preferences;

  protected readonly formError = signal<string | null>(null);

  protected readonly form: FormGroup = this.fb.nonNullable.group({
    lifecycleEmail: [false],
    marketingEmail: [false],
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['preferences']) {
      const p = this.preferences();
      if (p) {
        this.form.reset({
          lifecycleEmail: p.LIFECYCLE?.email ?? false,
          marketingEmail: p.MARKETING?.email ?? false,
        });
      }
    }
    if (changes['externalError']) {
      this.formError.set(this.externalError());
    }
  }

  // A DOM event, not valueChanges: form.reset after a save would also emit and wipe the fresh banner.
  protected onEdit(): void {
    this.formError.set(null);
    this.edited.emit();
  }

  protected onSubmit(): void {
    if (this.saving()) return;
    const raw = this.form.getRawValue() as { lifecycleEmail: boolean; marketingEmail: boolean };
    const payload = {
      LIFECYCLE: { email: raw.lifecycleEmail },
      MARKETING: { email: raw.marketingEmail },
    };
    const parsed = updateNotificationPreferencesRequestSchema.safeParse(payload);
    if (!parsed.success) {
      this.formError.set(this.t().error);
      return;
    }
    this.formError.set(null);
    this.submit.emit(parsed.data);
  }
}

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
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import {
  updateProfileRequestSchema,
  type CustomerUser,
  type UpdateProfileRequest,
} from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { ButtonComponent } from '../../ui/button.component';
import { PHONE_RE } from '../../../lib/phone';

let nextHintId = 0;

@Component({
  selector: 'app-profile-form',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="form"
      [formGroup]="form"
      (ngSubmit)="onSubmit()"
      (input)="onEdit()"
      novalidate
      data-testid="account-profile-form"
    >
      <div class="grid">
        <label class="field">
          <span class="label">{{ strings().account.profile.firstNameLabel }}</span>
          <input
            [id]="fieldId('firstName')"
            formControlName="firstName"
            type="text"
            autocomplete="given-name"
            required
            [attr.aria-describedby]="showError('firstName') ? errorId('firstName') : null"
            [attr.aria-invalid]="showError('firstName') ? 'true' : null"
          />
          <span [id]="errorId('firstName')" class="error" aria-live="polite">
            @if (showError('firstName')) {
              {{ strings().account.profile.errors.requiredField }}
            }
          </span>
        </label>
        <label class="field">
          <span class="label">{{ strings().account.profile.lastNameLabel }}</span>
          <input
            [id]="fieldId('lastName')"
            formControlName="lastName"
            type="text"
            autocomplete="family-name"
            [attr.aria-describedby]="showError('lastName') ? errorId('lastName') : null"
            [attr.aria-invalid]="showError('lastName') ? 'true' : null"
          />
          <span [id]="errorId('lastName')" class="error" aria-live="polite">
            @if (showError('lastName')) {
              {{ strings().account.profile.errors.tooLong }}
            }
          </span>
        </label>
        <label class="field">
          <span class="label">{{ strings().account.profile.phoneLabel }}</span>
          <input
            [id]="fieldId('phone')"
            formControlName="phone"
            type="tel"
            autocomplete="tel"
            inputmode="tel"
            dir="auto"
            [attr.aria-describedby]="showError('phone') ? errorId('phone') : null"
            [attr.aria-invalid]="showError('phone') ? 'true' : null"
          />
          <span [id]="errorId('phone')" class="error" aria-live="polite">
            @if (showError('phone')) {
              {{ strings().account.profile.errors.invalidPhone }}
            }
          </span>
        </label>
        <div class="field">
          <span class="label">{{ strings().account.profile.emailLabel }}</span>
          <output class="email-readonly" data-testid="account-profile-email">
            {{ user()?.email ?? '' }}
          </output>
          <span class="helper">{{ strings().account.profile.emailReadOnlyHint }}</span>
        </div>
      </div>

      @if (formError()) {
        <p class="form-error" role="alert" data-testid="account-profile-form-error">
          {{ formError() }}
        </p>
      }

      <div class="actions">
        <app-button
          type="submit"
          variant="primary"
          [loading]="saving()"
          testId="account-profile-form-submit"
        >
          {{ saving() ? strings().account.profile.saving : strings().account.profile.save }}
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
      .grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 0.75rem;
      }
      @media (min-width: 768px) {
        .grid {
          grid-template-columns: 1fr 1fr;
        }
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .label {
        color: var(--brand-text);
        font-size: var(--brand-text-body);
      }
      .field input {
        background-color: var(--brand-surface);
        color: var(--brand-text);
        /* agent_docs/storefront/brand-tokens.md: a control resting boundary is load-bearing. */
        border: 1px solid var(--brand-border-interactive);
        padding-inline: 0.75rem;
        padding-block: 0.5rem;
        border-radius: var(--brand-radius-sm);
        font-size: var(--brand-text-body);
      }
      .field input:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .helper {
        color: var(--brand-text-muted);
        font-size: var(--brand-text-micro);
      }
      .error {
        color: var(--brand-error);
        font-size: var(--brand-text-micro);
        min-block-size: 1rem;
      }
      .email-readonly {
        background-color: var(--brand-surface-strong);
        color: var(--brand-text);
        padding-inline: 0.75rem;
        padding-block: 0.5rem;
        border-radius: var(--brand-radius-sm);
        border: 1px solid var(--brand-border);
        font-size: var(--brand-text-body);
      }
      .form-error {
        margin: 0;
        color: var(--brand-error);
      }
      .actions {
        display: flex;
      }
    `,
  ],
})
export class ProfileFormComponent implements OnChanges {
  readonly user = input<CustomerUser | null>(null);
  readonly saving = input<boolean>(false);
  readonly externalError = input<string | null>(null);

  @Output() readonly submit = new EventEmitter<UpdateProfileRequest>();
  @Output() readonly edited = new EventEmitter<void>();

  private readonly fb = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;

  protected readonly formError = signal<string | null>(null);
  private readonly instanceId = nextHintId++;

  protected fieldId(name: string): string {
    return `account-profile-${name}-${this.instanceId}`;
  }
  protected errorId(name: string): string {
    return `account-profile-${name}-error-${this.instanceId}`;
  }

  protected readonly form: FormGroup = this.fb.nonNullable.group({
    firstName: ['', [Validators.required, Validators.maxLength(100)]],
    lastName: ['', [Validators.maxLength(100)]],
    phone: ['', [Validators.pattern(PHONE_RE)]],
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['user']) {
      const u = this.user();
      if (u) {
        this.form.reset({
          firstName: u.firstName ?? '',
          lastName: u.lastName ?? '',
          phone: u.phone ?? '',
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

  protected showError(key: string): boolean {
    const ctrl = this.form.get(key);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  protected onSubmit(): void {
    if (this.saving()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const raw = this.form.getRawValue() as Record<string, string>;
    const trimmed: Record<string, string> = {
      firstName: raw['firstName'].trim(),
    };
    if (raw['lastName']?.trim()) trimmed['lastName'] = raw['lastName'].trim();
    if (raw['phone']?.trim()) trimmed['phone'] = raw['phone'].trim();

    const parsed = updateProfileRequestSchema.safeParse(trimmed);
    if (!parsed.success) {
      this.formError.set(this.strings().account.profile.errors.generic);
      return;
    }
    this.formError.set(null);
    this.submit.emit(parsed.data);
  }
}

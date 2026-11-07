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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import { LocaleService } from '../../locale.service';
import { ButtonComponent } from '../../ui/button.component';

/** Mirrors `passwordRule` in `libs/storefront-types/src/lib/users/users.schemas.ts`. */
const PASSWORD_RE = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;

export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
}

export interface EmailChangeRequest {
  currentPassword: string;
  email: string;
}

let nextInstanceId = 0;

/**
 * Account security card: password change and verified email change.
 *
 * Both ride `PATCH /v1/users/me`, which has accepted `email`, `newPassword`
 * and `currentPassword` all along; only the fields were missing (finding N7).
 * The card is separate from the profile form on purpose, so a half-typed
 * password never entangles the name and phone form dirty state.
 *
 * A password change revokes every session including the caller own one, by
 * design (`apps/api/src/modules/users/users.service.ts`), so the copy says so
 * rather than letting the customer discover it as a surprise sign-out.
 */
@Component({
  selector: 'app-account-security-section',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" data-testid="account-security-section">
      <h2 class="card-title">{{ strings().account.security.heading }}</h2>

      <form
        class="form"
        [formGroup]="passwordForm"
        (ngSubmit)="onPasswordSubmit()"
        novalidate
        data-testid="account-security-password-form"
      >
        <h3 class="form-title">{{ strings().account.security.passwordHeading }}</h3>
        <p class="form-body">{{ strings().account.security.passwordBody }}</p>

        <label class="field">
          <span class="label">{{ strings().account.security.currentPasswordLabel }}</span>
          <input
            [id]="fieldId('current-password')"
            formControlName="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            [attr.aria-describedby]="
              passwordFieldInvalid('currentPassword') ? errorId('current-password') : null
            "
            [attr.aria-invalid]="passwordFieldInvalid('currentPassword') ? 'true' : null"
            data-testid="account-security-current-password"
          />
          <span [id]="errorId('current-password')" class="error" aria-live="polite">
            @if (passwordFieldInvalid('currentPassword')) {
              {{ strings().account.security.errors.requiredField }}
            }
          </span>
        </label>

        <label class="field">
          <span class="label">{{ strings().account.security.newPasswordLabel }}</span>
          <input
            [id]="fieldId('new-password')"
            formControlName="newPassword"
            type="password"
            autocomplete="new-password"
            required
            [attr.aria-describedby]="
              passwordFieldInvalid('newPassword')
                ? hintId('new-password') + ' ' + errorId('new-password')
                : hintId('new-password')
            "
            [attr.aria-invalid]="passwordFieldInvalid('newPassword') ? 'true' : null"
            data-testid="account-security-new-password"
          />
          <span [id]="hintId('new-password')" class="helper">
            {{ strings().account.security.passwordHint }}
          </span>
          <span [id]="errorId('new-password')" class="error" aria-live="polite">
            @if (passwordFieldInvalid('newPassword')) {
              {{ strings().account.security.errors.weakPassword }}
            }
          </span>
        </label>

        <label class="field">
          <span class="label">{{ strings().account.security.confirmPasswordLabel }}</span>
          <input
            [id]="fieldId('confirm-password')"
            formControlName="confirmPassword"
            type="password"
            autocomplete="new-password"
            required
            [attr.aria-describedby]="passwordsMismatch() ? errorId('confirm-password') : null"
            [attr.aria-invalid]="passwordsMismatch() ? 'true' : null"
            data-testid="account-security-confirm-password"
          />
          <span [id]="errorId('confirm-password')" class="error" aria-live="polite">
            @if (passwordsMismatch()) {
              {{ strings().account.security.errors.passwordMismatch }}
            }
          </span>
        </label>

        @if (passwordFormError()) {
          <p class="form-error" role="alert" data-testid="account-security-password-error">
            {{ passwordFormError() }}
          </p>
        }
        @if (passwordSuccessShown()) {
          <p
            class="form-success"
            role="status"
            aria-live="polite"
            data-testid="account-security-password-success"
          >
            {{ passwordSuccessShown() }}
          </p>
        }

        <div class="actions">
          <app-button
            type="submit"
            variant="primary"
            [disabled]="passwordBusy() || !canSubmitPassword()"
            testId="account-security-password-submit"
          >
            {{
              passwordBusy()
                ? strings().account.security.passwordSubmitting
                : strings().account.security.passwordSubmit
            }}
          </app-button>
        </div>
      </form>

      <form
        class="form"
        [formGroup]="emailForm"
        (ngSubmit)="onEmailSubmit()"
        novalidate
        data-testid="account-security-email-form"
      >
        <h3 class="form-title">{{ strings().account.security.emailHeading }}</h3>
        <p class="form-body">{{ strings().account.security.emailBody }}</p>

        <label class="field">
          <span class="label">{{ strings().account.security.newEmailLabel }}</span>
          <input
            [id]="fieldId('new-email')"
            formControlName="email"
            type="email"
            autocomplete="email"
            required
            [attr.aria-describedby]="emailFieldInvalid('email') ? errorId('new-email') : null"
            [attr.aria-invalid]="emailFieldInvalid('email') ? 'true' : null"
            data-testid="account-security-new-email"
          />
          <span [id]="errorId('new-email')" class="error" aria-live="polite">
            @if (emailFieldInvalid('email')) {
              {{ strings().account.security.errors.invalidEmail }}
            }
          </span>
        </label>

        <label class="field">
          <span class="label">{{ strings().account.security.currentPasswordLabel }}</span>
          <input
            [id]="fieldId('email-current-password')"
            formControlName="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            [attr.aria-describedby]="
              emailFieldInvalid('currentPassword') ? errorId('email-current-password') : null
            "
            [attr.aria-invalid]="emailFieldInvalid('currentPassword') ? 'true' : null"
            data-testid="account-security-email-current-password"
          />
          <span [id]="errorId('email-current-password')" class="error" aria-live="polite">
            @if (emailFieldInvalid('currentPassword')) {
              {{ strings().account.security.errors.requiredField }}
            }
          </span>
        </label>

        @if (emailFormError()) {
          <p class="form-error" role="alert" data-testid="account-security-email-error">
            {{ emailFormError() }}
          </p>
        }
        @if (emailSuccessShown()) {
          <p
            class="form-success"
            role="status"
            aria-live="polite"
            data-testid="account-security-email-success"
          >
            {{ emailSuccessShown() }}
          </p>
        }

        <div class="actions">
          <app-button
            type="submit"
            variant="primary"
            [disabled]="emailBusy() || !canSubmitEmail()"
            testId="account-security-email-submit"
          >
            {{
              emailBusy()
                ? strings().account.security.emailSubmitting
                : strings().account.security.emailSubmit
            }}
          </app-button>
        </div>
      </form>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        background-color: var(--brand-surface);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
        padding-block: 1.25rem;
        padding-inline: 1.25rem;
      }
      .card-title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .form-title {
        margin: 0;
        font-size: var(--brand-text-body);
        font-weight: 600;
        color: var(--brand-text);
      }
      .form-body {
        margin: 0;
        color: var(--brand-text-muted);
        font-size: var(--brand-text-micro);
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
      .form-error {
        margin: 0;
        color: var(--brand-error);
      }
      .form-success {
        margin: 0;
        color: var(--brand-text);
      }
      .actions {
        display: flex;
      }
    `,
  ],
})
export class SecuritySectionComponent implements OnChanges {
  readonly passwordBusy = input<boolean>(false);
  readonly emailBusy = input<boolean>(false);
  readonly passwordExternalError = input<string | null>(null);
  readonly emailExternalError = input<string | null>(null);
  readonly passwordSuccess = input<string | null>(null);
  readonly emailSuccess = input<string | null>(null);

  @Output() readonly passwordChange = new EventEmitter<PasswordChangeRequest>();
  @Output() readonly emailChange = new EventEmitter<EmailChangeRequest>();

  private readonly fb = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;

  private readonly instanceId = nextInstanceId++;

  protected readonly passwordFormError = signal<string | null>(null);
  protected readonly emailFormError = signal<string | null>(null);
  protected readonly passwordSuccessShown = signal<string | null>(null);
  protected readonly emailSuccessShown = signal<string | null>(null);

  protected readonly passwordForm: FormGroup = this.fb.nonNullable.group({
    currentPassword: ['', [Validators.required]],
    newPassword: [
      '',
      [
        Validators.required,
        Validators.minLength(8),
        Validators.maxLength(128),
        Validators.pattern(PASSWORD_RE),
      ],
    ],
    confirmPassword: ['', [Validators.required]],
  });

  protected readonly emailForm: FormGroup = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    currentPassword: ['', [Validators.required]],
  });

  constructor() {
    // A message about the last submit is stale once the customer edits again.
    this.passwordForm.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.passwordFormError.set(null);
      this.passwordSuccessShown.set(null);
    });
    this.emailForm.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.emailFormError.set(null);
      this.emailSuccessShown.set(null);
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['passwordSuccess']) {
      this.passwordSuccessShown.set(this.passwordSuccess());
    }
    if (changes['emailSuccess']) {
      this.emailSuccessShown.set(this.emailSuccess());
    }
    if (changes['passwordExternalError']) {
      this.passwordFormError.set(this.passwordExternalError());
    }
    if (changes['emailExternalError']) {
      this.emailFormError.set(this.emailExternalError());
    }
  }

  protected fieldId(name: string): string {
    return `account-security-${name}-${this.instanceId}`;
  }
  protected errorId(name: string): string {
    return `account-security-${name}-error-${this.instanceId}`;
  }
  protected hintId(name: string): string {
    return `account-security-${name}-hint-${this.instanceId}`;
  }

  /**
   * Plain methods rather than `computed()`: a computed over a Reactive-Forms
   * getter is untracked, memoises its first read and freezes the view.
   */
  protected passwordFieldInvalid(key: string): boolean {
    const ctrl = this.passwordForm.get(key);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  protected emailFieldInvalid(key: string): boolean {
    const ctrl = this.emailForm.get(key);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  protected passwordsMismatch(): boolean {
    const confirm = this.passwordForm.get('confirmPassword');
    if (!confirm || !(confirm.dirty || confirm.touched)) return false;
    return this.passwordForm.getRawValue().newPassword !== confirm.value;
  }

  protected canSubmitPassword(): boolean {
    if (this.passwordForm.invalid) return false;
    const raw = this.passwordForm.getRawValue();
    return raw.newPassword === raw.confirmPassword;
  }

  protected canSubmitEmail(): boolean {
    return this.emailForm.valid;
  }

  protected onPasswordSubmit(): void {
    if (this.passwordBusy()) return;
    this.passwordFormError.set(null);
    if (!this.canSubmitPassword()) {
      this.passwordForm.markAllAsTouched();
      return;
    }
    const raw = this.passwordForm.getRawValue();
    this.passwordChange.emit({
      currentPassword: raw.currentPassword,
      newPassword: raw.newPassword,
    });
  }

  protected onEmailSubmit(): void {
    if (this.emailBusy()) return;
    this.emailFormError.set(null);
    if (!this.canSubmitEmail()) {
      this.emailForm.markAllAsTouched();
      return;
    }
    const raw = this.emailForm.getRawValue();
    this.emailChange.emit({
      email: raw.email.trim(),
      currentPassword: raw.currentPassword,
    });
  }
}

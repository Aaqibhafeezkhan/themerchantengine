import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  signal,
  ViewChild,
} from '@angular/core';
import {
  AbstractControl,
  ReactiveFormsModule,
  FormBuilder,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AuthService, type AuthFailure } from '@storefront-services';

import { LocaleService } from '../../../locale.service';
import { APP_ROUTES } from '../../../../lib/routes';
import { ButtonComponent } from '../../../ui/button.component';
import { AuthPageShellComponent } from '../../../sections/auth/auth-page-shell.component';
import { pageTitle } from '../../../../lib/seo';

const PASSWORD_PATTERN = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value;
  const confirm = group.get('confirmPassword')?.value;
  if (!password || !confirm) return null;
  return password === confirm ? null : { passwordMismatch: true };
}

@Component({
  selector: 'app-auth-reset-password-page',
  standalone: true,
  imports: [AuthPageShellComponent, ButtonComponent, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-page-shell
      [heading]="
        success()
          ? strings().auth.resetPassword.successHeading
          : strings().auth.resetPassword.heading
      "
      [subheading]="success() ? '' : strings().auth.resetPassword.subheading"
      testId="auth-reset-password-page"
    >
      @if (!token()) {
        <p class="error" role="alert" data-testid="auth-reset-token-missing">
          {{ strings().auth.resetPassword.tokenMissing }}
        </p>
      } @else if (!success()) {
        <form
          class="form"
          [formGroup]="form"
          (ngSubmit)="onSubmit()"
          (input)="errorMessage.set(null)"
          novalidate
          data-testid="auth-reset-form"
          [attr.aria-describedby]="errorMessage() ? errorId : null"
        >
          <div class="field">
            <label [for]="passwordId" class="label">
              {{ strings().auth.resetPassword.passwordLabel }}
            </label>
            <input
              [id]="passwordId"
              [type]="showPassword() ? 'text' : 'password'"
              class="input"
              autocomplete="new-password"
              formControlName="password"
              [attr.aria-describedby]="passwordHintId"
              data-testid="auth-reset-password"
            />
            <p [id]="passwordHintId" class="hint">
              {{ strings().auth.resetPassword.passwordHint }}
            </p>
          </div>

          <div class="field">
            <label [for]="confirmId" class="label">
              {{ strings().auth.resetPassword.confirmPasswordLabel }}
            </label>
            <input
              [id]="confirmId"
              [type]="showPassword() ? 'text' : 'password'"
              class="input"
              autocomplete="new-password"
              formControlName="confirmPassword"
              [attr.aria-describedby]="mismatchVisible() ? mismatchId : null"
              [attr.aria-invalid]="mismatchVisible() ? 'true' : null"
              data-testid="auth-reset-confirm"
            />
            @if (mismatchVisible()) {
              <p [id]="mismatchId" class="error" role="alert" data-testid="auth-reset-mismatch">
                {{ strings().auth.resetPassword.passwordMismatch }}
              </p>
            }
          </div>

          <button
            type="button"
            class="password-toggle inline-toggle"
            (click)="togglePassword()"
            [attr.aria-pressed]="showPassword() ? 'true' : 'false'"
            [attr.aria-label]="
              showPassword()
                ? strings().auth.shared.hidePassword
                : strings().auth.shared.showPassword
            "
          >
            {{
              showPassword()
                ? strings().auth.shared.hidePassword
                : strings().auth.shared.showPassword
            }}
          </button>

          @if (errorMessage()) {
            <p [id]="errorId" class="error" role="alert" data-testid="auth-reset-error">
              {{ errorMessage() }}
            </p>
          }

          <app-button
            type="submit"
            variant="primary"
            size="md"
            [disabled]="form.invalid || submitting()"
            [loading]="submitting()"
            testId="auth-reset-submit"
          >
            {{
              submitting() ? strings().auth.shared.submitting : strings().auth.resetPassword.submit
            }}
          </app-button>
        </form>
      } @else {
        <div
          #successPanel
          class="success"
          role="status"
          tabindex="-1"
          data-testid="auth-reset-success"
        >
          <p class="success-body">{{ strings().auth.resetPassword.successBody }}</p>
        </div>
      }

      <a shellFooter class="text-link" [routerLink]="loginHref()" data-testid="auth-reset-login">
        {{ strings().auth.resetPassword.loginLink }}
      </a>
    </app-auth-page-shell>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }
      .label {
        font-size: var(--brand-text-micro);
        font-weight: 500;
        color: var(--brand-text);
      }
      .input {
        inline-size: 100%;
        font: inherit;
        min-block-size: 44px;
        padding-block: 0.625rem;
        padding-inline: 0.875rem;
        background-color: var(--brand-surface);
        color: var(--brand-text);
        /* agent_docs/storefront/brand-tokens.md: a control's resting boundary is load-bearing. */
        border: 1px solid var(--brand-border-interactive);
        border-radius: var(--brand-radius-md);
      }
      .input:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
        border-color: var(--brand-primary);
      }
      .password-toggle.inline-toggle {
        align-self: flex-start;
        font: inherit;
        font-size: var(--brand-text-micro);
        font-weight: 500;
        color: var(--brand-primary);
        background: transparent;
        border: none;
        cursor: pointer;
        padding-inline: 0.5rem;
        padding-block: 0.5rem;
        min-inline-size: 44px;
        min-block-size: 44px;
      }
      .password-toggle.inline-toggle:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
        border-radius: var(--brand-radius-md);
      }
      .hint {
        margin: 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-text-muted);
      }
      .error {
        margin: 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-error);
      }
      .success {
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        padding-block: 1rem;
        padding-inline: 1rem;
        background-color: var(--brand-surface);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-md);
      }
      .success-body {
        margin: 0;
        font-size: var(--brand-text-body);
        color: var(--brand-text);
      }
      .text-link {
        color: var(--brand-primary);
        text-decoration: underline;
      }
      .text-link:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
    `,
  ],
})
export default class AuthResetPasswordPage implements OnInit, OnDestroy {
  protected readonly passwordId = 'auth-reset-password';
  protected readonly confirmId = 'auth-reset-confirm';
  protected readonly passwordHintId = 'auth-reset-password-hint';
  protected readonly mismatchId = 'auth-reset-mismatch';
  protected readonly errorId = 'auth-reset-error';

  @ViewChild('successPanel') protected successPanelRef?: ElementRef<HTMLElement>;

  protected readonly showPassword = signal(false);
  protected readonly submitting = signal(false);
  protected readonly success = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly token = signal<string | null>(null);

  private readonly fb = inject(FormBuilder);
  private readonly authSvc = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(Meta);
  private readonly title = inject(Title);
  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;

  protected readonly form = this.fb.nonNullable.group(
    {
      password: [
        '',
        [
          Validators.required,
          Validators.minLength(8),
          Validators.maxLength(128),
          Validators.pattern(PASSWORD_PATTERN),
        ],
      ],
      confirmPassword: ['', Validators.required],
    },
    { validators: passwordsMatch },
  );

  protected readonly loginHref = computed(() => APP_ROUTES.auth.login(this.locale.locale()));

  ngOnInit(): void {
    this.title.setTitle(
      pageTitle(this.strings().auth.resetPassword.title, this.strings().brand.name),
    );
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });
    const tokenParam = this.route.snapshot.queryParamMap.get('token');
    this.token.set(tokenParam && tokenParam.length > 0 ? tokenParam : null);
  }

  ngOnDestroy(): void {
    this.meta.removeTag('name="robots"');
  }

  protected togglePassword(): void {
    this.showPassword.update((v) => !v);
  }

  protected mismatchVisible(): boolean {
    const confirm = this.form.controls.confirmPassword;
    return (
      this.form.hasError('passwordMismatch') &&
      (confirm.touched || confirm.dirty) &&
      !!confirm.value
    );
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid || this.submitting()) return;
    const tokenValue = this.token();
    if (!tokenValue) {
      this.errorMessage.set(this.strings().auth.resetPassword.tokenMissing);
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set(null);
    const value = this.form.getRawValue();
    try {
      const result = await this.authSvc.resetPassword({
        token: tokenValue,
        password: value.password,
      });
      if (result.ok) {
        this.success.set(true);
        queueMicrotask(() => this.successPanelRef?.nativeElement.focus());
      } else {
        this.errorMessage.set(this.mapFailure(result.failure));
      }
    } catch {
      // The only throw path is a Zod parse of the form payload; the form
      // validators gate that, so this is a defensive fallback.
      this.errorMessage.set(this.strings().auth.resetPassword.genericError);
    } finally {
      this.submitting.set(false);
    }
  }

  private mapFailure(failure: AuthFailure): string {
    const s = this.strings().auth.resetPassword;
    // Better Auth rejects a consumed / expired / malformed reset token with a
    // 4xx. The form already gates a weak password, so a 400 / 401 here is the
    // invalid-token path.
    const code = (failure.code ?? '').toUpperCase();
    if (code.includes('TOKEN') || failure.status === 400 || failure.status === 401) {
      return s.tokenInvalid;
    }
    return s.genericError;
  }
}

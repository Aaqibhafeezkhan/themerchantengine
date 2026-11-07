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
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';

import { AuthService, type AuthFailure } from '@storefront-services';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { APP_ROUTES } from '../../../../lib/routes';
import { ButtonComponent } from '../../../ui/button.component';
import { AuthPageShellComponent } from '../../../sections/auth/auth-page-shell.component';
import { TurnstileComponent } from '../../../sections/auth/turnstile.component';
import { pageTitle } from '../../../../lib/seo';

const PASSWORD_PATTERN = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;

@Component({
  selector: 'app-auth-register-page',
  standalone: true,
  imports: [
    AuthPageShellComponent,
    ButtonComponent,
    ReactiveFormsModule,
    RouterLink,
    TurnstileComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-page-shell
      [heading]="
        registered() ? strings().auth.register.registeredHeading : strings().auth.register.heading
      "
      [subheading]="registered() ? '' : strings().auth.register.subheading"
      testId="auth-register-page"
    >
      @if (registered()) {
        <div
          #successPanel
          class="success"
          role="status"
          tabindex="-1"
          data-testid="auth-register-success"
        >
          <p class="success-body">{{ strings().auth.register.registeredBody }}</p>
        </div>
      } @else {
        <form
          class="form"
          [formGroup]="form"
          (ngSubmit)="onSubmit()"
          (input)="errorMessage.set(null)"
          novalidate
          data-testid="auth-register-form"
          [attr.aria-describedby]="errorMessage() ? errorId : null"
        >
          <div class="row">
            <div class="field">
              <label [for]="firstNameId" class="label">
                {{ strings().auth.register.firstNameLabel }}
              </label>
              <input
                [id]="firstNameId"
                type="text"
                class="input"
                autocomplete="given-name"
                maxlength="100"
                formControlName="firstName"
                data-testid="auth-register-first-name"
              />
            </div>
            <div class="field">
              <label [for]="lastNameId" class="label">
                {{ strings().auth.register.lastNameLabel }}
              </label>
              <input
                [id]="lastNameId"
                type="text"
                class="input"
                autocomplete="family-name"
                maxlength="100"
                formControlName="lastName"
                data-testid="auth-register-last-name"
              />
            </div>
          </div>

          <div class="field">
            <label [for]="emailId" class="label">{{ strings().auth.register.emailLabel }}</label>
            <input
              [id]="emailId"
              type="email"
              class="input"
              autocomplete="email"
              inputmode="email"
              spellcheck="false"
              autocapitalize="off"
              formControlName="email"
              data-testid="auth-register-email"
            />
          </div>

          <div class="field">
            <label [for]="passwordId" class="label">
              {{ strings().auth.register.passwordLabel }}
            </label>
            <div class="password-wrap">
              <input
                [id]="passwordId"
                [type]="showPassword() ? 'text' : 'password'"
                class="input"
                autocomplete="new-password"
                formControlName="password"
                [attr.aria-describedby]="passwordHintId"
                data-testid="auth-register-password"
              />
              <button
                type="button"
                class="password-toggle"
                (click)="togglePassword()"
                [attr.aria-pressed]="showPassword() ? 'true' : 'false'"
                [attr.aria-label]="
                  showPassword()
                    ? strings().auth.shared.hidePassword
                    : strings().auth.shared.showPassword
                "
                data-testid="auth-register-password-toggle"
              >
                {{
                  showPassword()
                    ? strings().auth.shared.hidePassword
                    : strings().auth.shared.showPassword
                }}
              </button>
            </div>
            <p [id]="passwordHintId" class="hint">{{ strings().auth.register.passwordHint }}</p>
          </div>

          <label class="terms">
            <input
              type="checkbox"
              formControlName="acceptTerms"
              data-testid="auth-register-terms"
            />
            <span>{{ strings().auth.register.acceptTermsLabel }}</span>
          </label>

          <!-- Honeypot: hidden from real users (off-screen, not focusable, not
               autofilled). Bots that scrape + replay the form fill it; the
               server rejects a non-empty value. -->
          <div class="hp" aria-hidden="true">
            <label [for]="honeypotId">Company</label>
            <input
              [id]="honeypotId"
              type="text"
              tabindex="-1"
              autocomplete="off"
              formControlName="company"
              data-testid="auth-register-hp"
            />
          </div>

          <app-turnstile (token)="onCaptchaToken($event)" data-testid="auth-register-turnstile" />

          @if (errorMessage()) {
            <p [id]="errorId" class="error" role="alert" data-testid="auth-register-error">
              {{ errorMessage() }}
            </p>
          }

          <app-button
            type="submit"
            variant="primary"
            size="md"
            [disabled]="form.invalid || submitting() || (captchaRequired && !captchaToken())"
            [loading]="submitting()"
            testId="auth-register-submit"
          >
            {{ submitting() ? strings().auth.shared.submitting : strings().auth.register.submit }}
          </app-button>
        </form>
      }

      <p shellFooter class="meta">
        <span>{{ strings().auth.register.haveAccount }}</span>
        <a class="text-link" [routerLink]="loginHref()" data-testid="auth-register-login-link">
          {{ strings().auth.register.loginLink }}
        </a>
      </p>
    </app-auth-page-shell>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 1rem;
      }
      @media (min-width: 768px) {
        .row {
          grid-template-columns: 1fr 1fr;
        }
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
      .password-wrap {
        position: relative;
        display: flex;
      }
      .password-toggle {
        font: inherit;
        font-size: var(--brand-text-micro);
        font-weight: 500;
        color: var(--brand-primary);
        background: transparent;
        border: none;
        cursor: pointer;
        padding-inline-start: 0.75rem;
        padding-inline-end: 0.25rem;
        position: absolute;
        inset-inline-end: 0.25rem;
        inset-block: 0;
        min-inline-size: 44px;
        min-block-size: 44px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .password-toggle:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
        border-radius: var(--brand-radius-md);
      }
      .hint {
        margin: 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-text-muted);
      }
      .terms {
        display: inline-flex;
        align-items: flex-start;
        gap: 0.5rem;
        font-size: var(--brand-text-micro);
        color: var(--brand-text);
        cursor: pointer;
      }
      .terms input {
        margin-block-start: 0.25rem;
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
      .meta {
        margin: 0;
        display: inline-flex;
        flex-wrap: wrap;
        gap: 0.375rem;
        color: var(--brand-text-muted);
      }
      .hp {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
        padding: 0;
        margin: -1px;
      }
    `,
  ],
})
export default class AuthRegisterPage implements OnInit, OnDestroy {
  protected readonly firstNameId = 'auth-register-first-name';
  protected readonly lastNameId = 'auth-register-last-name';
  protected readonly emailId = 'auth-register-email';
  protected readonly passwordId = 'auth-register-password';
  protected readonly passwordHintId = 'auth-register-password-hint';
  protected readonly errorId = 'auth-register-error';
  protected readonly honeypotId = 'auth-register-company';

  @ViewChild('successPanel') protected successPanelRef?: ElementRef<HTMLElement>;

  protected readonly showPassword = signal(false);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly registered = signal(false);
  protected readonly captchaToken = signal<string | null>(null);

  /** Whether a Turnstile token is required before submit (site key configured). */
  protected readonly captchaRequired = !!(
    import.meta as unknown as { env?: Record<string, string> }
  ).env?.['VITE_TURNSTILE_SITE_KEY'];

  private readonly fb = inject(FormBuilder);
  private readonly authSvc = inject(AuthService);
  private readonly meta = inject(Meta);
  private readonly title = inject(Title);
  private readonly locale = inject(LocaleService);
  private readonly authState = inject(AuthStateService);
  private readonly router = inject(Router);
  protected readonly strings = this.locale.strings;

  protected readonly form = this.fb.nonNullable.group({
    firstName: ['', [Validators.required, Validators.maxLength(100)]],
    lastName: ['', [Validators.required, Validators.maxLength(100)]],
    email: ['', [Validators.required, Validators.email]],
    password: [
      '',
      [
        Validators.required,
        Validators.minLength(8),
        Validators.maxLength(128),
        Validators.pattern(PASSWORD_PATTERN),
      ],
    ],
    acceptTerms: [false, Validators.requiredTrue],
    // Honeypot — must stay empty. No validator: a filled value is caught
    // server-side, and we never want to surface a visible error for it.
    company: [''],
  });

  protected readonly loginHref = computed(() => APP_ROUTES.auth.login(this.locale.locale()));

  ngOnInit(): void {
    this.title.setTitle(pageTitle(this.strings().auth.register.title, this.strings().brand.name));
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });
    void this.forwardIfAlreadyAuthed();
  }

  /**
   * Finding N2, sibling site of the login page. A customer who already has a
   * session has no account to create. Waits for the boot outcome (finding N4)
   * and never interrupts the check-your-inbox panel a fresh registration shows.
   */
  private async forwardIfAlreadyAuthed(): Promise<void> {
    await this.authState.whenBooted();
    if (this.submitting() || this.registered()) return;
    if (!this.authState.isAuthed()) return;
    void this.router.navigateByUrl(APP_ROUTES.account.index(this.locale.locale()));
  }

  ngOnDestroy(): void {
    this.meta.removeTag('name="robots"');
  }

  protected togglePassword(): void {
    this.showPassword.update((v) => !v);
  }

  protected onCaptchaToken(token: string | null): void {
    this.captchaToken.set(token);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid || this.submitting()) return;
    if (this.captchaRequired && !this.captchaToken()) return;
    this.submitting.set(true);
    this.errorMessage.set(null);
    const value = this.form.getRawValue();
    try {
      // Better Auth has `requireEmailVerification` on (clarification Q2): a
      // fresh sign-up creates the account and sends a verification email but
      // does NOT establish a session. The page shows a "check your inbox"
      // state — it never commits a session or navigates to an authed route.
      const result = await this.authSvc.register(
        {
          email: value.email,
          password: value.password,
          firstName: value.firstName,
          lastName: value.lastName,
        },
        this.absoluteUrl(APP_ROUTES.account.index(this.locale.locale())),
        { captchaToken: this.captchaToken(), honeypot: value.company },
      );
      if (result.ok) {
        this.registered.set(true);
        queueMicrotask(() => this.successPanelRef?.nativeElement.focus());
      } else {
        this.errorMessage.set(this.mapFailure(result.failure));
      }
    } catch {
      // The only throw path is a Zod parse of the form payload; the form
      // validators gate that, so this is a defensive fallback.
      this.errorMessage.set(this.strings().auth.register.genericError);
    } finally {
      this.submitting.set(false);
    }
  }

  private absoluteUrl(path: string): string {
    const origin = globalThis.location?.origin ?? '';
    return `${origin}${path}`;
  }

  private mapFailure(failure: AuthFailure): string {
    const s = this.strings().auth.register;
    if (failure.code === 'USER_ALREADY_EXISTS') return s.emailExists;
    // Better Auth rejects a password that fails its policy with a 4xx; the
    // form validators normally catch this first, so it is a backstop.
    if (failure.status === 400 || failure.status === 422) return s.weakPassword;
    return s.genericError;
  }
}

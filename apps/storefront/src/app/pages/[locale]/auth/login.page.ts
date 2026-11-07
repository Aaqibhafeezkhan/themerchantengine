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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AuthService, CartService, type AuthFailure } from '@storefront-services';

import { LocaleService } from '../../../locale.service';
import { AuthStateService } from '../../../services/auth-state.service';
import { APP_ROUTES } from '../../../../lib/routes';
import { ButtonComponent } from '../../../ui/button.component';
import { AuthPageShellComponent } from '../../../sections/auth/auth-page-shell.component';
import { pageTitle } from '../../../../lib/seo';

@Component({
  selector: 'app-auth-login-page',
  standalone: true,
  imports: [AuthPageShellComponent, ButtonComponent, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-page-shell
      [heading]="
        magicLinkSent() ? strings().auth.login.magicLinkSentHeading : strings().auth.login.heading
      "
      [subheading]="magicLinkSent() ? '' : strings().auth.login.subheading"
      testId="auth-login-page"
    >
      @if (magicLinkSent()) {
        <div
          #magicLinkPanel
          class="success"
          role="status"
          tabindex="-1"
          data-testid="auth-login-magic-link-sent"
        >
          <p class="success-body">{{ strings().auth.login.magicLinkSentBody }}</p>
        </div>
      } @else {
        <form
          class="form"
          [formGroup]="form"
          (ngSubmit)="onSubmit()"
          (input)="errorMessage.set(null)"
          novalidate
          data-testid="auth-login-form"
          [attr.aria-describedby]="errorMessage() ? errorId : null"
        >
          <div class="field">
            <label [for]="emailId" class="label">{{ strings().auth.login.emailLabel }}</label>
            <input
              [id]="emailId"
              type="email"
              class="input"
              autocomplete="email"
              inputmode="email"
              spellcheck="false"
              autocapitalize="off"
              enterkeyhint="next"
              formControlName="email"
              [placeholder]="strings().auth.login.emailPlaceholder"
              data-testid="auth-login-email"
            />
          </div>

          <div class="field">
            <label [for]="passwordId" class="label">{{ strings().auth.login.passwordLabel }}</label>
            <div class="password-wrap">
              <input
                [id]="passwordId"
                [type]="showPassword() ? 'text' : 'password'"
                class="input"
                autocomplete="current-password"
                enterkeyhint="done"
                formControlName="password"
                [placeholder]="strings().auth.login.passwordPlaceholder"
                data-testid="auth-login-password"
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
                data-testid="auth-login-password-toggle"
              >
                {{
                  showPassword()
                    ? strings().auth.shared.hidePassword
                    : strings().auth.shared.showPassword
                }}
              </button>
            </div>
          </div>

          @if (errorMessage()) {
            <p [id]="errorId" class="error" role="alert" data-testid="auth-login-error">
              {{ errorMessage() }}
            </p>
          }

          <app-button
            type="submit"
            variant="primary"
            size="md"
            [disabled]="form.invalid || submitting()"
            [loading]="submitting()"
            testId="auth-login-submit"
          >
            {{ submitting() ? strings().auth.shared.submitting : strings().auth.login.submit }}
          </app-button>

          <button
            type="button"
            class="magic-link"
            (click)="onMagicLink()"
            [disabled]="submitting()"
            data-testid="auth-login-magic-link"
          >
            {{ strings().auth.login.magicLinkSubmit }}
          </button>
        </form>
      }

      <div shellFooter>
        <a class="text-link" [routerLink]="forgotHref()" data-testid="auth-login-forgot-link">{{
          strings().auth.login.forgotPasswordLink
        }}</a>
        <p class="meta">
          <span>{{ strings().auth.login.noAccount }}</span>
          <a
            class="text-link"
            [routerLink]="registerHref()"
            data-testid="auth-login-register-link"
            >{{ strings().auth.login.registerLink }}</a
          >
        </p>
      </div>
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
        padding-block: 0;
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
      .magic-link {
        align-self: center;
        font: inherit;
        font-size: var(--brand-text-micro);
        font-weight: 500;
        color: var(--brand-primary);
        background: transparent;
        border: none;
        cursor: pointer;
        text-decoration: underline;
        min-block-size: 44px;
        padding-inline: 0.5rem;
      }
      .magic-link:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
        border-radius: var(--brand-radius-md);
      }
      .magic-link:disabled {
        color: var(--brand-text-muted);
        cursor: default;
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
    `,
  ],
})
export default class AuthLoginPage implements OnInit, OnDestroy {
  protected readonly emailId = 'auth-login-email';
  protected readonly passwordId = 'auth-login-password';
  protected readonly errorId = 'auth-login-error';

  @ViewChild('magicLinkPanel') protected magicLinkPanelRef?: ElementRef<HTMLElement>;

  protected readonly showPassword = signal(false);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly magicLinkSent = signal(false);
  /** Guards the authed-visitor forward and the post-sign-in redirect from double-firing. */
  private redirected = false;

  private readonly fb = inject(FormBuilder);
  private readonly authSvc = inject(AuthService);
  private readonly cart = inject(CartService);
  private readonly authState = inject(AuthStateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(Meta);
  private readonly title = inject(Title);
  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  protected readonly forgotHref = computed(() =>
    APP_ROUTES.auth.forgotPassword(this.locale.locale()),
  );
  protected readonly registerHref = computed(() => APP_ROUTES.auth.register(this.locale.locale()));

  ngOnInit(): void {
    this.title.setTitle(pageTitle(this.strings().auth.login.title, this.strings().brand.name));
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });
    void this.forwardIfAlreadyAuthed();
  }

  /**
   * Finding N2. A customer who still has a valid session and lands here has
   * nothing to do on a credential form. The check waits for the boot outcome
   * (finding N4), otherwise a full page load always reads anonymous and the
   * customer is stranded on the form.
   *
   * Never fires while the magic-link panel is showing: the customer is reading
   * an instruction, not idling on a form. `redirected` keeps this and
   * `redirectAfterLogin()` from both navigating on a manual sign-in.
   */
  private async forwardIfAlreadyAuthed(): Promise<void> {
    await this.authState.whenBooted();
    if (this.redirected || this.submitting() || this.magicLinkSent()) return;
    if (!this.authState.isAuthed()) return;
    this.redirected = true;
    void this.router.navigateByUrl(this.resolveSafeFromParam());
  }

  ngOnDestroy(): void {
    this.meta.removeTag('name="robots"');
  }

  protected togglePassword(): void {
    this.showPassword.update((v) => !v);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid || this.submitting()) return;
    this.submitting.set(true);
    this.errorMessage.set(null);
    const value = this.form.getRawValue();
    try {
      const result = await this.authSvc.login({
        email: value.email,
        password: value.password,
      });
      if (result.status === 'failed') {
        this.errorMessage.set(this.mapFailure(result.failure));
        return;
      }
      this.authState.setSession({ user: result.user });
      // Fold the guest basket into the account cart before navigating away.
      //
      // This is the A9 repro path: a guest with one line opens /checkout, gets
      // bounced here with `?from=/en/checkout`, signs in, and the SPA navigates
      // on without a page reload, so the shell's boot merge never runs. Without
      // this call the basket is gone by the time checkout renders.
      //
      // Awaited so the merge lands before checkout re-reads the cart, and
      // swallowed so a lost basket never also strands the customer on the form.
      await this.cart.merge().catch(() => undefined);
      this.redirectAfterLogin();
    } catch {
      // The only throw path left is a Zod parse of the form payload — the form
      // validators already gate that, so this is a defensive fallback.
      this.errorMessage.set(this.strings().auth.login.genericError);
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * Password-less sign-in (clarification Q3). Emails a one-time magic link to
   * the address in the email field; the customer never types a password.
   */
  protected async onMagicLink(): Promise<void> {
    if (this.submitting()) return;
    const emailControl = this.form.controls.email;
    if (emailControl.invalid) {
      emailControl.markAsTouched();
      this.errorMessage.set(this.strings().auth.login.invalidCredentials);
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      const result = await this.authSvc.sendMagicLink(
        { email: emailControl.value },
        this.absoluteUrl(this.resolveSafeFromParam()),
      );
      if (result.ok) {
        this.magicLinkSent.set(true);
        queueMicrotask(() => this.magicLinkPanelRef?.nativeElement.focus());
      } else {
        this.errorMessage.set(this.mapFailure(result.failure));
      }
    } catch {
      this.errorMessage.set(this.strings().auth.login.genericError);
    } finally {
      this.submitting.set(false);
    }
  }

  private redirectAfterLogin(): void {
    if (this.redirected) return;
    this.redirected = true;
    void this.router.navigateByUrl(this.resolveSafeFromParam());
  }

  private absoluteUrl(path: string): string {
    const origin = globalThis.location?.origin ?? '';
    return `${origin}${path}`;
  }

  private resolveSafeFromParam(): string {
    const fromRaw = this.route.snapshot.queryParamMap.get('from');
    const localePrefix = `/${this.locale.locale()}/`;
    const accountIndex = APP_ROUTES.account.index(this.locale.locale());
    if (!fromRaw) return accountIndex;
    const decoded = (() => {
      try {
        return decodeURIComponent(fromRaw);
      } catch {
        return null;
      }
    })();
    if (!decoded) return accountIndex;
    if (!decoded.startsWith(localePrefix)) return accountIndex;
    if (decoded.startsWith('//')) return accountIndex;
    return decoded;
  }

  private mapFailure(failure: AuthFailure): string {
    const s = this.strings().auth.login;
    // Better Auth blocks an unverified new customer at sign-in — a distinct
    // code so the page steers them to the verification email rather than
    // implying their password is wrong.
    if (failure.code === 'EMAIL_NOT_VERIFIED') return s.emailNotVerified;
    if (failure.code === 'INVALID_EMAIL_OR_PASSWORD') return s.invalidCredentials;
    if (failure.status === 429) return s.rateLimited;
    if (failure.status === 401) return s.invalidCredentials;
    return s.genericError;
  }
}

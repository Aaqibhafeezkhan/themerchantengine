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
import { RouterLink } from '@angular/router';

import { AuthService, type AuthFailure } from '@storefront-services';

import { LocaleService } from '../../../locale.service';
import { StoreConfigService } from '../../../services/store-config.service';
import { APP_ROUTES } from '../../../../lib/routes';
import { ButtonComponent } from '../../../ui/button.component';
import { AuthPageShellComponent } from '../../../sections/auth/auth-page-shell.component';
import { pageTitle } from '../../../../lib/seo';

@Component({
  selector: 'app-auth-forgot-password-page',
  standalone: true,
  imports: [AuthPageShellComponent, ButtonComponent, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-page-shell
      [heading]="
        success()
          ? strings().auth.forgotPassword.successHeading
          : strings().auth.forgotPassword.heading
      "
      [subheading]="success() ? '' : strings().auth.forgotPassword.subheading"
      testId="auth-forgot-password-page"
    >
      @if (!success()) {
        <form
          class="form"
          [formGroup]="form"
          (ngSubmit)="onSubmit()"
          (input)="errorMessage.set(null)"
          novalidate
          data-testid="auth-forgot-form"
          [attr.aria-describedby]="errorMessage() ? errorId : null"
        >
          <div class="field">
            <label [for]="emailId" class="label">
              {{ strings().auth.forgotPassword.emailLabel }}
            </label>
            <input
              [id]="emailId"
              type="email"
              class="input"
              autocomplete="email"
              inputmode="email"
              spellcheck="false"
              autocapitalize="off"
              formControlName="email"
              data-testid="auth-forgot-email"
            />
          </div>

          @if (errorMessage()) {
            <p [id]="errorId" class="error" role="alert" data-testid="auth-forgot-error">
              {{ errorMessage() }}
            </p>
          }

          <app-button
            type="submit"
            variant="primary"
            size="md"
            [disabled]="form.invalid || submitting()"
            [loading]="submitting()"
            testId="auth-forgot-submit"
          >
            {{
              submitting() ? strings().auth.shared.submitting : strings().auth.forgotPassword.submit
            }}
          </app-button>
        </form>
      } @else {
        <div
          #successPanel
          class="success"
          role="status"
          tabindex="-1"
          data-testid="auth-forgot-success"
        >
          <p class="success-body">
            {{ strings().auth.forgotPassword.successBody }}
          </p>
          @if (supportEmail(); as email) {
            <p class="support" data-testid="auth-forgot-support">
              {{ strings().auth.forgotPassword.successSupport }}
              <a
                class="text-link"
                [href]="'mailto:' + email"
                data-testid="auth-forgot-support-mailto"
                >{{ email }}</a
              >
            </p>
          }
        </div>
      }

      <a shellFooter class="text-link" [routerLink]="loginHref()" data-testid="auth-forgot-back">
        {{ strings().auth.forgotPassword.backToLogin }}
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
      .support {
        margin: 0;
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
export default class AuthForgotPasswordPage implements OnInit, OnDestroy {
  protected readonly emailId = 'auth-forgot-email';
  protected readonly errorId = 'auth-forgot-error';

  @ViewChild('successPanel') protected successPanelRef?: ElementRef<HTMLElement>;

  protected readonly submitting = signal(false);
  protected readonly success = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  private readonly fb = inject(FormBuilder);
  private readonly authSvc = inject(AuthService);
  private readonly meta = inject(Meta);
  private readonly title = inject(Title);
  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly loginHref = computed(() => APP_ROUTES.auth.login(this.locale.locale()));
  /**
   * The operator's contact address, from the store settings (finding D7).
   *
   * Not a locale string: the storefront used to ship a support address typed
   * into both catalogues, so the admin's contact-email field changed nothing
   * and the two could disagree. Null hides the line entirely, which is better
   * than inviting the reader to write to an address nobody claimed.
   */
  protected readonly supportEmail = inject(StoreConfigService).contactEmail;

  ngOnInit(): void {
    this.title.setTitle(
      pageTitle(this.strings().auth.forgotPassword.title, this.strings().brand.name),
    );
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });
  }

  ngOnDestroy(): void {
    this.meta.removeTag('name="robots"');
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid || this.submitting()) return;
    this.submitting.set(true);
    this.errorMessage.set(null);
    const value = this.form.getRawValue();
    try {
      // `redirectTo` is the absolute storefront URL the reset link lands on;
      // Better Auth appends the `?token=` query the reset page reads.
      const result = await this.authSvc.forgotPassword(
        { email: value.email },
        this.absoluteUrl(APP_ROUTES.auth.resetPassword(this.locale.locale())),
      );
      if (result.ok) {
        this.success.set(true);
        queueMicrotask(() => this.successPanelRef?.nativeElement.focus());
      } else {
        this.errorMessage.set(this.mapFailure(result.failure));
      }
    } catch {
      // The only throw path is a Zod parse of the email; the form validator
      // gates that, so this is a defensive fallback.
      this.errorMessage.set(this.strings().auth.forgotPassword.genericError);
    } finally {
      this.submitting.set(false);
    }
  }

  private absoluteUrl(path: string): string {
    const origin = globalThis.location?.origin ?? '';
    return `${origin}${path}`;
  }

  private mapFailure(failure: AuthFailure): string {
    const s = this.strings().auth.forgotPassword;
    if (failure.status === 429) return s.rateLimited;
    return s.genericError;
  }
}

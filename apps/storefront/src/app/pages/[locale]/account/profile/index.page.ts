import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { Router } from '@angular/router';

import { AuthService, UsersService } from '@storefront-services';
import {
  StorefrontError,
  StorefrontUnauthorizedError,
  type CustomerUser,
  type UpdateProfileRequest,
} from '@storefront-types';

import { LocaleService } from '../../../../locale.service';
import { AuthStateService } from '../../../../services/auth-state.service';
import { APP_ROUTES } from '../../../../../lib/routes';
import { ProfileFormComponent } from '../../../../sections/account/profile-form.component';
import {
  SecuritySectionComponent,
  type EmailChangeRequest,
  type PasswordChangeRequest,
} from '../../../../sections/account/security-section.component';
import { SpinnerComponent } from '../../../../ui/spinner.component';
import { ensureAuthedForAccount } from '../_account-auth-guard';
import { AccountNavComponent } from '../../../../sections/account/account-nav.component';
import { pageTitle } from '../../../../../lib/seo';

type PageState = 'idle' | 'loading' | 'ready' | 'error';

@Component({
  selector: 'app-account-profile-page',
  standalone: true,
  imports: [AccountNavComponent, ProfileFormComponent, SecuritySectionComponent, SpinnerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" data-testid="account-profile-page">
      <app-account-nav />
      <header class="header">
        <h1 class="title">{{ strings().account.profile.heading }}</h1>
      </header>

      @if (savedMessage()) {
        <p
          class="status-message"
          role="status"
          aria-live="polite"
          data-testid="account-profile-status"
        >
          {{ savedMessage() }}
        </p>
      }

      @switch (state()) {
        @case ('loading') {
          <div
            class="loading"
            role="status"
            aria-live="polite"
            data-testid="account-profile-loading"
          >
            <app-spinner size="md" />
            <span>{{ strings().account.shared.loading }}</span>
          </div>
        }
        @case ('error') {
          <p class="error" role="alert" data-testid="account-profile-error">
            {{ strings().account.shared.loadError }}
          </p>
        }
        @case ('ready') {
          <app-profile-form
            [user]="user()"
            [saving]="saving()"
            [externalError]="formError()"
            (submit)="onSubmit($event)"
            (edited)="onProfileEdited()"
          />
          <!-- Finding N7: the backend accepted password and email changes all
               along; only the fields were missing, which is why the page's own
               error mappings for them were unreachable. -->
          <app-account-security-section
            [passwordBusy]="passwordSaving()"
            [emailBusy]="emailSaving()"
            [passwordExternalError]="passwordError()"
            [emailExternalError]="emailError()"
            [passwordSuccess]="passwordSuccessMessage()"
            [emailSuccess]="emailSuccessMessage()"
            (passwordChange)="onPasswordChange($event)"
            (emailChange)="onEmailChange($event)"
          />
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        padding-block: 1.5rem;
        padding-inline: 1rem;
        max-inline-size: 720px;
        margin-inline: auto;
      }
      .title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md page title */
        font-size: clamp(var(--brand-text-display-mobile), 4vw, var(--brand-text-display));
        font-weight: 700;
        color: var(--brand-text);
      }
      .status-message {
        margin: 0;
        padding-block: 0.625rem;
        padding-inline: 0.875rem;
        background-color: var(--brand-surface);
        color: var(--brand-text);
        border: 1px solid var(--brand-border);
        border-radius: var(--brand-radius-sm);
      }
      .loading {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        color: var(--brand-text-muted);
      }
      .error {
        margin: 0;
        padding-block: 0.625rem;
        padding-inline: 0.875rem;
        background-color: var(--brand-surface-strong);
        color: var(--brand-error);
        border-inline-start: 3px solid var(--brand-error);
        border-radius: var(--brand-radius-sm);
      }
    `,
  ],
})
export class AccountProfilePageComponent implements OnInit {
  private readonly locale = inject(LocaleService);
  private readonly authState = inject(AuthStateService);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly users = inject(UsersService);
  private readonly authSvc = inject(AuthService);

  protected readonly strings = this.locale.strings;
  protected readonly state = signal<PageState>('idle');
  protected readonly user = signal<CustomerUser | null>(null);
  protected readonly saving = signal<boolean>(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly savedMessage = signal<string | null>(null);
  protected readonly passwordSaving = signal<boolean>(false);
  protected readonly emailSaving = signal<boolean>(false);
  protected readonly passwordError = signal<string | null>(null);
  protected readonly emailError = signal<string | null>(null);
  protected readonly passwordSuccessMessage = signal<string | null>(null);
  protected readonly emailSuccessMessage = signal<string | null>(null);

  ngOnInit(): void {
    this.title.setTitle(
      pageTitle(this.strings().account.meta.profileTitle, this.strings().brand.name),
    );
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });

    if (!isPlatformBrowser(this.platformId)) return;
    void this.init();
  }

  /**
   * Browser-side entry. The state flips to `'loading'` BEFORE the guard is
   * awaited so the page never sits in the unrendered `'idle'` branch while
   * the session boot settles (finding N4).
   */
  private async init(): Promise<void> {
    this.state.set('loading');
    if (
      !(await ensureAuthedForAccount(
        { authState: this.authState, locale: this.locale, router: this.router },
        APP_ROUTES.account.profile(this.locale.locale()),
      ))
    ) {
      return;
    }
    void this.load();
  }

  private async load(): Promise<void> {
    this.state.set('loading');
    try {
      const me = await this.users.getMe();
      this.user.set(me);
      this.state.set('ready');
    } catch (cause) {
      if (cause instanceof StorefrontUnauthorizedError) {
        this.authState.clearSession();
        void ensureAuthedForAccount(
          { authState: this.authState, locale: this.locale, router: this.router },
          APP_ROUTES.account.profile(this.locale.locale()),
        );
        return;
      }
      if (cause instanceof StorefrontError) {
        this.state.set('error');
        return;
      }
      this.state.set('error');
    }
  }

  protected onProfileEdited(): void {
    this.formError.set(null);
    this.savedMessage.set(null);
  }

  protected async onSubmit(payload: UpdateProfileRequest): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.formError.set(null);
    this.savedMessage.set(null);
    try {
      const updated = await this.users.updateMe(payload);
      this.user.set(updated);
      this.savedMessage.set(this.strings().account.profile.saved);
    } catch (cause) {
      this.formError.set(this.profileSaveErrorMessageFor(cause));
      if (
        cause instanceof StorefrontUnauthorizedError &&
        cause.code !== 'PROFILE_CURRENT_PASSWORD_INCORRECT'
      ) {
        // Genuine session loss — clear and bounce to login. The
        // current-password-incorrect path shares HTTP 401 but is a
        // form-validation surface, not session expiry; treat it inline
        // so the customer can correct the password without losing the
        // profile-edit context. See
        // `specs/features/full-stack-audit-2026-05-14/plan.md` §1.1
        // row #11.
        this.authState.clearSession();
        void ensureAuthedForAccount(
          { authState: this.authState, locale: this.locale, router: this.router },
          APP_ROUTES.account.profile(this.locale.locale()),
        );
      }
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Password change rides the same `PATCH /v1/users/me` as the profile form.
   *
   * The API revokes EVERY session on success, including this one, which is
   * documented and audit-approved policy. So the page owns the outcome: say so
   * in the success copy, sign out, clear the local session deliberately, and
   * navigate to login. Letting the generic 401 handler discover it first would
   * read to the customer as a crash rather than as the thing they just asked
   * for.
   *
   * The `signOut()` is what makes "signs you out everywhere" true on THIS
   * device, and it is not redundant with the server-side revoke. Better Auth
   * keeps a signed session-cache cookie (constitution 3.3 caps it at five
   * minutes), and revoking the database row does not reach it: clearing only
   * the in-memory `AuthState` left that cookie in the browser, so the very
   * next full page load into /account re-authenticated from the cache and let
   * the customer straight back into the account they had just been told they
   * were signed out of. Signing out is what clears the cookie.
   */
  protected async onPasswordChange(change: PasswordChangeRequest): Promise<void> {
    if (this.passwordSaving()) return;
    this.passwordSaving.set(true);
    this.passwordError.set(null);
    this.passwordSuccessMessage.set(null);
    try {
      await this.users.updateMe({
        currentPassword: change.currentPassword,
        newPassword: change.newPassword,
      });
      this.passwordSuccessMessage.set(this.strings().account.security.passwordSuccess);
      // Best-effort, like `signOutAndGoHome`: a failed sign-out call must not
      // strand the customer on a page whose session the server has already
      // revoked.
      await this.authSvc.signOut();
      this.authState.clearSession();
      const from = APP_ROUTES.account.profile(this.locale.locale());
      void this.router.navigateByUrl(
        `${APP_ROUTES.auth.login(this.locale.locale())}?from=${encodeURIComponent(from)}`,
      );
    } catch (cause) {
      this.passwordError.set(this.profileSaveErrorMessageFor(cause));
    } finally {
      this.passwordSaving.set(false);
    }
  }

  /**
   * Email change routes through Better Auth's verified change-email flow, so
   * the API answers with the profile still carrying the OLD address: the change
   * commits only once the customer opens the confirmation link. The copy says
   * that, and the read-only email display stays the source of truth.
   */
  protected async onEmailChange(change: EmailChangeRequest): Promise<void> {
    if (this.emailSaving()) return;
    this.emailSaving.set(true);
    this.emailError.set(null);
    this.emailSuccessMessage.set(null);
    try {
      await this.users.updateMe({
        currentPassword: change.currentPassword,
        email: change.email,
      });
      // Deliberately does NOT adopt the response into `user`: the change is
      // pending confirmation, and showing the new address before the customer
      // has opened the link would say the change had landed when it has not.
      this.emailSuccessMessage.set(
        this.strings().account.security.emailSuccess.replace('{email}', change.email),
      );
    } catch (cause) {
      this.emailError.set(this.profileSaveErrorMessageFor(cause));
    } finally {
      this.emailSaving.set(false);
    }
  }

  /**
   * Map a backend `PATCH /v1/users/me` failure to a localized message.
   * Declared codes from `apps/api/src/modules/users/profile-*.exception.ts`
   * get dedicated copy in both FR + EN; unknown failures fall back to the
   * generic copy. See
   * `specs/features/full-stack-audit-2026-05-14/plan.md` §1.1 rows #10-12.
   */
  private profileSaveErrorMessageFor(err: unknown): string {
    const errors = this.strings().account.profile.errors;
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? String((err as { code: string }).code)
        : null;
    if (code === 'PROFILE_CURRENT_PASSWORD_REQUIRED') return errors.currentPasswordRequired;
    if (code === 'PROFILE_CURRENT_PASSWORD_INCORRECT') return errors.currentPasswordIncorrect;
    if (code === 'PROFILE_EMAIL_IN_USE') return errors.emailInUse;
    return errors.generic;
  }
}

export default AccountProfilePageComponent;

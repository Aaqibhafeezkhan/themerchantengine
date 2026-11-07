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
import { ActivatedRoute, Router } from '@angular/router';

import { NotificationPreferencesService } from '@storefront-services';
import {
  StorefrontError,
  StorefrontUnauthorizedError,
  type NotificationPreferences,
  type UpdateNotificationPreferencesRequest,
} from '@storefront-types';

import { LocaleService } from '../../../../locale.service';
import { AuthStateService } from '../../../../services/auth-state.service';
import { APP_ROUTES } from '../../../../../lib/routes';
import { PreferencesFormComponent } from '../../../../sections/account/preferences-form.component';
import { SpinnerComponent } from '../../../../ui/spinner.component';
import { ensureAuthedForAccount } from '../_account-auth-guard';
import { AccountNavComponent } from '../../../../sections/account/account-nav.component';
import { pageTitle } from '../../../../../lib/seo';

type PageState = 'idle' | 'loading' | 'ready' | 'error';

@Component({
  selector: 'app-account-preferences-page',
  standalone: true,
  imports: [AccountNavComponent, PreferencesFormComponent, SpinnerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" data-testid="account-preferences-page">
      <app-account-nav />
      <header class="header">
        <h1 class="title">{{ strings().account.preferences.heading }}</h1>
        <p class="subtitle">{{ strings().account.preferences.subheading }}</p>
      </header>

      @if (unsubscribedNotice()) {
        <p
          class="status-message"
          role="status"
          aria-live="polite"
          data-testid="account-preferences-unsub-notice"
        >
          {{ strings().account.preferences.unsubscribedNotice }}
        </p>
      }

      @if (savedMessage()) {
        <p
          class="status-message"
          role="status"
          aria-live="polite"
          data-testid="account-preferences-status"
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
            data-testid="account-preferences-loading"
          >
            <app-spinner size="md" />
            <span>{{ strings().account.shared.loading }}</span>
          </div>
        }
        @case ('error') {
          <p class="error" role="alert" data-testid="account-preferences-error">
            {{ strings().account.shared.loadError }}
          </p>
        }
        @case ('ready') {
          <app-preferences-form
            [preferences]="preferences()"
            [saving]="saving()"
            [externalError]="formError()"
            (submit)="onSubmit($event)"
            (edited)="onPreferencesEdited()"
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
      .subtitle {
        margin: 0;
        color: var(--brand-text-muted);
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
export class AccountPreferencesPageComponent implements OnInit {
  private readonly locale = inject(LocaleService);
  private readonly authState = inject(AuthStateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly prefs = inject(NotificationPreferencesService);

  protected readonly strings = this.locale.strings;
  protected readonly state = signal<PageState>('idle');
  protected readonly preferences = signal<NotificationPreferences | null>(null);
  protected readonly saving = signal<boolean>(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly savedMessage = signal<string | null>(null);
  protected readonly unsubscribedNotice = signal<boolean>(false);

  ngOnInit(): void {
    this.title.setTitle(
      pageTitle(this.strings().account.meta.preferencesTitle, this.strings().brand.name),
    );
    this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });
    // Surfaced when a customer arrives via the email footer unsubscribe link
    // (`/account/preferences?unsubscribed=<category>`).
    this.unsubscribedNotice.set(this.route.snapshot.queryParamMap.has('unsubscribed'));

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
        APP_ROUTES.account.preferences(this.locale.locale()),
      ))
    ) {
      return;
    }
    void this.load();
  }

  private async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.preferences.set(await this.prefs.getPreferences());
      this.state.set('ready');
    } catch (cause) {
      if (cause instanceof StorefrontUnauthorizedError) {
        this.authState.clearSession();
        void ensureAuthedForAccount(
          { authState: this.authState, locale: this.locale, router: this.router },
          APP_ROUTES.account.preferences(this.locale.locale()),
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

  protected onPreferencesEdited(): void {
    this.formError.set(null);
    this.savedMessage.set(null);
  }

  protected async onSubmit(payload: UpdateNotificationPreferencesRequest): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.formError.set(null);
    this.savedMessage.set(null);
    try {
      this.preferences.set(await this.prefs.updatePreferences(payload));
      this.savedMessage.set(this.strings().account.preferences.saved);
    } catch (cause) {
      if (cause instanceof StorefrontUnauthorizedError) {
        this.authState.clearSession();
        void ensureAuthedForAccount(
          { authState: this.authState, locale: this.locale, router: this.router },
          APP_ROUTES.account.preferences(this.locale.locale()),
        );
        return;
      }
      this.formError.set(this.strings().account.preferences.error);
    } finally {
      this.saving.set(false);
    }
  }
}

export default AccountPreferencesPageComponent;

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { LocaleService } from '../locale.service';
import { NewsletterService } from '@storefront-services';
import { TurnstileComponent } from '../sections/auth/turnstile.component';

@Component({
  selector: 'app-newsletter-signup',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, TurnstileComponent],
  styles: [
    `
      :host {
        display: block;
      }
      .heading {
        font-size: var(--brand-text-micro);
        font-weight: 500;
        color: var(--brand-on-primary);
        opacity: 0.7;
        margin-block: 0 0.75rem;
        margin-inline: 0;
      }
      .blurb {
        margin: 0 0 0.75rem;
        font-size: var(--brand-text-micro);
        line-height: 1.55;
        color: var(--brand-on-primary);
        opacity: 0.85;
        max-inline-size: 32ch;
      }
      form {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        align-items: stretch;
      }
      input {
        flex: 1 1 12rem;
        min-block-size: 44px;
        padding-inline: 0.75rem;
        padding-block: 0.5rem;
        font: inherit;
        color: var(--brand-on-primary);
        background-color: transparent;
        border: 1px solid var(--brand-on-primary);
        border-radius: var(--brand-radius-md);
      }
      input::placeholder {
        color: var(--brand-on-primary);
        opacity: 0.6;
      }
      input:focus-visible {
        outline: 2px solid var(--brand-on-primary);
        outline-offset: 2px;
      }
      button {
        min-block-size: 44px;
        min-inline-size: 44px;
        padding-inline: 1rem;
        font: inherit;
        font-weight: 600;
        color: var(--brand-text);
        background-color: var(--brand-on-primary);
        border: 1px solid var(--brand-on-primary);
        border-radius: var(--brand-radius-md);
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      button:focus-visible {
        outline: 2px solid var(--brand-on-primary);
        outline-offset: 2px;
      }
      .msg {
        margin: 0.625rem 0 0;
        font-size: var(--brand-text-micro);
        color: var(--brand-on-primary);
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
      /* Honeypot — off-screen, never shown to or focusable by real users. */
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
      app-turnstile {
        display: block;
        margin-block-start: 0.625rem;
      }
    `,
  ],
  template: `
    <section aria-labelledby="newsletter-heading" data-testid="newsletter-signup">
      <h2 id="newsletter-heading" class="heading">{{ t().heading }}</h2>
      <p class="blurb">{{ t().blurb }}</p>
      @if (status() === 'success') {
        <p class="msg" role="status" aria-live="polite" data-testid="newsletter-success">
          {{ t().success }}
        </p>
      } @else {
        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <label class="sr-only" for="newsletter-email">{{ t().label }}</label>
          <input
            id="newsletter-email"
            type="email"
            inputmode="email"
            autocomplete="email"
            formControlName="email"
            [placeholder]="t().placeholder"
            [attr.aria-invalid]="showInvalid() ? 'true' : null"
            [attr.aria-describedby]="showInvalid() ? 'newsletter-error' : null"
            (focus)="arm()"
            (input)="clearError()"
            data-testid="newsletter-email"
          />
          <!-- Honeypot — must stay empty. Off-screen + tab-skipped + aria-hidden so
               real users never see or fill it; a non-empty value is caught
               server-side (x-hp-field header) with no visible error. -->
          <input
            class="hp"
            type="text"
            formControlName="company"
            tabindex="-1"
            autocomplete="off"
            aria-hidden="true"
            data-testid="newsletter-company"
          />
          <button
            type="submit"
            [disabled]="status() === 'submitting'"
            data-testid="newsletter-submit"
          >
            {{ t().cta }}
          </button>
        </form>
        @if (captchaArmed()) {
          <app-turnstile (token)="onCaptchaToken($event)" />
        }
        @if (showInvalid()) {
          <p class="msg" id="newsletter-error" role="alert" data-testid="newsletter-invalid">
            {{ t().invalid }}
          </p>
        }
        @if (status() === 'error') {
          <p class="msg" role="alert" data-testid="newsletter-error">{{ t().error }}</p>
        }
      }
    </section>
  `,
})
export class NewsletterSignupComponent {
  private readonly fb = inject(FormBuilder);
  private readonly localeService = inject(LocaleService);
  private readonly newsletter = inject(NewsletterService);

  protected readonly locale = this.localeService.locale;
  protected readonly t = computed(() => this.localeService.strings().newsletter);
  readonly status = signal<'idle' | 'submitting' | 'success' | 'error'>('idle');

  /** Latest Turnstile token (null until solved / on expiry). */
  protected readonly captchaToken = signal<string | null>(null);
  /** Whether the Turnstile widget has been mounted (lazy — armed on focus). */
  protected readonly captchaArmed = signal(false);
  /** True when a token must be obtained before submit (site key configured). */
  protected readonly captchaRequired = !!(
    import.meta as unknown as { env?: Record<string, string> }
  ).env?.['VITE_TURNSTILE_SITE_KEY'];

  readonly form = this.fb.nonNullable.group({
    email: this.fb.nonNullable.control('', [Validators.required, Validators.email]),
    // Honeypot — no validator; a filled value is rejected server-side and must
    // never surface a visible error.
    company: this.fb.nonNullable.control(''),
  });

  protected showInvalid(): boolean {
    const c = this.form.controls.email;
    return c.touched && c.invalid;
  }

  /** Lazy-load the Turnstile widget only once the user engages the form. */
  protected arm(): void {
    if (this.captchaRequired) this.captchaArmed.set(true);
  }

  protected clearError(): void {
    if (this.status() === 'error') this.status.set('idle');
  }

  protected onCaptchaToken(token: string | null): void {
    this.captchaToken.set(token);
  }

  async submit(): Promise<void> {
    if (this.status() === 'submitting') return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    // When a site key is configured, hold the submit until the widget yields a
    // token; arm it (no-op if already mounted) so a token starts resolving.
    if (this.captchaRequired && !this.captchaToken()) {
      this.captchaArmed.set(true);
      return;
    }
    this.status.set('submitting');
    try {
      await this.newsletter.subscribe(
        {
          email: this.form.controls.email.value,
          locale: this.locale(),
        },
        { captchaToken: this.captchaToken(), honeypot: this.form.controls.company.value },
      );
      this.status.set('success');
      this.form.reset();
      this.captchaToken.set(null);
    } catch {
      this.status.set('error');
    }
  }
}

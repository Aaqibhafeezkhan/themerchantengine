import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NewsletterService } from '@storefront-services';

import { LocaleService } from '../locale.service';
import { renderComponent } from '../ui/testing';
import { NewsletterSignupComponent } from './newsletter-signup.component';

describe('NewsletterSignupComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  async function render(subscribe: () => Promise<unknown>) {
    return renderComponent(NewsletterSignupComponent, {}, [
      LocaleService,
      { provide: NewsletterService, useValue: { subscribe: vi.fn(subscribe) } },
    ]);
  }

  function type(host: HTMLElement, value: string): void {
    const input = host.querySelector('[data-testid="newsletter-email"]') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('shows the success message after a subscribe', async () => {
    const fixture = await render(async () => undefined);
    type(fixture.nativeElement, 'jane@example.com');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="newsletter-success"]'),
    ).not.toBeNull();
  });

  it('hides the failure message once the visitor edits the email', async () => {
    const fixture = await render(async () => {
      throw new Error('boom');
    });
    type(fixture.nativeElement, 'jane@example.com');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    const selector = '[data-testid="newsletter-error"]';
    expect(fixture.nativeElement.querySelector(selector)).not.toBeNull();
    type(fixture.nativeElement, 'jane@example.co');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(selector)).toBeNull();
  });
});

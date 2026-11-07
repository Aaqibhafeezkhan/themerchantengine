import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import { GiftCardFormComponent } from './gift-card-form.component';

describe('GiftCardFormComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders the form when no card is applied', async () => {
    const fixture = await renderComponent(GiftCardFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    expect(
      fixture.nativeElement.querySelector('[data-testid="cart-gift-card-form"]'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="cart-gift-card-applied"]'),
    ).toBeNull();
  });

  it('keeps submit disabled when code is shorter than the 8-char minimum', async () => {
    const fixture = await renderComponent(GiftCardFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cart-gift-card-input"]',
    ) as HTMLInputElement;
    input.value = 'SHORT12';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    const submit = fixture.nativeElement.querySelector(
      'button[data-testid="cart-gift-card-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('emits apply with the uppercased code on valid submit', async () => {
    const fixture = await renderComponent(GiftCardFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    let received: string | null = null;
    fixture.componentInstance.apply.subscribe((c: string) => {
      received = c;
    });
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cart-gift-card-input"]',
    ) as HTMLInputElement;
    input.value = 'FXGIFTWELCOME100';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    const submit = fixture.nativeElement.querySelector(
      'button[data-testid="cart-gift-card-submit"]',
    ) as HTMLButtonElement;
    submit.click();
    expect(received).toBe('FXGIFTWELCOME100');
  });

  it('renders the applied state when applied input is set', async () => {
    const fixture = await renderComponent(
      GiftCardFormComponent,
      { applied: { code: 'FXGIFTWELCOME100', balanceApplied: '50.00' } },
      [provideRouter([]), LocaleService],
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="cart-gift-card-applied"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('FXGIFTWELCOME100');
  });

  it('emits remove when remove button clicked in applied state', async () => {
    const fixture = await renderComponent(
      GiftCardFormComponent,
      { applied: { code: 'FXGIFTWELCOME100', balanceApplied: '50.00' } },
      [provideRouter([]), LocaleService],
    );
    let received = false;
    fixture.componentInstance.remove.subscribe(() => {
      received = true;
    });
    const btn = fixture.nativeElement.querySelector(
      'button[data-testid="cart-gift-card-remove"]',
    ) as HTMLButtonElement;
    btn.click();
    expect(received).toBe(true);
  });

  it('renders the format hint in the un-applied state', async () => {
    const fixture = await renderComponent(GiftCardFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    expect(
      fixture.nativeElement.querySelector('.hint')?.textContent?.trim().length,
    ).toBeGreaterThan(0);
  });

  it('emits edited when the customer types, so the page can clear a stale error (S2-14)', async () => {
    const fixture = await renderComponent(
      GiftCardFormComponent,
      { error: 'This gift card is not valid right now.' },
      [provideRouter([]), LocaleService],
    );
    let edits = 0;
    fixture.componentInstance.edited.subscribe(() => edits++);
    const input = fixture.nativeElement.querySelector(
      'input[data-testid="cart-gift-card-input"]',
    ) as HTMLInputElement;
    input.value = 'ABCD1234';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(edits).toBe(1);
  });

  it('axe — zero serious / critical violations on form state', async () => {
    const fixture = await renderComponent(GiftCardFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['region', 'landmark-one-main', 'page-has-heading-one'],
    });
  });

  it('axe — zero serious / critical violations on error state (hint + error coexist)', async () => {
    const fixture = await renderComponent(
      GiftCardFormComponent,
      { error: 'This gift card is not valid right now.' },
      [provideRouter([]), LocaleService],
    );
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['region', 'landmark-one-main', 'page-has-heading-one'],
    });
  });
});

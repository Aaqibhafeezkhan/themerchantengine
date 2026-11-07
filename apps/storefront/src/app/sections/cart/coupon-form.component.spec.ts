import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent } from '../../ui/testing';
import { CouponFormComponent } from './coupon-form.component';

describe('CouponFormComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders the form when no coupon is applied', async () => {
    const fixture = await renderComponent(CouponFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    expect(fixture.nativeElement.querySelector('[data-testid="cart-coupon-form"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="cart-coupon-applied"]')).toBeNull();
  });

  it('emits apply with the trimmed code on valid submit', async () => {
    const fixture = await renderComponent(CouponFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    let received: string | null = null;
    fixture.componentInstance.apply.subscribe((c: string) => {
      received = c;
    });
    const input = fixture.nativeElement.querySelector(
      '[data-testid="cart-coupon-input"]',
    ) as HTMLInputElement;
    input.value = 'FIXTURE10';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    const submit = fixture.nativeElement.querySelector(
      'button[data-testid="cart-coupon-submit"]',
    ) as HTMLButtonElement;
    submit.click();
    expect(received).toBe('FIXTURE10');
  });

  it('keeps submit disabled while pristine', async () => {
    const fixture = await renderComponent(CouponFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const submit = fixture.nativeElement.querySelector(
      'button[data-testid="cart-coupon-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('renders the applied state when applied input is set', async () => {
    const fixture = await renderComponent(
      CouponFormComponent,
      { applied: { code: 'FIXTURE10', discount: '10.00' } },
      [provideRouter([]), LocaleService],
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="cart-coupon-applied"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="cart-coupon-form"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('FIXTURE10');
  });

  it('emits remove when remove button clicked in applied state', async () => {
    const fixture = await renderComponent(
      CouponFormComponent,
      { applied: { code: 'FIXTURE10', discount: '10.00' } },
      [provideRouter([]), LocaleService],
    );
    let received = false;
    fixture.componentInstance.remove.subscribe(() => {
      received = true;
    });
    const btn = fixture.nativeElement.querySelector(
      'button[data-testid="cart-coupon-remove"]',
    ) as HTMLButtonElement;
    btn.click();
    expect(received).toBe(true);
  });

  it('renders error message when error input is set', async () => {
    const fixture = await renderComponent(CouponFormComponent, { error: 'Bad coupon' }, [
      provideRouter([]),
      LocaleService,
    ]);
    expect(
      fixture.nativeElement.querySelector('[data-testid="cart-coupon-error"]')?.textContent,
    ).toContain('Bad coupon');
  });

  it('emits edited when the customer types, so the page can clear a stale error (S2-14)', async () => {
    const fixture = await renderComponent(CouponFormComponent, { error: 'Bad coupon' }, [
      provideRouter([]),
      LocaleService,
    ]);
    let edits = 0;
    fixture.componentInstance.edited.subscribe(() => edits++);
    const input = fixture.nativeElement.querySelector(
      'input[data-testid="cart-coupon-input"]',
    ) as HTMLInputElement;
    input.value = 'SAVE1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(edits).toBe(1);
  });

  it('axe — zero serious / critical violations on form state', async () => {
    const fixture = await renderComponent(CouponFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['region', 'landmark-one-main', 'page-has-heading-one'],
    });
  });

  it('axe — zero serious / critical violations on error state', async () => {
    const fixture = await renderComponent(
      CouponFormComponent,
      { error: 'This promo code is not valid right now.' },
      [provideRouter([]), LocaleService],
    );
    await assertAxeClean(fixture.nativeElement, {
      disabledRules: ['region', 'landmark-one-main', 'page-has-heading-one'],
    });
  });
});

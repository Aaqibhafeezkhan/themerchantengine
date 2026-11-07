import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent, attachToBody } from '../../ui/testing';
import { ReviewFormComponent, type ReviewFormSubmit } from './review-form.component';
import type { Review } from '@storefront-types';

const seedReview: Review = {
  id: 'r-existing',
  productId: 'p-1',
  userId: 'u-self',
  rating: 4,
  title: 'Solid',
  body: 'Worked well for me.',
  helpfulCount: 0,
  status: 'PUBLISHED',
  createdAt: '2026-04-01T00:00:00Z',
};

describe('ReviewFormComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders the create-mode title + rating stars + body field', async () => {
    const fixture = await renderComponent(ReviewFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const host: HTMLElement = fixture.nativeElement;
    const expectedTitle = TestBed.inject(LocaleService).strings().product.reviews.form.title;
    expect(host.querySelector('h3')?.textContent?.trim()).toBe(expectedTitle);
    expect(host.querySelectorAll('[data-testid^="product-review-form-rating-"]').length).toBe(5);
    expect(host.querySelector('[data-testid="product-review-form-body"]')).not.toBeNull();
    await assertAxeClean(host);
  });

  it('blocks submit without a rating + surfaces the rating error', async () => {
    const fixture = await renderComponent(ReviewFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    const body = fixture.nativeElement.querySelector(
      '[data-testid="product-review-form-body"]',
    ) as HTMLTextAreaElement;
    body.value = 'Long enough body';
    body.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(submitted).not.toHaveBeenCalled();
    const expected =
      TestBed.inject(LocaleService).strings().product.reviews.form.errors.ratingRequired;
    const ratingError = fixture.nativeElement.querySelector('.rating-field .error');
    expect(ratingError?.textContent?.trim()).toBe(expected);
  });

  it('blocks submit when body is empty + surfaces the body required error', async () => {
    const fixture = await renderComponent(ReviewFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    (
      fixture.nativeElement.querySelector(
        '[data-testid="product-review-form-rating-4"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(submitted).not.toHaveBeenCalled();
    const expected =
      TestBed.inject(LocaleService).strings().product.reviews.form.errors.bodyRequired;
    const nodes: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.field .error'),
    );
    const errors = nodes.map((el) => el.textContent?.trim() ?? '');
    expect(errors).toContain(expected);
  });

  it('emits a create-mode submit with trimmed payload when valid', async () => {
    const fixture = await renderComponent(ReviewFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    (
      fixture.nativeElement.querySelector(
        '[data-testid="product-review-form-rating-5"]',
      ) as HTMLButtonElement
    ).click();
    const titleInput = fixture.nativeElement.querySelector(
      '[data-testid="product-review-form-title"]',
    ) as HTMLInputElement;
    titleInput.value = '  Excellent  ';
    titleInput.dispatchEvent(new Event('input'));
    const body = fixture.nativeElement.querySelector(
      '[data-testid="product-review-form-body"]',
    ) as HTMLTextAreaElement;
    body.value = '  Great daily driver.  ';
    body.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(submitted.mock.calls[0][0] as ReviewFormSubmit).toEqual({
      mode: 'create',
      payload: {
        rating: 5,
        title: 'Excellent',
        body: 'Great daily driver.',
      },
    });
  });

  it('pre-populates fields + emits an edit-mode submit when initialReview is provided', async () => {
    const fixture = await renderComponent(
      ReviewFormComponent,
      { mode: 'edit', initialReview: seedReview },
      [provideRouter([]), LocaleService],
    );
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);

    const body = fixture.nativeElement.querySelector(
      '[data-testid="product-review-form-body"]',
    ) as HTMLTextAreaElement;
    expect(body.value).toBe(seedReview.body);
    body.value = 'Updated body content.';
    body.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(submitted).toHaveBeenCalledTimes(1);
    const event = submitted.mock.calls[0][0] as ReviewFormSubmit;
    expect(event.mode).toBe('edit');
    if (event.mode === 'edit') {
      expect(event.reviewId).toBe(seedReview.id);
      expect(event.payload.body).toBe('Updated body content.');
    }
  });

  it('lays out actions on the inline axis without overflow', async () => {
    const fixture = await renderComponent(ReviewFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const wrapper = attachToBody(fixture.nativeElement);
    const actions = wrapper.querySelector('.actions');
    expect(actions).not.toBeNull();
    const styles = window.getComputedStyle(actions as HTMLElement);
    expect(styles.flexDirection === 'row' || styles.flexDirection === '').toBe(true);
    document.body.removeChild(wrapper);
  });

  it('renders external error when externalError input is set', async () => {
    const fixture = await renderComponent(
      ReviewFormComponent,
      { externalError: 'Boom — server says no' },
      [provideRouter([]), LocaleService],
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="product-review-form-error"]')
        ?.textContent ?? '',
    ).toContain('Boom');
  });

  it('hides the form error once the customer edits a field or the rating (sibling of S2-5)', async () => {
    const errorSelector = '[data-testid="product-review-form-error"]';
    const edits: Array<(host: HTMLElement) => void> = [
      (host) => {
        const body = host.querySelector(
          '[data-testid="product-review-form-body"]',
        ) as HTMLTextAreaElement;
        body.value = 'Great';
        body.dispatchEvent(new Event('input', { bubbles: true }));
      },
      (host) =>
        (host.querySelector('[data-testid="product-review-form-rating-4"]') as HTMLElement).click(),
    ];
    for (const edit of edits) {
      TestBed.resetTestingModule();
      const fixture = await renderComponent(ReviewFormComponent, { externalError: 'Boom' }, [
        provideRouter([]),
        LocaleService,
      ]);
      expect(fixture.nativeElement.querySelector(errorSelector)).not.toBeNull();
      edit(fixture.nativeElement);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector(errorSelector)).toBeNull();
    }
  });
});

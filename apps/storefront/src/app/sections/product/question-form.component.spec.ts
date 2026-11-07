import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { LocaleService } from '../../locale.service';
import { assertAxeClean, renderComponent, attachToBody } from '../../ui/testing';
import { QuestionFormComponent, type QuestionFormSubmit } from './question-form.component';

describe('QuestionFormComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders the title + question field', async () => {
    const fixture = await renderComponent(QuestionFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const host: HTMLElement = fixture.nativeElement;
    const expected = TestBed.inject(LocaleService).strings().product.questions.form.title;
    expect(host.querySelector('h3')?.textContent?.trim()).toBe(expected);
    expect(host.querySelector('[data-testid="product-question-form-question"]')).not.toBeNull();
    await assertAxeClean(host);
  });

  it('blocks submit when question is empty', async () => {
    const fixture = await renderComponent(QuestionFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
    fixture.detectChanges();
    expect(submitted).not.toHaveBeenCalled();
    const expected =
      TestBed.inject(LocaleService).strings().product.questions.form.errors.questionRequired;
    const err = fixture.nativeElement.querySelector('.error');
    expect(err?.textContent?.trim()).toBe(expected);
  });

  it('emits a trimmed payload when valid', async () => {
    const fixture = await renderComponent(QuestionFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    const ta = fixture.nativeElement.querySelector(
      '[data-testid="product-question-form-question"]',
    ) as HTMLTextAreaElement;
    ta.value = '  Does it ship to QA?  ';
    ta.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
    fixture.detectChanges();
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(submitted.mock.calls[0][0] as QuestionFormSubmit).toEqual({
      payload: { question: 'Does it ship to QA?' },
    });
  });

  it('blocks submit when only whitespace', async () => {
    const fixture = await renderComponent(QuestionFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    const ta = fixture.nativeElement.querySelector(
      '[data-testid="product-question-form-question"]',
    ) as HTMLTextAreaElement;
    ta.value = '   ';
    ta.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
    fixture.detectChanges();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('renders external error when externalError input is set', async () => {
    const fixture = await renderComponent(
      QuestionFormComponent,
      { externalError: 'Server says no' },
      [provideRouter([]), LocaleService],
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="product-question-form-error"]')
        ?.textContent ?? '',
    ).toContain('Server says no');
  });

  it('hides the form error once the customer edits the question (sibling of S2-5)', async () => {
    const fixture = await renderComponent(
      QuestionFormComponent,
      { externalError: 'Server says no' },
      [provideRouter([]), LocaleService],
    );
    const errorSelector = '[data-testid="product-question-form-error"]';
    expect(fixture.nativeElement.querySelector(errorSelector)).not.toBeNull();
    const ta = fixture.nativeElement.querySelector(
      '[data-testid="product-question-form-question"]',
    ) as HTMLTextAreaElement;
    ta.value = 'Does it ship to QA?';
    ta.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(errorSelector)).toBeNull();
  });

  it('lays out actions on the inline axis', async () => {
    const fixture = await renderComponent(QuestionFormComponent, {}, [
      provideRouter([]),
      LocaleService,
    ]);
    const wrapper = attachToBody(fixture.nativeElement);
    expect(wrapper.querySelector('.actions')).not.toBeNull();
    document.body.removeChild(wrapper);
  });
});

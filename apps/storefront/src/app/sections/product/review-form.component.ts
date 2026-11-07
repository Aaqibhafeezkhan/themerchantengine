import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  inject,
  input,
  OnChanges,
  Output,
  signal,
  SimpleChanges,
  viewChildren,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import {
  createReviewRequestSchema,
  type CreateReviewRequest,
  type Review,
  type UpdateReviewRequest,
} from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { ButtonComponent } from '../../ui/button.component';

let nextInstanceId = 0;

export type ReviewFormMode = 'create' | 'edit';

export type ReviewFormSubmit =
  | { mode: 'create'; payload: CreateReviewRequest }
  | { mode: 'edit'; reviewId: string; payload: UpdateReviewRequest };

const STARS = [1, 2, 3, 4, 5] as const;

@Component({
  selector: 'product-review-form',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="form"
      [formGroup]="form"
      (ngSubmit)="onSubmit()"
      (input)="formError.set(null)"
      novalidate
      [attr.aria-labelledby]="titleId"
      [attr.data-testid]="'product-review-form-' + (initialReview()?.id ?? 'new')"
      data-testid-shared="product-review-form"
    >
      <h3 [id]="titleId" class="title">
        {{
          mode() === 'edit'
            ? strings().product.reviews.form.editTitle
            : strings().product.reviews.form.title
        }}
      </h3>

      <fieldset class="rating-field" [attr.aria-describedby]="ratingHintId">
        <legend class="label">{{ strings().product.reviews.form.ratingLabel }}</legend>
        <div
          class="stars"
          role="radiogroup"
          [attr.aria-label]="strings().product.reviews.form.ratingLabel"
        >
          @for (n of stars; track n) {
            <button
              #starBtn
              type="button"
              class="star-btn"
              role="radio"
              [attr.aria-checked]="ratingValue() === n"
              [attr.aria-label]="ratingButtonLabel(n)"
              [tabindex]="ratingTabIndex(n)"
              [class.filled]="ratingValue() >= n"
              (click)="setRating(n)"
              (keydown)="onRatingKey($event, n)"
              [attr.data-testid]="'product-review-form-rating-' + n"
            >
              <span aria-hidden="true">★</span>
            </button>
          }
        </div>
        <span [id]="ratingHintId" class="helper">
          {{ strings().product.reviews.form.ratingHint }}
        </span>
        <span [id]="ratingErrorId" class="error" aria-live="polite">
          @if (showRatingError()) {
            {{ strings().product.reviews.form.errors.ratingRequired }}
          }
        </span>
      </fieldset>

      <label class="field">
        <span class="label">{{ strings().product.reviews.form.titleLabel }}</span>
        <input
          [id]="fieldId('title')"
          formControlName="title"
          type="text"
          maxlength="200"
          [placeholder]="strings().product.reviews.form.titlePlaceholder"
          [attr.aria-describedby]="showTitleError() ? errorId('title') : null"
          [attr.aria-invalid]="showTitleError() ? 'true' : null"
          data-testid="product-review-form-title"
        />
        <span [id]="errorId('title')" class="error" aria-live="polite">
          @if (showTitleError()) {
            {{ strings().product.reviews.form.errors.titleTooLong }}
          }
        </span>
      </label>

      <label class="field">
        <span class="label">{{ strings().product.reviews.form.bodyLabel }}</span>
        <textarea
          [id]="fieldId('body')"
          formControlName="body"
          rows="4"
          maxlength="5000"
          required
          [placeholder]="strings().product.reviews.form.bodyPlaceholder"
          [attr.aria-describedby]="showBodyError() ? errorId('body') : null"
          [attr.aria-invalid]="showBodyError() ? 'true' : null"
          data-testid="product-review-form-body"
        ></textarea>
        <span [id]="errorId('body')" class="error" aria-live="polite">
          @if (showBodyError()) {
            @if (form.controls.body.errors?.['required']) {
              {{ strings().product.reviews.form.errors.bodyRequired }}
            } @else {
              {{ strings().product.reviews.form.errors.bodyTooLong }}
            }
          }
        </span>
      </label>

      @if (formError()) {
        <p class="form-error" role="alert" data-testid="product-review-form-error">
          {{ formError() }}
        </p>
      }

      <div class="actions">
        <app-button
          type="submit"
          variant="primary"
          [loading]="saving()"
          testId="product-review-form-submit"
        >
          {{
            saving()
              ? strings().product.reviews.form.submitting
              : strings().product.reviews.form.submit
          }}
        </app-button>
        @if (mode() === 'edit') {
          <button
            type="button"
            class="link-btn"
            (click)="cancelled.emit()"
            data-testid="product-review-form-cancel"
          >
            {{ strings().product.reviews.form.cancel }}
          </button>
        }
      </div>
    </form>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        padding-block: 1rem;
        padding-inline: 1rem;
        border: 1px solid var(--brand-border);
        background-color: var(--brand-surface);
      }
      .title {
        margin: 0;
        font-family: var(
          --brand-font-display
        ); /* agent_docs/storefront/brand-tokens.md section title */
        font-size: var(--brand-text-section);
        font-weight: 600;
        color: var(--brand-text);
      }
      .label {
        display: block;
        color: var(--brand-text);
        font-size: var(--brand-text-body);
        font-weight: 500;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .field input,
      .field textarea {
        background-color: var(--brand-surface);
        color: var(--brand-text);
        /* agent_docs/storefront/brand-tokens.md: a control resting boundary is load-bearing. */
        border: 1px solid var(--brand-border-interactive);
        padding-inline: 0.75rem;
        padding-block: 0.5rem;
        font-size: var(--brand-text-body);
        font-family: inherit;
      }
      .field input:focus-visible,
      .field textarea:focus-visible,
      .list-row input:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .helper {
        color: var(--brand-text-muted);
        font-size: var(--brand-text-micro);
      }
      .error {
        color: var(--brand-error);
        font-size: var(--brand-text-micro);
        min-block-size: 1rem;
      }
      .rating-field,
      .list-field {
        border: 0;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }
      .stars {
        display: inline-flex;
        gap: 0.25rem;
      }
      .star-btn {
        background: transparent;
        border: 0;
        cursor: pointer;
        font-size: 28px;
        line-height: 1;
        /* WCAG 1.4.11: this is the rating radiogroup itself, so an unselected
           star must still read as a selectable control. The border token is
           1.38:1 against the surface a form control grounds on. */
        color: var(--brand-text-muted);
        padding: 0.5rem;
        min-inline-size: 44px;
        min-block-size: 44px;
      }
      .star-btn.filled {
        color: var(--brand-text);
      }
      .star-btn:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .list-row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        margin-block-end: 0.375rem;
      }
      .list-row input {
        flex: 1;
        background-color: var(--brand-surface);
        color: var(--brand-text);
        /* agent_docs/storefront/brand-tokens.md: a control resting boundary is load-bearing. */
        border: 1px solid var(--brand-border-interactive);
        padding-inline: 0.625rem;
        padding-block: 0.4rem;
        font-size: var(--brand-text-body);
      }
      .form-error {
        color: var(--brand-error);
        margin: 0;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .link-btn {
        background: transparent;
        border: 0;
        color: var(--brand-primary);
        cursor: pointer;
        font: inherit;
        padding-block: 0.5rem;
        padding-inline: 0.25rem;
        min-block-size: 44px;
      }
      .link-btn:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
    `,
  ],
})
export class ReviewFormComponent implements OnChanges {
  readonly mode = input<ReviewFormMode>('create');
  readonly initialReview = input<Review | null>(null);
  readonly saving = input<boolean>(false);
  readonly externalError = input<string | null>(null);

  @Output() readonly submitted = new EventEmitter<ReviewFormSubmit>();
  @Output() readonly cancelled = new EventEmitter<void>();

  protected readonly stars = STARS;
  private readonly fb = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;

  protected readonly formError = signal<string | null>(null);
  protected readonly ratingValue = signal<number>(0);
  private readonly starButtons = viewChildren<ElementRef<HTMLButtonElement>>('starBtn');

  private readonly instanceId = nextInstanceId++;
  protected readonly titleId = `product-review-form-title-${this.instanceId}`;
  protected readonly ratingHintId = `product-review-rating-hint-${this.instanceId}`;
  protected readonly ratingErrorId = `product-review-rating-error-${this.instanceId}`;

  protected fieldId(name: string): string {
    return `product-review-${name}-${this.instanceId}`;
  }
  protected errorId(name: string): string {
    return `product-review-${name}-error-${this.instanceId}`;
  }

  protected readonly form = this.fb.nonNullable.group({
    rating: this.fb.nonNullable.control(0, [Validators.min(1), Validators.max(5)]),
    title: this.fb.nonNullable.control('', [Validators.maxLength(200)]),
    body: this.fb.nonNullable.control('', [Validators.required, Validators.maxLength(5000)]),
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialReview']) {
      const r = this.initialReview();
      if (r) {
        this.form.controls.rating.setValue(r.rating);
        this.form.controls.title.setValue(r.title ?? '');
        this.form.controls.body.setValue(r.body);
        this.ratingValue.set(r.rating);
      } else {
        this.form.reset({ rating: 0, title: '', body: '' });
        this.ratingValue.set(0);
      }
    }
    if (changes['externalError']) {
      this.formError.set(this.externalError());
    }
  }

  protected setRating(value: number): void {
    this.formError.set(null);
    this.ratingValue.set(value);
    this.form.controls.rating.setValue(value);
    this.form.controls.rating.markAsDirty();
    this.form.controls.rating.markAsTouched();
  }

  protected ratingTabIndex(value: number): number {
    const current = this.ratingValue();
    if (current === 0) return value === 1 ? 0 : -1;
    return current === value ? 0 : -1;
  }

  protected ratingButtonLabel(value: number): string {
    const t = this.strings().product.reviews.starsLabel;
    return t.replace('{rating}', String(value));
  }

  protected onRatingKey(event: KeyboardEvent, value: number): void {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = Math.min(5, value + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = Math.max(1, value - 1);
    } else if (event.key === 'Home') {
      next = 1;
    } else if (event.key === 'End') {
      next = 5;
    }
    if (next !== null) {
      event.preventDefault();
      this.setRating(next);
      const btn = this.starButtons().at(next - 1);
      btn?.nativeElement.focus();
    }
  }

  protected showRatingError(): boolean {
    const ctrl = this.form.controls.rating;
    return ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  protected showTitleError(): boolean {
    const ctrl = this.form.controls.title;
    return ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  protected showBodyError(): boolean {
    const ctrl = this.form.controls.body;
    return ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  protected onSubmit(): void {
    if (this.saving()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const raw = this.form.getRawValue();
    const trimmedTitle = raw.title.trim();
    const trimmedBody = raw.body.trim();

    if (trimmedBody.length === 0) {
      this.form.controls.body.setErrors({ required: true });
      this.form.markAllAsTouched();
      return;
    }

    const payload: CreateReviewRequest = {
      rating: raw.rating,
      body: trimmedBody,
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
    };

    const parsed = createReviewRequestSchema.safeParse(payload);
    if (!parsed.success) {
      this.formError.set(this.strings().product.reviews.form.errors.generic);
      return;
    }

    this.formError.set(null);
    if (this.mode() === 'edit') {
      const r = this.initialReview();
      if (!r) return;
      this.submitted.emit({ mode: 'edit', reviewId: r.id, payload: parsed.data });
    } else {
      this.submitted.emit({ mode: 'create', payload: parsed.data });
    }
  }

  reset(): void {
    this.form.reset({ rating: 0, title: '', body: '' });
    this.ratingValue.set(0);
    this.formError.set(null);
  }
}

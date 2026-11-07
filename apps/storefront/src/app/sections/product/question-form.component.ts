import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  inject,
  input,
  OnChanges,
  Output,
  signal,
  SimpleChanges,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { createQuestionRequestSchema, type CreateQuestionRequest } from '@storefront-types';

import { LocaleService } from '../../locale.service';
import { ButtonComponent } from '../../ui/button.component';

let nextInstanceId = 0;

export interface QuestionFormSubmit {
  payload: CreateQuestionRequest;
}

@Component({
  selector: 'product-question-form',
  standalone: true,
  imports: [ButtonComponent, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="form"
      [formGroup]="form"
      (ngSubmit)="onSubmit()"
      novalidate
      [attr.aria-labelledby]="titleId"
      data-testid="product-question-form"
    >
      <h3 [id]="titleId" class="title">{{ strings().product.questions.form.title }}</h3>
      <label class="field">
        <span class="label">{{ strings().product.questions.form.questionLabel }}</span>
        <textarea
          [id]="fieldId('question')"
          formControlName="question"
          (input)="formError.set(null)"
          rows="3"
          maxlength="1000"
          required
          [placeholder]="strings().product.questions.form.questionPlaceholder"
          [attr.aria-describedby]="showError() ? errorId('question') : null"
          [attr.aria-invalid]="showError() ? 'true' : null"
          data-testid="product-question-form-question"
        ></textarea>
        <span [id]="errorId('question')" class="error" aria-live="polite">
          @if (showError()) {
            @if (form.controls.question.errors?.['required']) {
              {{ strings().product.questions.form.errors.questionRequired }}
            } @else {
              {{ strings().product.questions.form.errors.questionTooLong }}
            }
          }
        </span>
      </label>
      @if (formError()) {
        <p class="form-error" role="alert" data-testid="product-question-form-error">
          {{ formError() }}
        </p>
      }
      <div class="actions">
        <app-button
          type="submit"
          variant="primary"
          [loading]="saving()"
          testId="product-question-form-submit"
        >
          {{
            saving()
              ? strings().product.questions.form.submitting
              : strings().product.questions.form.submit
          }}
        </app-button>
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
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .label {
        color: var(--brand-text);
        font-size: var(--brand-text-body);
        font-weight: 500;
      }
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
      .field textarea:focus-visible {
        outline: 2px solid var(--brand-focus);
        outline-offset: 2px;
      }
      .error {
        color: var(--brand-error);
        font-size: var(--brand-text-micro);
        min-block-size: 1rem;
      }
      .form-error {
        color: var(--brand-error);
        margin: 0;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 1rem;
      }
    `,
  ],
})
export class QuestionFormComponent implements OnChanges {
  readonly saving = input<boolean>(false);
  readonly externalError = input<string | null>(null);

  @Output() readonly submitted = new EventEmitter<QuestionFormSubmit>();

  private readonly fb = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  protected readonly strings = this.locale.strings;
  protected readonly formError = signal<string | null>(null);

  private readonly instanceId = nextInstanceId++;
  protected readonly titleId = `product-question-form-title-${this.instanceId}`;
  protected fieldId(name: string): string {
    return `product-question-${name}-${this.instanceId}`;
  }
  protected errorId(name: string): string {
    return `product-question-${name}-error-${this.instanceId}`;
  }

  protected readonly form = this.fb.nonNullable.group({
    question: this.fb.nonNullable.control('', [Validators.required, Validators.maxLength(1000)]),
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['externalError']) {
      this.formError.set(this.externalError());
    }
  }

  protected showError(): boolean {
    const ctrl = this.form.controls.question;
    return ctrl.invalid && (ctrl.dirty || ctrl.touched);
  }

  protected onSubmit(): void {
    if (this.saving()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const trimmed = this.form.controls.question.value.trim();
    if (trimmed.length === 0) {
      this.form.controls.question.setErrors({ required: true });
      this.form.markAllAsTouched();
      return;
    }
    const parsed = createQuestionRequestSchema.safeParse({ question: trimmed });
    if (!parsed.success) {
      this.formError.set(this.strings().product.questions.form.errors.generic);
      return;
    }
    this.formError.set(null);
    this.submitted.emit({ payload: parsed.data });
  }

  reset(): void {
    this.form.reset({ question: '' });
    this.formError.set(null);
  }
}

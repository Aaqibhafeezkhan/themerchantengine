import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  BadgeComponent,
  ButtonComponent,
  FormFieldComponent,
  InputComponent,
  SkeletonComponent,
  TranslatableInputComponent,
  TranslatableRichTextComponent,
  openAssetPicker,
  openConfirmDialog,
  type TranslatableValue,
} from '@admin-ui';
import {
  AssetsService,
  CategoriesService,
  type Asset,
  type Category,
  type CreateCategoryRequest,
  type UpdateCategoryRequest,
} from '@admin-services';
import { ApiConflictError, ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { Subject, takeUntil } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import { translatableRequired } from '../../shared/validators/translatable-required.validator';
import { assetAltText } from '../assets/assets.utils';
import { categoryLabel, flattenForParentPicker } from './categories.utils';
import { pluralize } from '../../shared/format/pluralize';
import { StoreSettingsStore } from '../../core/stores/store-settings.store';

type Mode = 'create' | 'edit';

function findById(nodes: readonly Category[], id: string): Category | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const hit = findById(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * `/categories/new` + `/categories/:id` share this page. The mode is
 * derived from the route — no route data required. Both rely on the
 * same `CategoriesService.tree()` to populate the parent picker (every
 * tree node is a parent candidate except the category itself + its
 * descendants, which `flattenForParentPicker` filters out).
 */
@Component({
  selector: 'app-category-form-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    BadgeComponent,
    ButtonComponent,
    FormFieldComponent,
    InputComponent,
    SkeletonComponent,
    TranslatableInputComponent,
    TranslatableRichTextComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="p-6 md:p-10 flex flex-col gap-8"
      data-testid="category-form-page"
      [attr.aria-busy]="loading() ? 'true' : null"
    >
      <nav class="text-xs tracking-widest uppercase text-ink-muted" aria-label="Breadcrumb">
        <a
          routerLink="/categories"
          class="hover:text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
        >
          Categories
        </a>
        <span aria-hidden="true" class="mx-2">/</span>
        <span class="text-ink" aria-current="page">
          {{ mode() === 'create' ? 'New' : (current()?.slug ?? '…') }}
        </span>
      </nav>

      <div role="alert" aria-live="assertive" data-testid="category-form-error">
        @if (error()) {
          <p class="border border-status-error text-ink p-3 tabular text-xs">
            {{ error() }}
          </p>
        }
      </div>

      @if (loading()) {
        <div class="flex flex-col gap-4">
          <app-skeleton height="2rem" width="40%" />
          <app-skeleton height="10rem" width="100%" />
        </div>
      } @else {
        <header class="flex items-end justify-between gap-6 flex-wrap">
          <div class="min-w-0">
            <p class="text-xs tracking-widest uppercase text-ink-muted">
              {{ mode() === 'create' ? 'New category' : 'Edit category' }}
            </p>
            <h1 class="mt-2 text-3xl md:text-4xl font-bold tracking-tight truncate">
              {{ mode() === 'create' ? 'Category' : current() ? currentLabel() : 'Category' }}
            </h1>
            @if (mode() === 'edit' && current(); as c) {
              <p class="mt-3 tabular text-sm text-ink-muted">/{{ c.slug }}</p>
            }
          </div>
          @if (mode() === 'edit' && current(); as c) {
            <div class="flex items-center gap-2 flex-wrap">
              @if (!c.isVisible) {
                <app-badge tone="warning" [ariaLabel]="'Category hidden from storefront'">
                  Hidden
                </app-badge>
              }
              <app-badge tone="neutral">
                {{ pluralize(c.productCount ?? 0, 'product') }}
              </app-badge>
              <span aria-live="polite" aria-atomic="true" class="inline-flex">
                @if (saved()) {
                  <app-badge tone="success" [ariaLabel]="'Changes saved'">Saved</app-badge>
                }
              </span>
            </div>
          }
        </header>

        <form
          [formGroup]="form"
          (ngSubmit)="save()"
          class="flex flex-col gap-5 max-w-3xl"
          novalidate
        >
          <app-form-field label="Name" fieldId="category-name" [required]="true">
            <app-translatable-input
              formControlName="name"
              label="Name"
              inputId="category-name"
              idPrefix="category-name"
              testId="category-name"
            ></app-translatable-input>
          </app-form-field>

          <app-form-field
            label="Slug"
            fieldId="category-slug"
            [error]="slugError()"
            hint="Lowercase, hyphen-separated. Visible in the public URL."
            [required]="true"
          >
            <app-input
              id="category-slug"
              type="text"
              formControlName="slug"
              [invalid]="!!slugError()"
            ></app-input>
          </app-form-field>

          <app-form-field label="Parent category" fieldId="category-parent">
            <select
              id="category-parent"
              class="w-full min-h-[44px] px-3 py-2 tabular text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2 disabled:bg-surface-elevated disabled:text-ink-muted disabled:cursor-not-allowed"
              formControlName="parentId"
              data-testid="category-parent-select"
            >
              <option [ngValue]="null">Top level</option>
              @for (opt of parentOptions(); track opt.id) {
                <option [ngValue]="opt.id">{{ indent(opt.depth) }}{{ opt.label }}</option>
              }
            </select>
          </app-form-field>

          <app-form-field label="Description" fieldId="category-description">
            <app-translatable-rich-text
              formControlName="description"
              label="Description"
              idPrefix="category-description"
              inputId="category-description"
              testId="category-description"
            ></app-translatable-rich-text>
          </app-form-field>

          <div
            role="group"
            aria-labelledby="category-image-label"
            aria-describedby="category-image-hint"
            class="flex flex-col gap-2"
          >
            <p id="category-image-label" class="text-sm font-medium text-ink">
              Category image (optional)
            </p>
            <p id="category-image-hint" class="text-xs tabular text-ink-muted">
              Pick from the asset library. Used on the storefront category card.
            </p>
            <div class="flex items-center gap-3 flex-wrap">
              @if (thumbUrl(); as src) {
                <img
                  [src]="src"
                  [alt]="imageLabel()"
                  class="h-10 w-10 object-cover border border-line"
                  data-testid="category-image-thumb"
                />
              }
              <span
                class="tabular text-xs text-ink-muted truncate min-w-0 max-w-[24ch]"
                data-testid="category-image-id"
              >
                {{ imageLabel() }}
              </span>
              <app-button
                type="button"
                variant="ghost"
                size="sm"
                [ariaLabel]="
                  form.controls.imageId.value ? 'Change category image' : 'Choose category image'
                "
                (clicked)="pickImage()"
                data-testid="category-image-pick"
              >
                {{ form.controls.imageId.value ? 'Change image' : 'Choose image' }}
              </app-button>
              @if (form.controls.imageId.value) {
                <app-button
                  type="button"
                  variant="ghost"
                  size="sm"
                  ariaLabel="Remove category image"
                  (clicked)="clearImage()"
                  data-testid="category-image-remove"
                >
                  Remove image
                </app-button>
              }
            </div>
          </div>

          <div class="flex items-center gap-6 flex-wrap">
            <label class="inline-flex items-center gap-3 text-sm tabular">
              <input
                type="checkbox"
                formControlName="isVisible"
                class="h-4 w-4 accent-ink"
                data-testid="category-visible"
              />
              Visible on storefront
            </label>
          </div>

          <footer
            class="sticky bottom-0 -mx-6 md:-mx-10 px-6 md:px-10 py-4 bg-surface border-t border-line flex flex-wrap items-center justify-between gap-3"
          >
            <div class="flex items-center gap-3">
              @if (mode() === 'edit' && canDelete()) {
                <app-button
                  type="button"
                  variant="destructive"
                  size="sm"
                  [disabled]="busy()"
                  [loading]="busy() && action() === 'delete'"
                  (clicked)="confirmDelete()"
                  data-testid="category-delete"
                >
                  Delete category
                </app-button>
              }
              <p class="text-xs tabular text-ink-muted">
                {{ form.dirty ? 'Unsaved changes' : 'No changes' }}
              </p>
            </div>
            <div class="flex items-center gap-3">
              <app-button
                type="button"
                variant="ghost"
                size="sm"
                [disabled]="busy()"
                routerLink="/categories"
                data-testid="category-cancel"
              >
                Cancel
              </app-button>
              <app-button
                type="submit"
                variant="primary"
                size="md"
                [disabled]="form.invalid || busy() || (mode() === 'edit' && !form.dirty)"
                [loading]="busy() && action() === 'save'"
                data-testid="category-save"
              >
                {{ mode() === 'create' ? 'Create category' : 'Save changes' }}
              </app-button>
            </div>
          </footer>
        </form>
      }
    </section>
  `,
})
export class CategoryFormPage implements OnInit, OnDestroy {
  protected readonly pluralize = pluralize;
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly categoriesService = inject(CategoriesService);
  private readonly assetsService = inject(AssetsService);
  private readonly authStore = inject(AuthStore);
  private readonly storeSettings = inject(StoreSettingsStore);
  private readonly dialog = inject(Dialog);
  private readonly fb = inject(FormBuilder);
  private readonly destroy$ = new Subject<void>();

  readonly mode = signal<Mode>('create');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly current = signal<Category | null>(null);
  readonly tree = signal<readonly Category[]>([]);
  readonly busy = signal(false);
  readonly action = signal<'save' | 'delete' | null>(null);
  readonly saved = signal(false);

  /** The full Asset behind `imageId`, so the picker confirmation can show a
   *  thumbnail + alt instead of the raw UUID. Hydrated on pick and, for the
   *  edit path, by resolving `category.imageId` through AssetsService. */
  readonly selectedAsset = signal<Asset | null>(null);

  /** Thumbnail URL for the selected asset, or null when none/unavailable. */
  protected thumbUrl(): string | null {
    const asset = this.selectedAsset();
    return asset ? (this.assetsService.tryPublicVariantUrl(asset, 'thumbnail')?.url ?? null) : null;
  }

  /** Readable confirmation label — never the raw UUID. */
  protected imageLabel(): string {
    const asset = this.selectedAsset();
    if (asset)
      return (
        assetAltText(asset, this.authStore.locale(), this.storeSettings.defaultLocale()) ||
        'Selected image'
      );
    return this.form.controls.imageId.value ? 'Image selected' : 'No image selected';
  }

  readonly currentLabel = computed(() => {
    const c = this.current();
    return c ? categoryLabel(c, this.authStore.locale(), this.storeSettings.defaultLocale()) : '';
  });

  readonly parentOptions = computed(() => {
    const excludeId = this.mode() === 'edit' ? (this.current()?.id ?? null) : null;
    return flattenForParentPicker(
      this.tree(),
      excludeId,
      this.authStore.locale(),
      this.storeSettings.defaultLocale(),
    );
  });

  readonly canDelete = computed(() =>
    this.authStore.hasAnyPermission(['categories:delete', 'categories:manage']),
  );

  readonly form = this.fb.nonNullable.group({
    name: this.fb.nonNullable.control<TranslatableValue>({ default: '' }, [translatableRequired]),
    slug: this.fb.nonNullable.control('', [
      Validators.required,
      Validators.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    ]),
    parentId: this.fb.control<string | null>(null),
    description: this.fb.nonNullable.control<TranslatableValue>({ default: '' }),
    isVisible: this.fb.nonNullable.control(true),
    imageId: this.fb.control<string | null>(null),
  });

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      const id = params.get('id');
      this.mode.set(id ? 'edit' : 'create');
      this.fetchTree(id);
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  slugError(): string | null {
    const c = this.form.controls.slug;
    if (!c.touched || c.valid) return null;
    if (c.hasError('required')) return 'Slug is required.';
    if (c.hasError('pattern')) return 'Lowercase letters, digits, and hyphens only.';
    return null;
  }

  indent(depth: number): string {
    return depth === 0 ? '' : '  '.repeat(depth) + '↳ ';
  }

  save(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.busy()) return;
    if (this.mode() === 'edit' && !this.form.dirty) return;

    const raw = this.form.getRawValue();
    const body: CreateCategoryRequest = {
      name: raw.name,
      slug: raw.slug,
      ...(raw.parentId ? { parentId: raw.parentId } : {}),
      ...(this.hasTranslatableContent(raw.description) ? { description: raw.description } : {}),
      isVisible: raw.isVisible,
      ...(raw.imageId ? { imageId: raw.imageId } : {}),
    };

    this.startAction('save');
    const req$ =
      this.mode() === 'create'
        ? this.categoriesService.create(body)
        : this.categoriesService.update(this.current()!.id, body as UpdateCategoryRequest);

    req$.subscribe({
      next: (updated) => {
        this.current.set(updated);
        this.form.markAsPristine();
        this.finishAction();
        if (this.mode() === 'create') {
          void this.router.navigate(['/categories', updated.id]);
        }
      },
      error: (err: unknown) => this.failAction(err, 'Could not save category.'),
    });
  }

  private deleteBody(current: Category): string {
    const label = categoryLabel(
      current,
      this.authStore.locale(),
      this.storeSettings.defaultLocale(),
    );
    const count = current.productCount ?? 0;
    if (count === 0) return `"${label}" will be removed from the storefront.`;
    return `"${label}" still has ${pluralize(count, 'product')}. The server refuses to delete it until they are reassigned.`;
  }

  async confirmDelete(): Promise<void> {
    const current = this.current();
    if (!current || this.busy()) return;
    const ok = await openConfirmDialog(this.dialog, {
      title: 'Delete this category?',
      body: this.deleteBody(current),
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (!ok) return;

    this.startAction('delete');
    this.categoriesService.delete(current.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.action.set(null);
        void this.router.navigate(['/categories']);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.action.set(null);
        if (err instanceof ApiConflictError && err.code === 'CATEGORY_HAS_PRODUCTS') {
          this.error.set(
            'Cannot delete: products still reference this category. Reassign them first.',
          );
        } else {
          this.error.set(this.formatError(err, 'Could not delete category.'));
        }
      },
    });
  }

  private fetchTree(editId: string | null): void {
    this.loading.set(true);
    this.error.set(null);
    this.categoriesService
      .tree()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (nodes) => {
          this.tree.set(nodes);
          if (editId) {
            const hit = findById(nodes, editId);
            if (!hit) {
              this.error.set('Category not found.');
              this.loading.set(false);
              return;
            }
            this.current.set(hit);
            this.seedForm(hit);
          }
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  private seedForm(category: Category): void {
    const asTranslatable = (v: unknown): TranslatableValue => {
      if (v && typeof v === 'object' && 'default' in (v as object)) {
        return v as TranslatableValue;
      }
      return typeof v === 'string' ? { default: v } : { default: '' };
    };
    this.form.reset(
      {
        name: asTranslatable(category.name),
        slug: category.slug,
        parentId: category.parentId ?? null,
        description: asTranslatable(category.description),
        isVisible: category.isVisible ?? true,
        imageId: category.imageId ?? null,
      },
      { emitEvent: false },
    );
    // Resolve the persisted image to a real Asset so the confirmation shows a
    // thumbnail + alt rather than the raw UUID. Best-effort: a missing/deleted
    // asset simply leaves the neutral "Image selected" label.
    if (category.imageId) {
      this.assetsService
        .get(category.imageId)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (asset) => this.selectedAsset.set(asset),
          // query-error-guard: allow — thumbnail hydration only; the field still
          // reads "Image selected" and the id is still submitted.
          error: () => this.selectedAsset.set(null),
        });
    } else {
      this.selectedAsset.set(null);
    }
  }

  async pickImage(): Promise<void> {
    const result = await openAssetPicker(this.dialog, {
      mode: 'single',
      filter: { type: 'IMAGE' },
    });
    if (result.kind === 'select-single') {
      this.form.controls.imageId.setValue(result.asset.id);
      this.form.controls.imageId.markAsDirty();
      this.form.markAsDirty();
      this.selectedAsset.set(result.asset);
    }
  }

  clearImage(): void {
    this.form.controls.imageId.setValue(null);
    this.form.controls.imageId.markAsDirty();
    this.form.markAsDirty();
    this.selectedAsset.set(null);
  }

  private hasTranslatableContent(v: TranslatableValue): boolean {
    return Object.values(v).some(
      (x) => typeof x === 'string' && x.replace(/<[^>]+>/g, '').trim().length > 0,
    );
  }

  private startAction(kind: 'save' | 'delete'): void {
    this.busy.set(true);
    this.action.set(kind);
    this.error.set(null);
    this.saved.set(false);
  }

  private finishAction(): void {
    this.busy.set(false);
    this.action.set(null);
    this.saved.set(true);
    setTimeout(() => this.saved.set(false), 3000);
  }

  private failAction(err: unknown, fallback: string): void {
    this.busy.set(false);
    this.action.set(null);
    this.error.set(this.formatError(err, fallback));
  }

  private formatError(err: unknown, fallback = 'Could not load categories.'): string {
    if (err instanceof ApiNotFoundError) return 'Category not found.';
    if (err instanceof ApiForbiddenError) return 'You do not have permission to modify categories.';
    if (err instanceof ApiConflictError && err.code === 'CATEGORY_SLUG_TAKEN') {
      return 'Slug conflict: pick a different slug.';
    }
    if (err instanceof ApiError && err.message) return err.message;
    return fallback;
  }
}

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
  openConfirmDialog,
  type TranslatableValue,
} from '@admin-ui';
import {
  PaymentMethodsService,
  type PaymentMethod,
  type PaymentProviderCatalogueEntry,
  type UpdatePaymentMethodRequest,
} from '@admin-services';
import { ApiConflictError, ApiError, ApiForbiddenError, ApiNotFoundError } from '@admin-types';
import { Subject, takeUntil } from 'rxjs';
import { AuthStore } from '../../core/stores/auth.store';
import {
  activeTone,
  displayConfigValue,
  findProvider,
  isMasked,
  isSecretKey,
  methodLabel,
  providerLabel,
} from './payments.utils';
import { StoreSettingsStore } from '../../core/stores/store-settings.store';

interface ConfigRow {
  key: string;
  value: unknown;
  isSecret: boolean;
}

type SchemaFieldKind = 'string' | 'boolean' | 'number' | 'enum';

interface SchemaField {
  key: string;
  label: string;
  kind: SchemaFieldKind;
  isSecret: boolean;
  stored: boolean;
  value: unknown;
  options: string[];
  description: string;
  inputType: string;
  display: string;
  placeholder: string | null;
}

function schemaProperties(schema: unknown): [string, Record<string, unknown>][] {
  if (!schema || typeof schema !== 'object') return [];
  const props = (schema as Record<string, unknown>)['properties'];
  if (!props || typeof props !== 'object') return [];
  return Object.entries(props as Record<string, unknown>).map(([key, prop]) => [
    key,
    prop && typeof prop === 'object' ? (prop as Record<string, unknown>) : {},
  ]);
}

/** Schema title when present, else the camelCase key spelled out ("merchantPassword" to "Merchant password"). */
function fieldLabel(key: string, prop: Record<string, unknown>): string {
  const title = prop['title'];
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fieldKind(prop: Record<string, unknown>): SchemaFieldKind {
  if (Array.isArray(prop['enum'])) return 'enum';
  if (prop['type'] === 'boolean') return 'boolean';
  if (prop['type'] === 'number' || prop['type'] === 'integer') return 'number';
  return 'string';
}

/**
 * `/payment-methods/:id` — configuration surface.
 *
 * Fields:
 *   - name (Translatable), description (Translatable)
 *   - isActive, isTestMode, sortOrder
 *   - config grid: one row per stored key. Secret keys render as
 *     masked placeholders with an "Update" input so operators can
 *     rotate a value without seeing the stored one. Submitting the
 *     masked placeholder preserves the existing secret per backend
 *     merge semantics.
 *
 * Delete path uses `openConfirmDialog` — the backend soft-deletes so
 * codes don't leak back via re-creation.
 */
@Component({
  selector: 'app-payment-method-detail-page',
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
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="p-6 md:p-10 flex flex-col gap-8" data-testid="payment-method-detail-page">
      <nav class="text-xs tracking-widest uppercase text-ink-muted" aria-label="Breadcrumb">
        <a
          routerLink="/payment-methods"
          class="hover:text-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
        >
          Payment methods
        </a>
        <span aria-hidden="true" class="mx-2">/</span>
        <span class="text-ink" aria-current="page">
          {{ current() ? label(current()!) : '…' }}
        </span>
      </nav>

      <div role="alert" aria-atomic="true" data-testid="payment-method-detail-error">
        @if (error()) {
          <p class="border border-status-error text-ink p-3 tabular text-xs">
            {{ error() }}
          </p>
        }
      </div>

      @if (loading()) {
        <div class="flex flex-col gap-4">
          <app-skeleton height="3rem" width="40%" />
          <app-skeleton height="14rem" width="100%" />
        </div>
      } @else if (current(); as m) {
        <header class="flex items-end justify-between gap-6 flex-wrap">
          <div class="min-w-0">
            <p class="text-xs tracking-widest uppercase text-ink-muted">
              {{ providerName(m.provider) }}
            </p>
            <h1 class="mt-2 text-3xl md:text-4xl font-bold tracking-tight truncate">
              {{ label(m) }}
            </h1>
            <p class="mt-3 tabular text-sm text-ink-muted">
              Code <code class="font-mono text-ink">{{ m.code }}</code>
            </p>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <app-badge
              [tone]="activeTone(m.isActive)"
              [ariaLabel]="m.isActive ? 'Active' : 'Disabled'"
            >
              {{ m.isActive ? 'Active' : 'Disabled' }}
            </app-badge>
            @if (m.isTestMode) {
              <app-badge tone="warning" [ariaLabel]="'Test mode enabled'">Test mode</app-badge>
            }
            <span aria-live="polite" class="inline-flex">
              @if (saved()) {
                <app-badge tone="success" [ariaLabel]="'Changes saved'">Saved</app-badge>
              }
            </span>
          </div>
        </header>

        <form
          [formGroup]="form"
          (ngSubmit)="save()"
          class="flex flex-col gap-5 max-w-3xl"
          novalidate
        >
          <app-form-field label="Display name" fieldId="pm-name" [required]="true">
            <app-translatable-input
              formControlName="name"
              label="Name"
              inputId="pm-name"
              idPrefix="pm-name"
              testId="pm-name"
            ></app-translatable-input>
          </app-form-field>

          <app-form-field label="Description" fieldId="pm-description">
            <app-translatable-input
              formControlName="description"
              label="Description"
              inputId="pm-description"
              idPrefix="pm-description"
              testId="pm-description"
            ></app-translatable-input>
          </app-form-field>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <app-form-field
              label="Sort order"
              fieldId="pm-sort"
              hint="Lower numbers render first at checkout."
            >
              <app-input id="pm-sort" type="number" formControlName="sortOrder"></app-input>
            </app-form-field>
            <div class="flex flex-col gap-3 pt-6">
              <label class="inline-flex items-center gap-3 text-sm min-h-[44px] cursor-pointer">
                <input
                  type="checkbox"
                  formControlName="isActive"
                  class="h-5 w-5 border border-line bg-surface"
                  data-testid="pm-active"
                />
                Offer at checkout
              </label>
              <label class="inline-flex items-center gap-3 text-sm min-h-[44px] cursor-pointer">
                <input
                  type="checkbox"
                  formControlName="isTestMode"
                  class="h-5 w-5 border border-line bg-surface"
                  data-testid="pm-test-mode"
                />
                Test mode
              </label>
            </div>
          </div>

          <section class="flex flex-col gap-4" aria-labelledby="pm-config-heading">
            <header>
              <h2 id="pm-config-heading" class="text-xs tracking-widest uppercase text-ink-muted">
                Provider config
              </h2>
              <p class="mt-1 text-xs tabular text-ink-muted">
                Known secret keys (apiKey, webhookSecret, clientSecret…) are stored encrypted and
                never returned to this screen. Leave the placeholder to keep the stored value, or
                enter a new value to rotate.
              </p>
            </header>
            @if (schemaFields().length > 0) {
              <ul class="flex flex-col gap-4" role="list" data-testid="pm-schema-fields">
                @for (field of schemaFields(); track field.key) {
                  <li class="flex flex-col gap-1">
                    @if (field.kind === 'boolean') {
                      <label
                        class="inline-flex items-center gap-3 text-sm min-h-[44px] cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          class="h-5 w-5 border border-line bg-surface"
                          [checked]="field.value === true"
                          [attr.data-testid]="'pm-field-' + field.key"
                          (change)="onBooleanInput(field.key, $event)"
                        />
                        <span
                          class="text-sm text-ink"
                          [attr.data-testid]="'pm-field-label-' + field.key"
                          >{{ field.label }}</span
                        >
                      </label>
                    } @else {
                      <label
                        class="text-sm text-ink"
                        [attr.for]="'pm-field-' + field.key"
                        [attr.data-testid]="'pm-field-label-' + field.key"
                      >
                        {{ field.label }}
                      </label>
                      @if (field.kind === 'enum') {
                        <select
                          class="w-full min-h-[44px] px-3 py-2 tabular text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                          [id]="'pm-field-' + field.key"
                          [attr.data-testid]="'pm-field-' + field.key"
                          (change)="onConfigInput(field.key, $event)"
                        >
                          @for (option of field.options; track option) {
                            <option [value]="option" [selected]="field.value === option">
                              {{ option }}
                            </option>
                          }
                        </select>
                      } @else {
                        <input
                          class="w-full min-h-[44px] px-3 py-2 tabular text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                          autocomplete="off"
                          [id]="'pm-field-' + field.key"
                          [type]="field.inputType"
                          [value]="field.display"
                          [attr.placeholder]="field.placeholder"
                          [attr.data-testid]="'pm-field-' + field.key"
                          (input)="
                            field.kind === 'number'
                              ? onNumberInput(field.key, $event)
                              : onConfigInput(field.key, $event)
                          "
                        />
                      }
                    }
                    @if (field.description) {
                      <p class="text-xs tabular text-ink-muted">{{ field.description }}</p>
                    }
                    @if (field.isSecret && field.stored) {
                      <div>
                        <app-button
                          variant="ghost"
                          size="sm"
                          type="button"
                          (clicked)="removeConfigKey(field.key)"
                          [ariaLabel]="'Remove ' + field.key"
                          [testId]="'pm-field-remove-' + field.key"
                        >
                          Remove stored value
                        </app-button>
                      </div>
                    }
                  </li>
                }
              </ul>
            }
            @if (configRows().length === 0 && schemaFields().length === 0) {
              <p class="tabular text-sm text-ink-muted">No config keys yet — use Add to set one.</p>
            } @else if (configRows().length > 0) {
              <ul class="flex flex-col gap-3" role="list" data-testid="pm-config-rows">
                @for (row of configRows(); track row.key) {
                  <li
                    class="grid grid-cols-[1fr_2fr_auto] items-center gap-3"
                    [attr.data-testid]="'pm-config-row-' + row.key"
                  >
                    <span class="font-mono text-xs text-ink">{{ row.key }}</span>
                    @if (row.isSecret) {
                      <input
                        type="password"
                        autocomplete="off"
                        class="w-full min-h-[44px] px-3 py-2 tabular text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                        [value]="displayValue(row.key, row.value)"
                        [attr.aria-label]="'Value for ' + row.key"
                        [attr.data-testid]="'pm-config-input-' + row.key"
                        (input)="onConfigInput(row.key, $event)"
                      />
                    } @else {
                      <input
                        type="text"
                        class="w-full min-h-[44px] px-3 py-2 tabular text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                        [value]="displayValue(row.key, row.value)"
                        [attr.aria-label]="'Value for ' + row.key"
                        [attr.data-testid]="'pm-config-input-' + row.key"
                        (input)="onConfigInput(row.key, $event)"
                      />
                    }
                    <app-button
                      variant="ghost"
                      size="sm"
                      type="button"
                      (clicked)="removeConfigKey(row.key)"
                      [ariaLabel]="'Remove ' + row.key"
                      [attr.data-testid]="'pm-config-remove-' + row.key"
                    >
                      Remove
                    </app-button>
                  </li>
                }
              </ul>
            }
            <div class="flex items-end gap-3 flex-wrap">
              <div class="flex-1 min-w-64">
                <label for="pm-new-key" class="block text-xs tabular text-ink-muted mb-1">
                  New key
                </label>
                <input
                  id="pm-new-key"
                  type="text"
                  class="w-full min-h-[44px] px-3 py-2 tabular text-sm bg-surface text-ink border border-line focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
                  [value]="newKey()"
                  (input)="onNewKeyInput($event)"
                  placeholder="e.g. webhookUrl"
                  aria-describedby="pm-new-key-hint"
                />
                <p id="pm-new-key-hint" class="mt-1 text-xs tabular text-ink-muted">
                  Add a provider-specific key.
                </p>
              </div>
              <app-button
                type="button"
                variant="secondary"
                size="sm"
                [disabled]="!newKey() || hasKey(newKey())"
                (clicked)="addConfigKey()"
                data-testid="pm-config-add"
              >
                Add key
              </app-button>
            </div>
          </section>

          <footer
            class="sticky bottom-0 -mx-6 md:-mx-10 px-6 md:px-10 py-4 bg-surface border-t border-line flex flex-wrap items-center justify-between gap-3"
          >
            <div class="flex items-center gap-3">
              @if (canDelete()) {
                <app-button
                  type="button"
                  variant="destructive"
                  size="sm"
                  [disabled]="busy()"
                  [loading]="busy() && action() === 'delete'"
                  (clicked)="confirmDelete()"
                  data-testid="pm-delete"
                >
                  Delete method
                </app-button>
              }
              <p class="text-xs tabular text-ink-muted">
                {{ form.dirty || configDirty() ? 'Unsaved changes' : 'No changes' }}
              </p>
            </div>
            <div class="flex items-center gap-3">
              <app-button
                type="button"
                variant="ghost"
                size="sm"
                [disabled]="busy()"
                routerLink="/payment-methods"
                data-testid="pm-cancel"
              >
                Cancel
              </app-button>
              <app-button
                type="submit"
                variant="primary"
                size="md"
                [disabled]="form.invalid || busy() || (!form.dirty && !configDirty())"
                [loading]="busy() && action() === 'save'"
                data-testid="pm-save"
              >
                Save changes
              </app-button>
            </div>
          </footer>
        </form>
      }
    </section>
  `,
})
export class PaymentMethodDetailPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly service = inject(PaymentMethodsService);
  private readonly authStore = inject(AuthStore);
  private readonly storeSettings = inject(StoreSettingsStore);
  private readonly dialog = inject(Dialog);
  private readonly fb = inject(FormBuilder);
  private readonly destroy$ = new Subject<void>();

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly current = signal<PaymentMethod | null>(null);
  readonly busy = signal(false);
  readonly action = signal<'save' | 'delete' | null>(null);
  readonly saved = signal(false);
  readonly configDirty = signal(false);

  /** Working copy of config — edited in place, diffed against the loaded blob. */
  readonly pendingConfig = signal<Record<string, unknown>>({});
  readonly newKey = signal('');

  /** Catalogue entry of the method's provider. Null until loaded or when the catalogue fails. */
  readonly providerEntry = signal<PaymentProviderCatalogueEntry | null>(null);

  readonly schemaFields = computed<SchemaField[]>(() => {
    const entry = this.providerEntry();
    const config = this.pendingConfig();
    return schemaProperties(entry?.configJsonSchema).map(([key, prop]) => {
      const raw = config[key];
      const isSecret = isSecretKey(key, entry);
      const kind = fieldKind(prop);
      const stored = raw !== undefined && raw !== null && raw !== '';
      return {
        key,
        label: fieldLabel(key, prop),
        kind,
        isSecret,
        stored,
        value: raw,
        options: Array.isArray(prop['enum']) ? prop['enum'].map(String) : [],
        description: typeof prop['description'] === 'string' ? prop['description'] : '',
        inputType: isSecret ? 'password' : kind === 'number' ? 'number' : 'text',
        // The stored secret never reaches the DOM, only a hint that one exists.
        display: isSecret || raw === undefined || raw === null ? '' : String(raw),
        placeholder: isSecret && isMasked(raw) ? 'Stored (hidden). Type to replace.' : null,
      };
    });
  });

  readonly configRows = computed<ConfigRow[]>(() => {
    const entry = this.providerEntry();
    const inSchema = new Set(schemaProperties(entry?.configJsonSchema).map(([key]) => key));
    return Object.entries(this.pendingConfig())
      .filter(([key]) => !inSchema.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value, isSecret: isSecretKey(key, entry) }));
  });

  readonly canDelete = computed(() => this.authStore.hasPermission('payment_methods:delete'));

  protected readonly label = (m: Pick<PaymentMethod, 'name' | 'code'>): string =>
    methodLabel(m, this.authStore.locale(), this.storeSettings.defaultLocale());
  protected readonly activeTone = activeTone;

  readonly form = this.fb.nonNullable.group({
    name: this.fb.nonNullable.control<TranslatableValue>({ default: '' }, [Validators.required]),
    description: this.fb.nonNullable.control<TranslatableValue>({ default: '' }),
    sortOrder: this.fb.nonNullable.control(0, [Validators.min(0)]),
    isActive: this.fb.nonNullable.control(false),
    isTestMode: this.fb.nonNullable.control(false),
  });

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((p) => {
      const id = p.get('id');
      if (id) this.fetch(id);
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  hasKey(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.pendingConfig(), key);
  }

  onNewKeyInput(event: Event): void {
    this.newKey.set((event.target as HTMLInputElement).value.trim());
  }

  addConfigKey(): void {
    const key = this.newKey();
    if (!key || this.hasKey(key)) return;
    this.pendingConfig.update((cfg) => ({ ...cfg, [key]: '' }));
    this.newKey.set('');
    this.configDirty.set(true);
  }

  removeConfigKey(key: string): void {
    this.pendingConfig.update((cfg) => {
      const next = { ...cfg };
      // null means "delete" when shipped in the PATCH body.
      next[key] = null;
      return next;
    });
    this.configDirty.set(true);
  }

  onConfigInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.pendingConfig.update((cfg) => ({ ...cfg, [key]: value }));
    this.configDirty.set(true);
  }

  onBooleanInput(key: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.pendingConfig.update((cfg) => ({ ...cfg, [key]: checked }));
    this.configDirty.set(true);
  }

  onNumberInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.pendingConfig.update((cfg) => ({ ...cfg, [key]: value === '' ? null : Number(value) }));
    this.configDirty.set(true);
  }

  providerName(provider: string): string {
    return providerLabel(provider, this.providerEntry() ? [this.providerEntry()!] : []);
  }

  displayValue(key: string, value: unknown): string {
    return displayConfigValue(key, value, this.providerEntry());
  }

  save(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.busy()) return;
    if (!this.form.dirty && !this.configDirty()) return;

    const raw = this.form.getRawValue();
    const body: UpdatePaymentMethodRequest = {};
    if (this.form.controls.name.dirty) body.name = raw.name;
    if (this.form.controls.description.dirty) body.description = raw.description;
    if (this.form.controls.sortOrder.dirty) body.sortOrder = Number(raw.sortOrder);
    if (this.form.controls.isActive.dirty) body.isActive = raw.isActive;
    if (this.form.controls.isTestMode.dirty) body.isTestMode = raw.isTestMode;
    if (this.configDirty()) {
      // The mask is a display value. Never send it back as a secret.
      body.config = Object.fromEntries(
        Object.entries(this.pendingConfig()).filter(([, value]) => !isMasked(value)),
      );
    }

    this.busy.set(true);
    this.action.set('save');
    this.error.set(null);
    this.service.update(this.current()!.id, body).subscribe({
      next: (updated) => {
        this.current.set(updated);
        this.pendingConfig.set(updated.config);
        this.configDirty.set(false);
        this.form.markAsPristine();
        this.busy.set(false);
        this.action.set(null);
        this.saved.set(true);
        setTimeout(() => this.saved.set(false), 3000);
      },
      error: (err: unknown) => this.failAction(err, 'Could not save payment method.'),
    });
  }

  async confirmDelete(): Promise<void> {
    const current = this.current();
    if (!current || this.busy()) return;
    const ok = await openConfirmDialog(this.dialog, {
      title: 'Delete this payment method?',
      body: `"${methodLabel(current, this.authStore.locale(), this.storeSettings.defaultLocale())}" will stop appearing at checkout. The record is soft-deleted so the code stays reserved.`,
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (!ok) return;

    this.busy.set(true);
    this.action.set('delete');
    this.error.set(null);
    this.service.delete(current.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.action.set(null);
        void this.router.navigate(['/payment-methods']);
      },
      error: (err: unknown) => this.failAction(err, 'Could not delete payment method.'),
    });
  }

  private fetch(id: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.service
      .get(id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (m) => {
          this.current.set(m);
          this.pendingConfig.set({ ...(m.config as Record<string, unknown>) });
          this.configDirty.set(false);
          this.seedForm(m);
          this.loading.set(false);
          this.loadCatalogue(m.provider);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(this.formatError(err));
        },
      });
  }

  private loadCatalogue(provider: string): void {
    this.service
      .providers()
      .pipe(takeUntil(this.destroy$))
      // query-error-guard: allow, a catalogue failure leaves the generic config rows in place.
      .subscribe({
        next: (entries) => this.providerEntry.set(findProvider(provider, entries) ?? null),
        error: () => this.providerEntry.set(null),
      });
  }

  private seedForm(m: PaymentMethod): void {
    const asTranslatable = (v: unknown): TranslatableValue => {
      if (v && typeof v === 'object' && 'default' in (v as object)) {
        return v as TranslatableValue;
      }
      return { default: '' };
    };
    this.form.reset(
      {
        name: asTranslatable(m.name),
        description: asTranslatable(m.description),
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        isTestMode: m.isTestMode,
      },
      { emitEvent: false },
    );
  }

  private failAction(err: unknown, fallback: string): void {
    this.busy.set(false);
    this.action.set(null);
    this.error.set(this.formatError(err, fallback));
  }

  private formatError(err: unknown, fallback = 'Could not load payment method.'): string {
    if (err instanceof ApiNotFoundError) return 'Payment method not found.';
    if (err instanceof ApiForbiddenError)
      return 'You do not have permission to modify payment methods.';
    if (err instanceof ApiConflictError) return 'Code conflict — pick a different code.';
    if (err instanceof ApiError && err.message) return err.message;
    return fallback;
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import {
  TabStripComponent,
  type TabStripItem,
} from '../../organisms/tab-strip/tab-strip.component';
import { InputComponent } from '../input/input.component';
import { TextareaComponent } from '../textarea/textarea.component';
import {
  TRANSLATABLE_LOCALES,
  type LocaleDirection,
  type TranslatableLocaleTab,
} from '../translatable-locales.token';

export interface TranslatableValue {
  default: string;
  [locale: string]: string;
}

/**
 * Multi-locale text input for `Translatable` JSONB fields.
 *
 * Emits the full `{default, fr, en, ...}` object via ControlValueAccessor —
 * editing any locale tab updates the corresponding key; the active tab's
 * value is mirrored into `default` when the active tab is the configured
 * default locale (the first entry of the effective locale list).
 *
 * The tab list comes from `TRANSLATABLE_LOCALES`, which the host app feeds
 * from the store's `supportedLocales`. Bind `locales` only to override it for
 * one field; leaving it unbound is the normal case and is what lets a locale
 * added in Settings appear on every editor at once.
 *
 * ARIA — wraps a `tablist` from `app-tab-strip`; the `<input>` / `<textarea>`
 * underneath is the `tabpanel`, wired via matching ids.
 */
@Component({
  selector: 'app-translatable-input',
  standalone: true,
  imports: [FormsModule, InputComponent, TextareaComponent, TabStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => TranslatableInputComponent),
      multi: true,
    },
  ],
  template: `
    <div class="flex flex-col gap-3" [attr.data-testid]="testId()">
      <app-tab-strip
        [tabs]="tabItems()"
        [active]="activeLocale()"
        [idPrefix]="idPrefix()"
        [ariaLabel]="'Locales for ' + (label() ?? 'this field')"
        [testId]="testId() + '-tabs'"
        (tabChanged)="selectLocale($event)"
      />

      <div
        role="tabpanel"
        [id]="panelId(activeLocale())"
        [attr.aria-labelledby]="idPrefix() + '-' + activeLocale()"
        [attr.lang]="activeLocale()"
        [attr.dir]="activeDir()"
        (focusout)="onTouched()"
      >
        @if (multiline()) {
          <app-textarea
            [id]="inputId()"
            [invalid]="invalid()"
            [rows]="rows()"
            [placeholder]="placeholder() ?? ''"
            [describedBy]="describedBy()"
            [attr.data-testid]="testId() + '-field'"
            [ariaLabel]="fieldAriaLabel()"
            [ngModel]="currentValue()"
            (ngModelChange)="onLocaleChange($event)"
            [disabled]="isDisabled()"
          ></app-textarea>
        } @else {
          <app-input
            [id]="inputId()"
            [type]="'text'"
            [invalid]="invalid()"
            [placeholder]="placeholder() ?? ''"
            [describedBy]="describedBy()"
            [attr.data-testid]="testId() + '-field'"
            [ariaLabel]="fieldAriaLabel()"
            [ngModel]="currentValue()"
            (ngModelChange)="onLocaleChange($event)"
            [disabled]="isDisabled()"
          ></app-input>
        }
      </div>
    </div>
  `,
})
export class TranslatableInputComponent implements ControlValueAccessor {
  /** Accessible label text — reused for the `aria-label` on the tablist. */
  readonly label = input<string | null>(null);
  readonly invalid = input<boolean>(false);
  readonly placeholder = input<string | null>(null);
  readonly describedBy = input<string | null>(null);
  readonly inputId = input<string>('translatable-input');
  readonly testId = input<string>('translatable-input');
  readonly idPrefix = input<string>('translatable');
  /**
   * Locale codes to expose as tabs, overriding the store's list for this one
   * field. The FIRST entry is treated as the default. Leave unbound to follow
   * the store.
   */
  readonly locales = input<readonly string[] | undefined>(undefined);
  readonly multiline = input<boolean>(false);
  readonly rows = input<number>(3);

  private readonly storeLocales = inject(TRANSLATABLE_LOCALES);

  private readonly _value = signal<TranslatableValue>({ default: '' });
  private readonly _activeOverride = signal<string | null>(null);
  protected readonly isDisabled = signal<boolean>(false);

  /**
   * The tabs actually rendered: the `locales` override, else the store.
   *
   * An override names codes only, so each one keeps the direction the store
   * configured for it. A code the store does not list is left-to-right, which
   * is the same answer an unconfigured store gives.
   */
  readonly effectiveTabs = computed<readonly TranslatableLocaleTab[]>(() => {
    const tabs = this.storeLocales();
    const override = this.locales();
    if (!override || override.length === 0) return tabs;
    return override.map((code) => tabs.find((tab) => tab.code === code) ?? { code, dir: 'ltr' });
  });

  /** The tab list actually rendered, as codes. */
  readonly effectiveLocales = computed<readonly string[]>(() =>
    this.effectiveTabs().map((tab) => tab.code),
  );

  /**
   * The selected tab, clamped to the list that is actually rendered.
   *
   * Derived rather than seeded, because a seeded default has to be corrected
   * whenever the list does not contain it, and the correction is only ever as
   * good as the cases it was written for. The previous version seeded the
   * literal `'en'`, which happened to equal the first entry of the old
   * hardcoded pair; under any list that does not start with `en` it opened on
   * the wrong tab while still mirroring the first entry into `default`.
   */
  readonly activeLocale = computed<string>(() => {
    const locales = this.effectiveLocales();
    const chosen = this._activeOverride();
    if (chosen && locales.includes(chosen)) return chosen;
    return locales[0] ?? '';
  });

  /** Writing direction of the tab on screen, so an RTL locale types RTL. */
  readonly activeDir = computed<LocaleDirection>(
    () => this.effectiveTabs().find((tab) => tab.code === this.activeLocale())?.dir ?? 'ltr',
  );

  readonly currentValue = computed(() => this._value()[this.activeLocale()] ?? '');
  readonly fieldAriaLabel = computed(() => {
    const base = this.label() ?? 'Translatable field';
    return `${base} (${this.activeLocale().toUpperCase()})`;
  });

  readonly tabItems = computed<TabStripItem[]>(() =>
    this.effectiveLocales().map((code) => ({
      value: code,
      label: code.toUpperCase(),
      badge: this.isFilled(this._value(), code) ? undefined : '·',
    })),
  );

  private onChange: (v: TranslatableValue) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  panelId(locale: string): string {
    return `${this.idPrefix()}-panel-${locale}`;
  }

  selectLocale(locale: string): void {
    this._activeOverride.set(locale);
    this.onTouched();
  }

  onLocaleChange(next: string): void {
    const locale = this.activeLocale();
    const defaultLocale = this.effectiveLocales()[0];
    const value = this._value();
    const updated: TranslatableValue = { ...value, [locale]: next };
    if (locale === defaultLocale) {
      updated.default = next;
    } else if (!updated.default) {
      // Seed `default` from whichever tab is filled first, even a non-default
      // one, because an empty `default` renders as an empty string rather than
      // falling through. `parseLocale` returns the literal 'default' for a
      // request with no Accept-Language header, and the interceptor's chain is
      // `obj[locale] ?? obj['en'] ?? obj['default']`, so a header-less caller
      // satisfies the FIRST rung from `default` and `??` does not catch `''`.
      // A wrong-language `default` at least renders something. Editing the
      // default-locale tab afterwards overwrites it through the branch above, so
      // this is a seed and not a sticky value; both halves are covered in the
      // spec. Requiring `default` in `translatableSchema` does not help here,
      // since `z.string()` accepts the empty string.
      updated.default = next;
    }
    this._value.set(updated);
    this.onChange(updated);
  }

  writeValue(value: TranslatableValue | null | undefined): void {
    if (value && typeof value === 'object') {
      this._value.set({ ...value, default: value.default ?? '' });
    } else {
      this._value.set({ default: '' });
    }
  }
  registerOnChange(fn: (value: TranslatableValue) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(isDisabled: boolean): void {
    this.isDisabled.set(isDisabled);
  }

  private isFilled(value: TranslatableValue, locale: string): boolean {
    const v = value[locale];
    return typeof v === 'string' && v.length > 0;
  }
}

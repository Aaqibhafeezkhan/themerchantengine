import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { axe, toHaveNoViolations } from 'jest-axe';
import { TRANSLATABLE_LOCALES, buildLocaleTabs } from '../translatable-locales.token';
import { TranslatableInputComponent, type TranslatableValue } from './translatable-input.component';

expect.extend(toHaveNoViolations);

/**
 * Tabs as the token now carries them: a code plus the direction the store
 * writes that locale in. Built through the production helper so a spec cannot
 * assert an ordering rule production no longer follows.
 */
function tabs(codes: readonly string[], rtlLocales: readonly string[] = []) {
  return buildLocaleTabs(codes, codes[0] ?? '', rtlLocales);
}

/** Unbound `locales`, which is how every real call site uses the atom. */
@Component({
  standalone: true,
  imports: [ReactiveFormsModule, TranslatableInputComponent],
  template: `
    <app-translatable-input [formControl]="control" label="Name" inputId="name" idPrefix="name" />
  `,
})
class Host {
  readonly control = new FormControl<TranslatableValue>(
    { default: 'Bonjour', fr: 'Bonjour', en: 'Hello' },
    { nonNullable: true },
  );
}

/** A brand-new record: every locale empty, which is where `default` seeding matters. */
@Component({
  standalone: true,
  imports: [ReactiveFormsModule, TranslatableInputComponent],
  template: `
    <app-translatable-input [formControl]="control" label="Name" inputId="name" idPrefix="name" />
  `,
})
class EmptyHost {
  readonly control = new FormControl<TranslatableValue>({ default: '' }, { nonNullable: true });
}

/** Explicit override, for a field that deliberately differs from the store. */
@Component({
  standalone: true,
  imports: [ReactiveFormsModule, TranslatableInputComponent],
  template: `
    <app-translatable-input
      [formControl]="control"
      label="Name"
      inputId="name"
      idPrefix="name"
      [locales]="['en', 'de']"
    />
  `,
})
class OverrideHost {
  readonly control = new FormControl<TranslatableValue>(
    { default: 'Hello', en: 'Hello' },
    { nonNullable: true },
  );
}

describe('TranslatableInputComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;

  async function setup(locales: readonly string[] = ['fr', 'en']) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: TRANSLATABLE_LOCALES, useValue: signal(tabs(locales)).asReadonly() }],
    });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await setup();
  });

  function typeInActive(value: string) {
    const field = fixture.nativeElement.querySelector('input, textarea') as HTMLInputElement;
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function switchLocale(code: string) {
    const tab = fixture.nativeElement.querySelector(
      `[data-testid=translatable-input-tabs-${code}]`,
    ) as HTMLButtonElement;
    tab.click();
    fixture.detectChanges();
  }

  function tabCodes(): string[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid^=translatable-input-tabs-]'),
    ).map((el) => (el as HTMLElement).dataset['testid']!.replace('translatable-input-tabs-', ''));
  }

  it('takes its tab list from the injected store locales when `locales` is unbound', () => {
    expect(tabCodes()).toEqual(['fr', 'en']);
  });

  it('opens on the first effective locale, not on a hardcoded `en`', () => {
    const field = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(field.value).toBe('Bonjour');
  });

  it('follows a store whose default locale is not the old hardcoded one', async () => {
    // Regression guard: the active tab used to be seeded with the literal 'en',
    // which only ever matched because the old hardcoded pair happened to start
    // with it. Any other list opened on the wrong tab while still mirroring the
    // first entry into `default`.
    await setup(['de', 'en']);
    expect(tabCodes()).toEqual(['de', 'en']);
    const field = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(field.value).toBe('');
  });

  it('marks the control touched when the text field loses focus', () => {
    expect(host.control.touched).toBe(false);
    const field = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    field.dispatchEvent(new Event('focusout', { bubbles: true }));
    expect(host.control.touched).toBe(true);
  });

  it('writes per-locale edits into the control value', () => {
    switchLocale('en');
    typeInActive('Hi there');
    expect(host.control.value.en).toBe('Hi there');
    // fr slot untouched
    expect(host.control.value.fr).toBe('Bonjour');
  });

  it('mirrors the default-locale edit into `default`', () => {
    typeInActive('Salut');
    expect(host.control.value.fr).toBe('Salut');
    expect(host.control.value.default).toBe('Salut');
  });

  it('does not mirror a non-default-locale edit into `default`', () => {
    switchLocale('en');
    typeInActive('Hi there');
    expect(host.control.value.default).toBe('Bonjour');
  });

  it('seeds `default` from the first tab filled, even a non-default one', async () => {
    // The phase moved the store default off `en`, so an operator can now reach a
    // non-default tab first. `default` is required by `translatableSchema` and
    // is the storefront resolver's last rung, so it must never be left empty.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TRANSLATABLE_LOCALES, useValue: signal(tabs(['fr', 'en'])).asReadonly() },
      ],
    });
    const empty = TestBed.createComponent(EmptyHost);
    empty.detectChanges();
    await Promise.resolve();
    empty.detectChanges();

    const enTab = empty.nativeElement.querySelector(
      '[data-testid=translatable-input-tabs-en]',
    ) as HTMLButtonElement;
    enTab.click();
    empty.detectChanges();
    const field = empty.nativeElement.querySelector('input') as HTMLInputElement;
    field.value = 'Hello';
    field.dispatchEvent(new Event('input'));
    empty.detectChanges();

    expect(empty.componentInstance.control.value.en).toBe('Hello');
    expect(empty.componentInstance.control.value.default).toBe('Hello');
  });

  it('lets the default-locale tab overwrite a `default` seeded by another tab', async () => {
    // The seed above is a seed, not a sticky value. Without this the store
    // default could stay stamped with the wrong language for the row's life.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TRANSLATABLE_LOCALES, useValue: signal(tabs(['fr', 'en'])).asReadonly() },
      ],
    });
    const empty = TestBed.createComponent(EmptyHost);
    empty.detectChanges();
    await Promise.resolve();
    empty.detectChanges();

    const tab = (code: string) =>
      empty.nativeElement.querySelector(
        `[data-testid=translatable-input-tabs-${code}]`,
      ) as HTMLButtonElement;
    const type = (value: string) => {
      const field = empty.nativeElement.querySelector('input') as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event('input'));
      empty.detectChanges();
    };

    tab('en').click();
    empty.detectChanges();
    type('Hello');
    expect(empty.componentInstance.control.value.default).toBe('Hello');

    tab('fr').click();
    empty.detectChanges();
    type('Bonjour');

    expect(empty.componentInstance.control.value.default).toBe('Bonjour');
    expect(empty.componentInstance.control.value.en).toBe('Hello');
  });

  it('has no axe violations', async () => {
    const results = await axe(fixture.nativeElement);
    expect(results).toHaveNoViolations();
  });
});

describe('TranslatableInputComponent when the locale list changes underneath it', () => {
  it('falls back to the new first locale when the selected tab disappears', async () => {
    // Reachable in one click: saving on the Settings locales screen refreshes
    // StoreSettingsStore, which feeds TRANSLATABLE_LOCALES, which is this list.
    // Without the clamp the component stays pointed at a tab that no longer
    // exists and renders an empty field with no way back.
    const locales = signal(tabs(['fr', 'en', 'de']));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: TRANSLATABLE_LOCALES, useValue: locales.asReadonly() }],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const component = fixture.debugElement.children[0]
      .componentInstance as TranslatableInputComponent;
    component.selectLocale('de');
    fixture.detectChanges();
    expect(component.activeLocale()).toBe('de');

    locales.set(tabs(['fr', 'en']));
    fixture.detectChanges();

    expect(component.activeLocale()).toBe('fr');
  });

  it('keeps the selected tab when it survives the change', async () => {
    const locales = signal(tabs(['fr', 'en', 'de']));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: TRANSLATABLE_LOCALES, useValue: locales.asReadonly() }],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const component = fixture.debugElement.children[0]
      .componentInstance as TranslatableInputComponent;
    component.selectLocale('en');
    fixture.detectChanges();

    locales.set(tabs(['fr', 'en']));
    fixture.detectChanges();

    expect(component.activeLocale()).toBe('en');
  });
});

describe('TranslatableInputComponent with an explicit `locales` override', () => {
  it('prefers the bound list over the injected store locales', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TRANSLATABLE_LOCALES, useValue: signal(tabs(['fr', 'en'])).asReadonly() },
      ],
    });
    const fixture = TestBed.createComponent(OverrideHost);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const codes = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid^=translatable-input-tabs-]'),
    ).map((el) => (el as HTMLElement).dataset['testid']!.replace('translatable-input-tabs-', ''));
    expect(codes).toEqual(['en', 'de']);
  });
});

/**
 * Plan E3.4.2. The panel carried `lang` but never `dir`, so an Arabic tab
 * inside a left-to-right admin typed left to right: the caret sat on the wrong
 * side, punctuation landed at the wrong end, and the stored string was correct
 * while everything about entering it was wrong. `lang` alone does not set
 * direction in any browser.
 */
describe('TranslatableInputComponent writing direction', () => {
  async function mount(codes: readonly string[], rtlLocales: readonly string[]) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: TRANSLATABLE_LOCALES,
          useValue: signal(tabs(codes, rtlLocales)).asReadonly(),
        },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    return fixture;
  }

  function panel(fixture: ComponentFixture<Host>): HTMLElement {
    return fixture.nativeElement.querySelector('[role=tabpanel]') as HTMLElement;
  }

  it('types left to right on a left-to-right tab', async () => {
    const fixture = await mount(['fr', 'ar'], ['ar']);

    expect(panel(fixture).getAttribute('dir')).toBe('ltr');
    expect(panel(fixture).getAttribute('lang')).toBe('fr');
  });

  it('types right to left once the operator switches to the RTL tab', async () => {
    const fixture = await mount(['fr', 'ar'], ['ar']);

    (
      fixture.nativeElement.querySelector(
        '[data-testid=translatable-input-tabs-ar]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(panel(fixture).getAttribute('dir')).toBe('rtl');
    expect(panel(fixture).getAttribute('lang')).toBe('ar');
  });

  it('leaves a locale the store did not mark as left-to-right', async () => {
    const fixture = await mount(['fr', 'ar'], []);

    (
      fixture.nativeElement.querySelector(
        '[data-testid=translatable-input-tabs-ar]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(panel(fixture).getAttribute('dir')).toBe('ltr');
  });
});

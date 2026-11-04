import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { axe, toHaveNoViolations } from 'jest-axe';
import { FormFieldComponent } from '../form-field/form-field.component';
import { InputComponent } from './input.component';

expect.extend(toHaveNoViolations);

@Component({
  standalone: true,
  imports: [InputComponent],
  template: `
    <label for="amount">Amount</label>
    <app-input
      id="amount"
      type="number"
      [suffix]="suffix()"
      [prefix]="prefix()"
      [step]="step()"
      [min]="min()"
    />
  `,
})
class HostComponent {
  readonly suffix = signal<string | null>(null);
  readonly prefix = signal<string | null>(null);
  readonly step = signal<string | number | null>(null);
  readonly min = signal<string | number | null>(null);
}

describe('InputComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function input(): HTMLInputElement {
    return root().querySelector('input') as HTMLInputElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  // D4 added `step` and `min` so a money field steps by the currency's own
  // scale instead of by 1. Neither had a single assertion, and eight of the
  // twelve consumer sites bound `[attr.step]` on the `<app-input>` element,
  // which writes a dead DOM attribute on a custom element and never reaches
  // the signal input. Nothing could see that, because nothing asserted the
  // attribute reaches the inner native `<input>` at all.
  describe('step and min forwarding', () => {
    it('lands step and min on the inner native input, not on the host element', () => {
      host.step.set('0.001');
      host.min.set(0);
      fixture.detectChanges();

      expect(input().getAttribute('step')).toBe('0.001');
      expect(input().getAttribute('min')).toBe('0');
    });

    it('renders no step or min attribute when neither is bound', () => {
      // An unbound value must not become a literal "null" on the element.
      expect(input().hasAttribute('step')).toBe(false);
      expect(input().hasAttribute('min')).toBe(false);
    });
  });

  // A4: money inputs used to be bare number boxes with no unit anywhere.
  describe('suffix', () => {
    it('renders no adornment and no end padding without a suffix', () => {
      expect(root().querySelector('[data-testid="input-suffix"]')).toBeNull();
      expect(input().className).not.toMatch(/\bpe-\d/);
    });

    it('renders the suffix and pads the input so text cannot run under it', () => {
      host.suffix.set('EUR');
      fixture.detectChanges();

      const adornment = root().querySelector('[data-testid="input-suffix"]');
      expect(adornment?.textContent?.trim()).toBe('EUR');
      expect(input().className).toMatch(/\bpe-\d/);
    });

    it('hides the suffix from assistive tech and from the pointer', () => {
      host.suffix.set('EUR');
      fixture.detectChanges();

      const adornment = root().querySelector('[data-testid="input-suffix"]') as HTMLElement;
      // The code is decoration: the field's label or hint carries it for screen
      // readers, so announcing it twice would be noise.
      expect(adornment.getAttribute('aria-hidden')).toBe('true');
      expect(adornment.className).toContain('pointer-events-none');
    });

    // Logical inline positioning so the adornment follows the writing direction.
    // Tailwind spells that `end-0` (inset-inline-end); `right-0` would pin it
    // to the wrong edge under RTL.
    it('positions the suffix with logical properties only', () => {
      host.suffix.set('EUR');
      fixture.detectChanges();

      const adornment = root().querySelector('[data-testid="input-suffix"]') as HTMLElement;
      expect(adornment.className).toContain('end-0');
      expect(adornment.className).toContain('pe-3');
      expect(adornment.className).not.toMatch(/\b(right|left)-\d/);
    });

    it('stays axe-clean with a suffix rendered', async () => {
      host.suffix.set('EUR');
      fixture.detectChanges();
      expect(await axe(root())).toHaveNoViolations();
    });

    it('treats an empty suffix as no suffix', () => {
      host.suffix.set('');
      fixture.detectChanges();
      expect(root().querySelector('[data-testid="input-suffix"]')).toBeNull();
    });
  });

  /**
   * Plan E3.4.3: a store that writes its currency symbol before the number had
   * nowhere to put it, so every money field in the admin suffixed the ISO code
   * whatever the store had configured.
   */
  describe('prefix', () => {
    it('renders no adornment and no start padding without a prefix', () => {
      expect(root().querySelector('[data-testid="input-prefix"]')).toBeNull();
      expect(input().className).not.toMatch(/\bps-\d/);
    });

    it('renders the prefix and pads the input so text cannot run under it', () => {
      host.prefix.set('€');
      fixture.detectChanges();

      const adornment = root().querySelector('[data-testid="input-prefix"]');
      expect(adornment?.textContent?.trim()).toBe('€');
      expect(input().className).toMatch(/\bps-\d/);
    });

    it('hides the prefix from assistive tech and from the pointer', () => {
      host.prefix.set('€');
      fixture.detectChanges();

      const adornment = root().querySelector('[data-testid="input-prefix"]') as HTMLElement;
      expect(adornment.getAttribute('aria-hidden')).toBe('true');
      expect(adornment.className).toContain('pointer-events-none');
    });

    it('positions the prefix with logical properties only', () => {
      host.prefix.set('€');
      fixture.detectChanges();

      const adornment = root().querySelector('[data-testid="input-prefix"]') as HTMLElement;
      expect(adornment.className).toContain('start-0');
      expect(adornment.className).not.toMatch(/\b(left|right)-0\b/);
    });

    it('carries both adornments at once without either padding cancelling the other', () => {
      // Not a configuration any money field uses, but the atom must not lose a
      // class when both are bound: a percentage field with a unit on each side
      // is the shape that would find it.
      host.prefix.set('€');
      host.suffix.set('EUR');
      fixture.detectChanges();

      expect(input().className).toMatch(/\bps-\d/);
      expect(input().className).toMatch(/\bpe-\d/);
    });
  });

  /**
   * The label's asterisk is `aria-hidden`, so before this the required state
   * was conveyed by sight alone on every required field in the dashboard.
   */
  describe('required state', () => {
    it('carries aria-required when the wrapping field is required', async () => {
      @Component({
        standalone: true,
        imports: [FormFieldComponent, InputComponent],
        template: `
          <app-form-field label="Amount" fieldId="amount" [required]="true">
            <app-input id="amount" type="number" />
          </app-form-field>
        `,
      })
      class RequiredHost {}

      TestBed.resetTestingModule();
      const wrapped = TestBed.createComponent(RequiredHost);
      wrapped.detectChanges();

      const field = (wrapped.nativeElement as HTMLElement).querySelector('input');
      expect(field?.getAttribute('aria-required')).toBe('true');
    });

    it('carries none when the wrapping field is not required', () => {
      @Component({
        standalone: true,
        imports: [FormFieldComponent, InputComponent],
        template: `
          <app-form-field label="Amount" fieldId="amount">
            <app-input id="amount" type="number" />
          </app-form-field>
        `,
      })
      class OptionalHost {}

      TestBed.resetTestingModule();
      const wrapped = TestBed.createComponent(OptionalHost);
      wrapped.detectChanges();

      const field = (wrapped.nativeElement as HTMLElement).querySelector('input');
      expect(field?.hasAttribute('aria-required')).toBe(false);
    });
  });

  /**
   * A `type="number"` `<app-input>` migrated onto a bulk price dialog and an
   * order's manual-discount field (plan E3.4.3, money-affix rollout) so both
   * could carry the store's currency symbol. Both bind a
   * `FormControl<number | null>`, the same shape Angular's own
   * `NumberValueAccessor` produces for a plain `<input type="number">`. This
   * atom's own `ControlValueAccessor` never did that conversion: `handleInput`
   * forwards the native `<input>`'s `.value`, which is always a string. A
   * `FormControl<number>` fed a string still type-checks (TypeScript trusts the
   * generic, not the runtime value), so nothing failed until a caller sent that
   * string on to a `zod` request schema declaring `z.number()`. `.parse()`
   * throws there, synchronously, before the HTTP call, in a submit handler that
   * had already flipped `submitting` to `true` and never in a `catch` — so the
   * dialog does not error, it hangs on "Applying..." forever and the price is
   * never sent.
   */
  describe('type="number" ControlValueAccessor', () => {
    @Component({
      standalone: true,
      imports: [ReactiveFormsModule, InputComponent],
      template: `<app-input type="number" [formControl]="amount" data-testid="amount" />`,
    })
    class NumberFormHost {
      readonly amount = new FormControl<number | null>(0, { nonNullable: false });
    }

    function typeInto(nativeInput: HTMLInputElement, value: string): void {
      nativeInput.value = value;
      nativeInput.dispatchEvent(new Event('input'));
    }

    it('writes a real number to the bound FormControl, not the raw input string', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [NumberFormHost] });
      const wrapped = TestBed.createComponent(NumberFormHost);
      wrapped.detectChanges();

      const nativeInput = (wrapped.nativeElement as HTMLElement).querySelector(
        'input',
      ) as HTMLInputElement;
      typeInto(nativeInput, '149.99');

      expect(wrapped.componentInstance.amount.value).toBe(149.99);
      expect(typeof wrapped.componentInstance.amount.value).toBe('number');
    });

    it('writes null, not an empty string, when the field is cleared', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [NumberFormHost] });
      const wrapped = TestBed.createComponent(NumberFormHost);
      wrapped.detectChanges();

      const nativeInput = (wrapped.nativeElement as HTMLElement).querySelector(
        'input',
      ) as HTMLInputElement;
      typeInto(nativeInput, '');

      expect(wrapped.componentInstance.amount.value).toBeNull();
    });

    it('still writes a plain string for a non-numeric input type', () => {
      @Component({
        standalone: true,
        imports: [ReactiveFormsModule, InputComponent],
        template: `<app-input type="text" [formControl]="name" />`,
      })
      class TextFormHost {
        readonly name = new FormControl('');
      }

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [TextFormHost] });
      const wrapped = TestBed.createComponent(TextFormHost);
      wrapped.detectChanges();

      const nativeInput = (wrapped.nativeElement as HTMLElement).querySelector(
        'input',
      ) as HTMLInputElement;
      typeInto(nativeInput, 'Demo Store');

      expect(wrapped.componentInstance.name.value).toBe('Demo Store');
    });
  });
});

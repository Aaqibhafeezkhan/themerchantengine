import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ButtonComponent, type ButtonSize, type ButtonVariant } from './button.component';
import { assertAxeClean, renderComponent, attachToBody } from './testing';

@Component({
  standalone: true,
  imports: [ButtonComponent],
  template: `<app-button>Add to cart</app-button>`,
})
class ButtonProjectionHost {}

@Component({
  standalone: true,
  imports: [ButtonComponent],
  template: `<app-button testId="pin-me">Add to cart</app-button>`,
})
class ButtonTestIdHost {}

describe('ButtonComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  const variants: ButtonVariant[] = ['primary', 'secondary', 'tertiary', 'danger'];
  const sizes: ButtonSize[] = ['sm', 'md', 'lg'];

  it.each(variants)('applies the variant-%s class', async (variant) => {
    const fixture = await renderComponent(ButtonComponent, { variant });
    const btn = fixture.nativeElement.querySelector('button');
    expect(btn?.classList.contains(`variant-${variant}`)).toBe(true);
  });

  it.each(sizes)('applies the size-%s class', async (size) => {
    const fixture = await renderComponent(ButtonComponent, { size });
    const btn = fixture.nativeElement.querySelector('button');
    expect(btn?.classList.contains(`size-${size}`)).toBe(true);
  });

  it('renders projected content', async () => {
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(ButtonProjectionHost);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Add to cart');
  });

  it('reflects loading=true with spinner + aria-busy + disabled', async () => {
    const fixture = await renderComponent(ButtonComponent, { loading: true });
    const btn = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('app-spinner')).not.toBeNull();
  });

  it('reflects disabled=true with disabled + aria-disabled', async () => {
    const fixture = await renderComponent(ButtonComponent, { disabled: true });
    const btn = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('emits clicked when enabled', async () => {
    const fixture = await renderComponent(ButtonComponent);
    const handler = vi.fn();
    fixture.componentInstance.clicked.subscribe(handler);
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not emit clicked when disabled', async () => {
    const fixture = await renderComponent(ButtonComponent, { disabled: true });
    const handler = vi.fn();
    fixture.componentInstance.clicked.subscribe(handler);
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not emit clicked when loading', async () => {
    const fixture = await renderComponent(ButtonComponent, { loading: true });
    const handler = vi.fn();
    fixture.componentInstance.clicked.subscribe(handler);
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    expect(handler).not.toHaveBeenCalled();
  });

  it('respects type="submit"', async () => {
    const fixture = await renderComponent(ButtonComponent, { type: 'submit' });
    const btn = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(btn.type).toBe('submit');
  });

  it('applies full-width class when input set', async () => {
    const fixture = await renderComponent(ButtonComponent, { fullWidth: true });
    const btn = fixture.nativeElement.querySelector('button');
    expect(btn?.classList.contains('full-width')).toBe(true);
  });

  it('passes axe-core with a labelled fixture', async () => {
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(ButtonProjectionHost);
    fixture.detectChanges();
    const wrapper = attachToBody(fixture.nativeElement);
    await assertAxeClean(wrapper);
  });

  it('gives the small primary size a hover ground distinct from its resting one', () => {
    // This size grounds on the pressed primary step at rest, which is exactly what
    // the shared primary hover resolves to. Without its own step the control
    // has no visible hover at all.
    const resting = groundOf('.variant-primary.size-sm');
    const hovered = groundOf('.variant-primary.size-sm:not(:disabled):hover');
    expect(resting).toBe('var(--brand-primary-dark)');
    expect(hovered).toBe('var(--brand-primary-pressed)');
    expect(hovered).not.toBe(resting);
  });
  /**
   * Fourteen call sites pass `testId="..."` to this component. With no such
   * input it landed as a bare `testid` attribute on the `<app-button>` host,
   * which is not what `getByTestId` or `[data-testid=...]` look for, so every
   * one of those elements was unreachable from a test. The only e2e spec that
   * relied on it (`notification-preferences.journey`) is fully gated and has
   * never run, so nothing caught it.
   */
  it('exposes testId as data-testid on the interactive button', async () => {
    const fixture = await renderComponent(ButtonTestIdHost);
    const root = fixture.nativeElement as HTMLElement;
    const pinned = root.querySelector('[data-testid="pin-me"]');
    expect(pinned).not.toBeNull();
    expect(pinned?.tagName.toLowerCase()).toBe('button');
  });

  it('emits no data-testid attribute when no testId is given', async () => {
    const fixture = await renderComponent(ButtonProjectionHost);
    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    expect(button?.hasAttribute('data-testid')).toBe(false);
  });
});
/** Compiled component CSS with the view-encapsulation attributes stripped. */
function styleSheet(): string {
  return (ButtonComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles
    .join('\n')
    .replace(/%NS%/g, '')
    .replace(/\[_ng(?:content|host)-[^\]]*\]/g, '');
}

/** Background declared by the first rule whose selector list opens with `selector`. */
function groundOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{([^{}]*)\\}`).exec(styleSheet());
  expect(rule, `no rule found for ${selector}`).not.toBeNull();
  const ground = /background-color:\s*([^;]+);/.exec(rule![1]);
  expect(ground, `no background-color declared under ${selector}`).not.toBeNull();
  return ground![1].trim();
}

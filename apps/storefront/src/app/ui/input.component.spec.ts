import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { InputComponent } from './input.component';
import { assertAxeClean, renderComponent } from './testing';

describe('InputComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders with type=text by default and a generated id linked to label', async () => {
    const fixture = await renderComponent(InputComponent, { label: 'Email' });
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const label = fixture.nativeElement.querySelector('label') as HTMLLabelElement;
    expect(input.type).toBe('text');
    expect(label.htmlFor).toBe(input.id);
    expect(label.textContent).toContain('Email');
  });

  it.each(['text', 'email', 'tel', 'password', 'number', 'search', 'url'] as const)(
    'supports type=%s',
    async (type) => {
      const fixture = await renderComponent(InputComponent, { type });
      const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
      expect(input.type).toBe(type);
    },
  );

  it('emits aria-invalid + aria-describedby pointing to the error region when error set', async () => {
    const fixture = await renderComponent(InputComponent, {
      label: 'Email',
      error: 'Email is required',
    });
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const error = fixture.nativeElement.querySelector('.error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(error?.id);
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('points aria-describedby to helper when helper set + no error', async () => {
    const fixture = await renderComponent(InputComponent, {
      label: 'Email',
      helper: 'We never share your email.',
    });
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const helper = fixture.nativeElement.querySelector('.helper');
    expect(input.getAttribute('aria-describedby')).toBe(helper?.id);
  });

  it('disables the underlying input when disabled=true', async () => {
    const fixture = await renderComponent(InputComponent, { label: 'X', disabled: true });
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('passes axe with a label', async () => {
    const fixture = await renderComponent(InputComponent, { label: 'Email' });
    await assertAxeClean(fixture.nativeElement);
  });

  it('rests on the interactive border token, per agent_docs/storefront/brand-tokens.md', () => {
    // The decorative border tokens measure under the 3:1 WCAG 1.4.11 floor
    // for the boundary of a UI component, so the control cannot take one.
    const rule = restingRule();
    expect(rule).toContain('border: 1px solid var(--brand-border-interactive)');
    expect(rule).not.toContain('var(--brand-border)');
    expect(rule).not.toContain('var(--brand-border-strong)');
  });
});

/** Declaration block of the bare `input` rule, the control's resting state. */
function restingRule(): string {
  const css = (InputComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles
    .join('\n')
    .replace(/%NS%/g, '')
    .replace(/\[_ng(?:content|host)-[^\]]*\]/g, '');
  const rule = /(?:^|[}\n])\s*input\s*\{([^{}]*)\}/.exec(css);
  expect(rule, 'no bare input rule found').not.toBeNull();
  return rule![1];
}

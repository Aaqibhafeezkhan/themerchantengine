import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { SelectComponent, type SelectOption } from './select.component';
import { assertAxeClean, renderComponent } from './testing';

const options: SelectOption[] = [
  { value: 'ae', label: 'United Arab Emirates' },
  { value: 'sa', label: 'Saudi Arabia' },
  { value: 'ae', label: 'UAE', disabled: true },
];

describe('SelectComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders all options + label association', async () => {
    const fixture = await renderComponent(SelectComponent, { options, label: 'Country' });
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    const label = fixture.nativeElement.querySelector('label') as HTMLLabelElement;
    expect(label.htmlFor).toBe(select.id);
    expect(select.querySelectorAll('option').length).toBe(3);
  });

  it('renders placeholder option when provided', async () => {
    const fixture = await renderComponent(SelectComponent, {
      options,
      label: 'Country',
      placeholder: 'Choose…',
    });
    const opts = fixture.nativeElement.querySelectorAll('option');
    expect(opts[0]?.textContent?.trim()).toBe('Choose…');
    expect(opts.length).toBe(4);
  });

  it('renders chevron with aria-hidden', async () => {
    const fixture = await renderComponent(SelectComponent, { options, label: 'X' });
    const chevron = fixture.nativeElement.querySelector('.chevron');
    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes aria-invalid + role=alert error region when error set', async () => {
    const fixture = await renderComponent(SelectComponent, {
      options,
      label: 'X',
      error: 'pick one',
    });
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.nativeElement.querySelector('.error')?.getAttribute('role')).toBe('alert');
  });

  it('passes axe', async () => {
    const fixture = await renderComponent(SelectComponent, { options, label: 'Country' });
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

/** Declaration block of the bare `select` rule, the control's resting state. */
function restingRule(): string {
  const css = (SelectComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles
    .join('\n')
    .replace(/%NS%/g, '')
    .replace(/\[_ng(?:content|host)-[^\]]*\]/g, '');
  const rule = /(?:^|[}\n])\s*select\s*\{([^{}]*)\}/.exec(css);
  expect(rule, 'no bare select rule found').not.toBeNull();
  return rule![1];
}

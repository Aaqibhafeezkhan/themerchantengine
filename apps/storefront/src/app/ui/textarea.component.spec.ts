import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { TextareaComponent } from './textarea.component';
import { assertAxeClean, renderComponent } from './testing';

describe('TextareaComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.resetTestingModule());

  it('renders with default rows=4', async () => {
    const fixture = await renderComponent(TextareaComponent, { label: 'Notes' });
    const ta = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.rows).toBe(4);
  });

  it('respects rows input', async () => {
    const fixture = await renderComponent(TextareaComponent, { label: 'Notes', rows: 8 });
    const ta = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.rows).toBe(8);
  });

  it('emits aria-invalid + role=alert when error set', async () => {
    const fixture = await renderComponent(TextareaComponent, {
      label: 'Notes',
      error: 'Required',
    });
    const ta = fixture.nativeElement.querySelector('textarea');
    expect(ta?.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.nativeElement.querySelector('.error')?.getAttribute('role')).toBe('alert');
  });

  it('passes axe with label', async () => {
    const fixture = await renderComponent(TextareaComponent, { label: 'Notes' });
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

/** Declaration block of the bare `textarea` rule, the control's resting state. */
function restingRule(): string {
  const css = (TextareaComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles
    .join('\n')
    .replace(/%NS%/g, '')
    .replace(/\[_ng(?:content|host)-[^\]]*\]/g, '');
  const rule = /(?:^|[}\n])\s*textarea\s*\{([^{}]*)\}/.exec(css);
  expect(rule, 'no bare textarea rule found').not.toBeNull();
  return rule![1];
}
